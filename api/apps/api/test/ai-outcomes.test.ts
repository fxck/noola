import pg from "pg";
import { withTenant } from "@repo/db";
import { parseDraftOutcome } from "../src/ai-outcome.js";
import { ingestInbound } from "../src/ingest.js";
import { evaluateAutoreply, getPolicy, putPolicy, sendQueued } from "../src/autoreply.js";
import { getModelConfig, putModelConfig } from "../src/modelconfig.js";

// A hosted model's draft may hold a note for the team or say that no reply is needed.
// The model sits behind a stubbed endpoint. AIOUT-prefixed data on the shared dev DB, removed at the end.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const ENDPOINT = "https://llm.aiout.invalid/v1";

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

function parserChecks() {
  const ok = (t: string) => parseDraftOutcome(t);
  const reply = ok("Restart the agent and it will reconnect.");
  check("plain text is a reply", reply.kind === "ok" && reply.reply === "Restart the agent and it will reconnect." && !reply.note && !reply.noReply, reply);
  const both = ok("Try version 2.1.\n\n<internal>Customer hits the 2.0 upgrade bug.</internal>");
  check("a reply with a note splits", both.kind === "ok" && both.reply === "Try version 2.1." && both.note === "Customer hits the 2.0 upgrade bug.", both);
  const noteOnly = ok("<internal>I couldn't find this in the docs.</internal>");
  check("a note alone has no reply", noteOnly.kind === "ok" && noteOnly.reply === "" && !noteOnly.noReply && noteOnly.note === "I couldn't find this in the docs.", noteOnly);
  const none = ok("<no_reply/>");
  check("no_reply alone", none.kind === "ok" && none.noReply && none.reply === "" && none.note === null, none);
  const noneNote = ok("<no_reply />\n<internal>They confirmed the fix.</internal>");
  check("no_reply with a note", noneNote.kind === "ok" && noneNote.noReply && noneNote.note === "They confirmed the fix.", noneNote);
  for (const [name, text] of [
    ["two notes", "Hi.<internal>a</internal><internal>b</internal>"],
    ["an empty note", "Hi.<internal> </internal>"],
    ["an unclosed note", "Hi.<internal>secret"],
    ["a stray closing tag", "Hi.</internal>"],
    ["a nested tag", "<internal>a <internal>b</internal></internal>"],
    ["no_reply inside a note", "<internal>skip <no_reply/></internal>"],
    ["no_reply with a reply", "<no_reply/> Glad it works!"],
    ["two no_reply tags", "<no_reply/><no_reply/>"],
    ["a closing no_reply tag", "<no_reply></no_reply>"],
    ["an empty draft", "   "],
    ["a reply without words", "<internal>x</internal>."],
  ]) check(`malformed: ${name}`, ok(text).kind === "malformed", ok(text));
}

async function main() {
  parserChecks();

  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const t = "SELECT id FROM tickets WHERE external_channel_id LIKE 'aiout-%'";
  const clean = async () => {
    await superPool.query(`DELETE FROM autoreply_queue WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM autoreply_decisions WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM answer_claims WHERE message_id IN (SELECT id FROM messages WHERE ticket_id IN (${t}))`);
    await superPool.query(`DELETE FROM ticket_notes WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM tickets WHERE external_channel_id LIKE 'aiout-%'`);
    await superPool.query(`DELETE FROM contacts WHERE tenant_id = $1 AND external_id LIKE 'aiout-%'`, [A]);
  };
  if ((await getModelConfig(A)).provider !== "managed") throw new Error("TestCo has a hosted model, which this test would overwrite");
  await clean();
  const policyBefore = await getPolicy(A);

  let draft = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith(ENDPOINT)) return realFetch(url, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: draft } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await putModelConfig(A, { provider: "custom", endpoint: ENDPOINT, model: "aiout-model", apiKey: "k" });
    await putPolicy(A, { mode: "auto", channel_modes: { synthetic: "auto" } }, { sweep: false });

    let n = 0;
    const turn = async (modelDraft: string) => {
      draft = modelDraft;
      n++;
      const m = await ingestInbound({
        tenantId: A, body: `AIOUT I restarted the service as you suggested ${n}`, authorType: "customer", channelType: "synthetic",
        externalChannelId: `aiout-${n}`, identity: { externalId: `aiout-cust-${n}` }, idempotencyKey: `aiout:${n}`, skipAutoreply: true,
      });
      await superPool.query("UPDATE tickets SET whose_turn = 'us', assistant_enabled = true WHERE id = $1", [m.ticketId]);
      const res = await evaluateAutoreply(A, m.ticketId, m.messageId);
      const ticket = (await superPool.query("SELECT whose_turn, status FROM tickets WHERE id = $1", [m.ticketId])).rows[0];
      const notes = (await withTenant(A, (c) => c.query<{ body: string; author_name: string }>("SELECT body, author_name FROM ticket_notes WHERE ticket_id = $1", [m.ticketId]))).rows;
      const replies = (await superPool.query("SELECT body FROM messages WHERE ticket_id = $1 AND author_type = 'agent'", [m.ticketId])).rows;
      const queued = (await superPool.query("SELECT draft_body, reason FROM autoreply_queue WHERE ticket_id = $1", [m.ticketId])).rows;
      return { m, res, ticket, notes, replies, queued };
    };

    const quiet = await turn("<no_reply/>\n<internal>They confirmed the restart fixed it.</internal>");
    check("no reply needed: nothing is sent", quiet.res?.reason === "no_reply_needed" && quiet.replies.length === 0, quiet.res);
    check("no reply needed: the customer has the turn and the ticket stays open", quiet.ticket.whose_turn === "customer" && quiet.ticket.status === "open", quiet.ticket);
    check("no reply needed: the note is posted as the AI", quiet.notes.length === 1 && quiet.notes[0].author_name === "AI assistant" && quiet.notes[0].body === "They confirmed the restart fixed it.", quiet.notes);
    await evaluateAutoreply(A, quiet.m.ticketId, quiet.m.messageId);
    const again = await withTenant(A, (c) => c.query("SELECT 1 FROM ticket_notes WHERE ticket_id = $1", [quiet.m.ticketId]));
    check("evaluating the same message again posts no second note", again.rowCount === 1);

    const noted = await turn("<internal>The docs don't cover this. Someone from the team should answer.</internal>");
    check("a note alone: nothing is sent and the turn stays with us", noted.res?.reason === "note_only" && noted.replies.length === 0 && noted.ticket.whose_turn === "us", noted);
    check("a note alone: the note is posted", noted.notes.length === 1);

    const broken = await turn("Sure, here you go <internal>secret plan");
    check("a malformed draft is held for review", broken.res?.reason === "malformed_output" && broken.replies.length === 0, broken.res);
    check("a malformed draft waits in the queue as written", broken.queued[0]?.reason === "malformed_output" && broken.queued[0]?.draft_body === "Sure, here you go <internal>secret plan", broken.queued);
    check("a malformed draft posts no note", broken.notes.length === 0);
    const queueId = (await superPool.query("SELECT id FROM autoreply_queue WHERE ticket_id = $1", [broken.m.ticketId])).rows[0].id as string;
    const unedited = await sendQueued(A, queueId);
    const stillTagged = await sendQueued(A, queueId, "Sure, here you go <internal>secret plan</internal>");
    check("a malformed draft can't be sent unedited or with a tag left in", !unedited.ok && unedited.code === 422 && !stillTagged.ok && stillTagged.code === 422);
    const edited = await sendQueued(A, queueId, "Sure, here you go.");
    check("a malformed draft goes out once it is edited", edited.ok);

    const answered = await turn("Version 2.1 fixes this.\n<internal>Known upgrade bug.</internal>");
    const outgoing = [...answered.replies.map((r) => r.body), ...answered.queued.map((q) => q.draft_body)];
    check("a reply with a note: the note is posted", answered.notes.length === 1 && answered.notes[0].body === "Known upgrade bug.", answered.notes);
    check("a reply with a note: the customer's text has no note in it", outgoing.length === 1 && outgoing[0] === "Version 2.1 fixes this.", outgoing);

    await putPolicy(A, { mode: "suggest_only", channel_modes: { synthetic: "suggest_only" } }, { sweep: false });
    const suggested = await turn("<no_reply/>");
    check("suggest only: no reply is a suggestion and the turn stays with us", suggested.res?.reason === "no_reply_suggested" && suggested.ticket.whose_turn === "us", suggested);
  } finally {
    globalThis.fetch = realFetch;
    await putModelConfig(A, { provider: "managed" });
    await putPolicy(A, policyBefore, { sweep: false });
    await clean();
    await superPool.end();
  }
  console.log(failures ? `\n${failures} FAILURES` : "\nAI-OUTCOMES: all checks green");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
