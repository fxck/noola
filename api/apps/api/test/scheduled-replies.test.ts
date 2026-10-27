import pg from "pg";
import { withTenant } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { createAttachment, pendingAttachments } from "../src/attachments.js";
import {
  cancelScheduledReply, drainScheduledReplies, getSendDelay, listOpenScheduledReplies, setScheduledSourceForTests,
  scheduleReply, sendScheduledReplyNow, setSendDelay,
} from "../src/scheduled-replies.js";

// Delayed sending: a reply waits, can be cancelled or sent at once, and becomes a message only when sent.
// SCHTEST-prefixed data on the shared dev DB, removed at the end.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const log = { warn: () => {} };
const author = { userId: null, name: "Sched Tester", email: null };

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const t = "SELECT id FROM tickets WHERE external_channel_id LIKE 'schtest-%'";
  const clean = async () => {
    await superPool.query(`DELETE FROM scheduled_replies WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM ticket_notes WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM message_attachments WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM tickets WHERE external_channel_id LIKE 'schtest-%'`);
    await superPool.query(`DELETE FROM contacts WHERE tenant_id = $1 AND external_id LIKE 'schtest-%'`, [A]);
  };
  await clean();
  const delayBefore = await getSendDelay(A);
  try {

    const opened = await ingestInbound({
      tenantId: A, body: "SCHTEST question", authorType: "customer", channelType: "synthetic",
      externalChannelId: "schtest-chan", identity: { externalId: "schtest-cust" }, idempotencyKey: "schtest:q1", skipAutoreply: true,
    });
    const ticketId = opened.ticketId;
    const agentMessages = async () =>
      (await withTenant(A, (c) => c.query<{ body: string }>("SELECT body FROM messages WHERE ticket_id = $1 AND author_type = 'agent' ORDER BY created_at", [ticketId]))).rows.map((r) => r.body);

    check("the send delay is clamped to 10 minutes", (await setSendDelay(A, 9999)) === 600);
    await setSendDelay(A, 30);
    check("the send delay is saved", (await getSendDelay(A)) === 30);

    // A scheduled reply is not a message yet, and the assistant is muted at once.
    const first = await scheduleReply(A, { ticketId, body: "SCHTEST first", author, clientMessageId: "schtest-c1" }, 30);
    const again = await scheduleReply(A, { ticketId, body: "SCHTEST first", author, clientMessageId: "schtest-c1" }, 30);
    check("a double submit schedules one reply", again.id === first.id && (await listOpenScheduledReplies(A, ticketId)).length === 1);
    check("a scheduled reply is not a message yet", (await agentMessages()).length === 0);
    const muted = await withTenant(A, (c) => c.query("SELECT assistant_enabled FROM tickets WHERE id = $1", [ticketId]));
    check("scheduling mutes the assistant", muted.rows[0].assistant_enabled === false);

    // Cancelling leaves no message and gives the text back.
    const cancelled = await cancelScheduledReply(A, first.id);
    check("cancelling returns the text", cancelled?.body === "SCHTEST first");
    check("a cancelled reply leaves no message", (await agentMessages()).length === 0 && (await listOpenScheduledReplies(A, ticketId)).length === 0);
    check("a cancelled reply can't be cancelled again", (await cancelScheduledReply(A, first.id)) === null);

    // Send now skips the wait, once.
    const second = await scheduleReply(A, { ticketId, body: "SCHTEST second", author }, 600);
    const now = await sendScheduledReplyNow(A, second.id, log);
    check("send now records the reply at once", !!now?.messageId && (await agentMessages()).includes("SCHTEST second"), await agentMessages());
    check("a sent reply can't be sent or cancelled again", (await sendScheduledReplyNow(A, second.id, log)) === null && (await cancelScheduledReply(A, second.id)) === null);

    // The worker sends a reply whose delay is over, and only that one.
    const due = await scheduleReply(A, { ticketId, body: "SCHTEST due", author }, 0);
    const waiting = await scheduleReply(A, { ticketId, body: "SCHTEST waiting", author }, 600);
    await drainScheduledReplies(log);
    const bodies = await agentMessages();
    check("the worker sends a due reply", bodies.includes("SCHTEST due"), bodies);
    check("the worker leaves a waiting reply", !bodies.includes("SCHTEST waiting"));
    const dueRow = await superPool.query("SELECT status, message_id FROM scheduled_replies WHERE id = $1", [due.id]);
    check("a sent row points at its message", dueRow.rows[0].status === "sent" && !!dueRow.rows[0].message_id, dueRow.rows[0]);
    await cancelScheduledReply(A, waiting.id);

    // A failing send is retried with backoff and fails for good after the last attempt.
    const released: string[] = [];
    setScheduledSourceForTests("discord_promote", {
      deliver: async () => { throw new Error("SCHTEST down"); },
      release: async (row) => { released.push(row.id); },
    });
    const flaky = await scheduleReply(A, { ticketId, body: "SCHTEST flaky", author, source: "discord_promote", discordMessageId: "schtest-dm-1" }, 0);
    await drainScheduledReplies(log);
    const retried = await superPool.query("SELECT status, attempts, send_at > now() AS later FROM scheduled_replies WHERE id = $1", [flaky.id]);
    check("a failed send is retried later", retried.rows[0].status === "scheduled" && retried.rows[0].attempts === 1 && retried.rows[0].later === true, retried.rows[0]);
    await superPool.query("UPDATE scheduled_replies SET attempts = 4, send_at = now() WHERE id = $1", [flaky.id]);
    await drainScheduledReplies(log);
    const gaveUp = await superPool.query("SELECT status FROM scheduled_replies WHERE id = $1", [flaky.id]);
    check("the last attempt marks it failed", gaveUp.rows[0].status === "failed", gaveUp.rows[0]);
    const failedNote = await withTenant(A, (c) => c.query("SELECT body FROM ticket_notes WHERE ticket_id = $1 AND body LIKE '%SCHTEST flaky'", [ticketId]));
    check("a reply that failed for good leaves a note with its text", failedNote.rowCount === 1, failedNote.rows);
    check("a reply that failed for good releases what its source holds", released.join() === flaky.id, released);

    // A send that outlives its claim doesn't overwrite the claim that replaced it.
    setScheduledSourceForTests("discord_promote", {
      deliver: async (row) => {
        await superPool.query("UPDATE scheduled_replies SET attempts = attempts + 1 WHERE id = $1", [row.id]);
        return { messageId: null };
      },
    });
    const slow = await scheduleReply(A, { ticketId, body: "SCHTEST slow", author, source: "discord_promote", discordMessageId: "schtest-dm-2" }, 600);
    await sendScheduledReplyNow(A, slow.id, log);
    const fenced = await superPool.query("SELECT status FROM scheduled_replies WHERE id = $1", [slow.id]);
    check("a late outcome doesn't overwrite a newer claim", fenced.rows[0].status === "sending", fenced.rows[0]);
    await superPool.query("UPDATE scheduled_replies SET status = 'sent' WHERE id = $1", [slow.id]);

    // A stuck row whose message is recorded counts as sent, and one without a message goes back to waiting.
    const stuckSent = await scheduleReply(A, { ticketId, body: "SCHTEST stuck sent", author }, 600);
    const stuckLost = await scheduleReply(A, { ticketId, body: "SCHTEST stuck lost", author }, 600);
    await ingestInbound({ tenantId: A, ticketId, body: "SCHTEST stuck sent", authorType: "agent", idempotencyKey: `scheduled:${stuckSent.id}` });
    await superPool.query(
      "UPDATE scheduled_replies SET status = 'sending', send_at = now() + interval '1 hour', updated_at = now() - interval '1 hour' WHERE id = ANY($1)",
      [[stuckSent.id, stuckLost.id]],
    );
    await drainScheduledReplies(log);
    const stuck = await superPool.query("SELECT id, status, message_id FROM scheduled_replies WHERE id = ANY($1)", [[stuckSent.id, stuckLost.id]]);
    const stuckStatus = (id: string) => stuck.rows.find((r) => r.id === id)?.status;
    check("a stuck row with a recorded message is marked sent", stuckStatus(stuckSent.id) === "sent", stuck.rows);
    check("a stuck row without a message waits again", stuckStatus(stuckLost.id) === "scheduled", stuck.rows);
    check("a stuck row marked sent links its message", !!stuck.rows.find((r) => r.id === stuckSent.id)?.message_id, stuck.rows);
    await cancelScheduledReply(A, stuckLost.id);

    // A reply that is never sent switches the assistant back on, unless something else keeps it off.
    const assistantOn = async () => (await superPool.query("SELECT assistant_enabled FROM tickets WHERE id = $1", [ticketId])).rows[0].assistant_enabled as boolean;
    const enable = () => superPool.query("UPDATE tickets SET assistant_enabled = true WHERE id = $1", [ticketId]);
    await enable();
    const lone = await scheduleReply(A, { ticketId, body: "SCHTEST lone", author }, 600);
    await cancelScheduledReply(A, lone.id);
    check("cancelling the reply that muted the assistant switches it back on", await assistantOn());
    const firstOfTwo = await scheduleReply(A, { ticketId, body: "SCHTEST first of two", author }, 600);
    const secondOfTwo = await scheduleReply(A, { ticketId, body: "SCHTEST second of two", author }, 600);
    await cancelScheduledReply(A, firstOfTwo.id);
    check("another waiting reply keeps the assistant off", !(await assistantOn()));
    await cancelScheduledReply(A, secondOfTwo.id);
    check("cancelling the last of two waiting replies switches the assistant back on", await assistantOn());
    const beforeReply = await scheduleReply(A, { ticketId, body: "SCHTEST before reply", author }, 600);
    await ingestInbound({ tenantId: A, ticketId, body: "SCHTEST replied between", authorType: "agent", idempotencyKey: "schtest:between" });
    const afterReply = await scheduleReply(A, { ticketId, body: "SCHTEST after reply", author }, 600);
    await cancelScheduledReply(A, beforeReply.id);
    await cancelScheduledReply(A, afterReply.id);
    check("a reply an agent sent while the first one waited keeps the assistant off", !(await assistantOn()));
    await enable();
    const overtaken = await scheduleReply(A, { ticketId, body: "SCHTEST overtaken", author }, 600);
    await ingestInbound({ tenantId: A, ticketId, body: "SCHTEST sent meanwhile", authorType: "agent", idempotencyKey: "schtest:meanwhile" });
    await cancelScheduledReply(A, overtaken.id);
    check("a reply an agent sent meanwhile keeps the assistant off", !(await assistantOn()));
    await enable();
    setScheduledSourceForTests("discord_promote", { deliver: async () => { throw new Error("SCHTEST down"); } });
    const doomed = await scheduleReply(A, { ticketId, body: "SCHTEST doomed", author, source: "discord_promote", discordMessageId: "schtest-dm-3" }, 0);
    await superPool.query("UPDATE scheduled_replies SET attempts = 4 WHERE id = $1", [doomed.id]);
    await drainScheduledReplies(log);
    check("a reply that failed for good switches the assistant back on", await assistantOn());
    setScheduledSourceForTests("discord_promote", null);

    // A cancelled reply's files are still waiting, so the composer can attach them again.
    const file = await createAttachment(A, { ticketId, uploadedBy: null, filename: "schtest.txt", contentType: "text/plain", sizeBytes: 3, storageKey: "schtest/none" });
    const withFile = await scheduleReply(A, { ticketId, body: "SCHTEST with file", author, request: { attachmentIds: [file.id], cc: ["cc@example.invalid"] } }, 600);
    const cancelledWithFile = await cancelScheduledReply(A, withFile.id);
    const files = await pendingAttachments(A, ticketId, cancelledWithFile?.request.attachmentIds ?? []);
    check("a cancelled reply keeps its files and Cc", files.length === 1 && files[0].id === file.id && cancelledWithFile?.request.cc?.[0] === "cc@example.invalid", files);
  } finally {
    // A failing run must not leave TestCo holding every reply back.
    await setSendDelay(A, delayBefore);
  }
  await clean();
  await superPool.end();
  console.log(failures ? `\n${failures} FAILURES` : "\nSCHEDULED-REPLIES: all checks green");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
