import fs from "node:fs";
import Fastify from "fastify";
import pg from "pg";

// The AI spam check on new emails, the repeat-sender block, the widget ban and unread counts per lane.
// The model answers from a stubbed endpoint, and SPAMTEST data, TestCo's model config and spam settings are removed at the end.

process.env.MODEL_KEY_SECRET = process.env.MODEL_KEY_SECRET || "test-model-key-secret-🔑";

const { parseSpamVerdict, spamCheckPrompt, putSpamSettings, getSpamSettings, DEFAULT_SPAM_PROMPT, SPAM_REPLY_FORMAT } = await import("../src/spam-check.js");
const { listTraces, listTicketTraces } = await import("../src/trace.js");
const { blockSender, isSenderBlocked } = await import("../src/blocklist.js");
const { markConversationSpam, unmarkConversationSpam } = await import("../src/spam.js");
const { handleInboundEmail } = await import("../src/email.js");
const { getModelConfig, putModelConfig } = await import("../src/modelconfig.js");
const { listTickets, viewFilter } = await import("../src/tickets.js");
const { unreadCounts, markTicketRead } = await import("../src/reads.js");
const { createWidgetKey, deleteWidgetKey, setIdentitySecret, updateWidgetKey, computeUserHash } = await import("../src/widget.js");
const widgetRoutes = (await import("../src/routes/widget.js")).default;
const { createWebhook, deleteWebhook } = await import("../src/webhooks.js");

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const ENDPOINT = "https://llm.spamtest.invalid/v1";
const RUN = Date.now().toString(36);
const addr = (name: string) => `${name}-${RUN}@spamtest.example`;

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
  superPool.on("error", () => {});
  if ((await getModelConfig(A)).provider !== "managed") throw new Error("TestCo has a hosted model, which this test would overwrite");

  // The subject names the verdict that the stub gives: VERDICT:spam, VERDICT:outreach, VERDICT:legit or VERDICT:fail.
  const checks: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith(ENDPOINT)) return realFetch(url, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: string; messages?: Array<{ content: unknown }> };
    const user = JSON.stringify(body.messages ?? []);
    let text = "OK";
    if (body.system?.endsWith(SPAM_REPLY_FORMAT)) {
      checks.push(body.system + "\n" + user);
      const verdict = user.match(/VERDICT:(\w+)/)?.[1] ?? "legit";
      if (verdict === "fail") return new Response("{}", { status: 500 });
      text = `Here you go: {"kind": "${verdict}", "reason": "stub says ${verdict}"}`;
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  let n = 0;
  const email = (from: string, verdict: string) =>
    handleInboundEmail(
      { messageId: `<spamtest-${RUN}-${++n}@spamtest.example>`, to: "support@testco.example", from, fromName: "Spam Tester", subject: `SPAMTEST ${n} VERDICT:${verdict}`, body: `SPAMTEST body ${n}` },
      { tenantId: A },
    );
  const ticket = async (id: string) =>
    (await superPool.query("SELECT spam_at, spam_source, spam_kind, spam_reason, status FROM tickets WHERE id = $1", [id])).rows[0] as
      { spam_at: Date | null; spam_source: string | null; spam_kind: string | null; spam_reason: string | null; status: string };
  const inView = async (view: "all" | "spam", id: string) => (await listTickets(A, view)).some((t) => (t as { id: string }).id === id);
  const close = (id: string) => superPool.query("UPDATE tickets SET status = 'closed' WHERE id = $1", [id]);

  const key = await createWidgetKey(A, { label: "SPAMTEST" });
  const app = Fastify();
  await app.register(widgetRoutes);
  const ask = (body: Record<string, unknown>, url = "/public/ask") =>
    app.inject({ method: "POST", url, payload: { key: key.publicKey, ...body } }).then((r) => ({ status: r.statusCode, body: r.json() as Record<string, unknown> }));

  try {
    // ---- The verdict parser and the prompt ----
    check("a verdict is read from an answer with text around it", parseSpamVerdict('Sure. {"kind": "spam", "reason": "SEO pitch"} Done.')?.kind === "spam");
    check("an unknown kind is no verdict", parseSpamVerdict('{"kind": "maybe", "reason": "x"}') === null);
    check("an answer without JSON is no verdict", parseSpamVerdict("legit") === null);
    const p = spamCheckPrompt({ company: "Acme", product: "Acme sells rockets.", rules: "Hackathons are legit.", fromName: "", fromAddress: "a@b.example", subject: "", body: "x".repeat(9000) });
    check("the prompt carries the company, the product and the workspace rules",
      p.system.includes("support inbox of Acme") && p.system.includes("About the product: Acme sells rockets.") && p.system.includes("Hackathons are legit."));
    check("the answer format closes the prompt", p.system.endsWith(SPAM_REPLY_FORMAT));
    const own = spamCheckPrompt({ company: "Acme", prompt: "Judge mail for {company}.\n{product}", fromName: "", fromAddress: "a@b.example", subject: "", body: "x" });
    check("a workspace prompt replaces the built-in one, drops an empty product line and keeps the answer format",
      own.system === `Judge mail for Acme.\n\n${SPAM_REPLY_FORMAT}`, own.system);
    const odd = spamCheckPrompt({ company: "A$&{product}", product: "costs $$5", prompt: "{company}\n{product}", fromName: "", fromAddress: "a@b.example", subject: "", body: "x" });
    check("the company and product text go in as they are", odd.system.startsWith("A$&{product}\nAbout the product: costs $$5\n"), odd.system);
    check("the prompt cuts a long body", p.user.length < 4200, p.user.length);

    // ---- Off by default ----
    const before = checks.length;
    await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "spam-model", apiKey: "k" });
    const off = await email(addr("off"), "spam");
    check("with the check off, an email isn't checked and stays in the inbox", checks.length === before && !!off && (await ticket(off.ticketId)).spam_at === null);

    await putSpamSettings(A, { aiEnabled: true, rules: "SPAMTEST rule", blockAfter: 2 });
    await putSpamSettings(A, { prompt: `  ${DEFAULT_SPAM_PROMPT}  ` });
    const saved = await getSpamSettings(A);
    check("saving one field keeps the others, and the default prompt is stored as none", saved.aiEnabled && saved.rules === "SPAMTEST rule" && saved.blockAfter === 2 && saved.prompt === null, saved);

    // ---- Spam ----
    const s1 = await email(addr("spammer"), "spam");
    const t1 = s1 && (await ticket(s1.ticketId));
    check("a spam email creates a hidden ticket marked by the AI", !!t1 && t1.spam_at !== null && t1.spam_source === "ai" && t1.spam_kind === "spam" && t1.spam_reason === "stub says spam", t1);
    check("the ingest result says the ticket is spam", s1?.spam === true && s1?.ticketCreated === true);
    check("the hidden ticket is in the Spam view only", !!s1 && (await inView("spam", s1.ticketId)) && !(await inView("all", s1.ticketId)));
    check("the check sends the workspace rules", checks[checks.length - 1]?.includes("SPAMTEST rule"));
    const lead = await superPool.query("SELECT spam_at FROM contacts WHERE tenant_id = $1 AND email = $2", [A, addr("spammer")]);
    check("the lead that the email created is hidden too", lead.rows[0]?.spam_at !== null && lead.rows.length === 1);
    check("one spam conversation doesn't block the sender", !(await isSenderBlocked(A, "email", addr("spammer"))));

    // ---- A wrongly hidden sender's next legit email shows their contact again ----
    const b1 = await email(addr("bob"), "spam");
    const bobHidden = (await superPool.query("SELECT spam_at FROM contacts WHERE tenant_id = $1 AND email = $2", [A, addr("bob")])).rows[0]?.spam_at;
    const b2 = await email(addr("bob"), "legit");
    const bobNow = (await superPool.query("SELECT spam_at FROM contacts WHERE tenant_id = $1 AND email = $2", [A, addr("bob")])).rows[0]?.spam_at;
    check("a legit email after a hidden one shows the contact again", !!b1 && !!b2 && b2.spam === false && bobHidden !== null && bobNow === null, { bobHidden, bobNow });

    // ---- The second spam email opens its own conversation and blocks the sender ----
    const asked = checks.length;
    const s2 = await email(addr("spammer"), "spam");
    check("a hidden ticket takes no follow-ups, so the next email is checked again", !!s2 && s2.ticketId !== s1!.ticketId && s2.spam === true && checks.length === asked + 1);
    check("the second spam conversation blocks the sender", await isSenderBlocked(A, "email", addr("spammer")));
    check("a blocked sender's next email is dropped", (await email(addr("spammer"), "legit")) === null);

    // ---- Outreach never blocks ----
    const o1 = await email(addr("pitch"), "outreach");
    check("an outreach email is hidden as outreach", !!o1 && (await ticket(o1.ticketId)).spam_kind === "outreach");
    const o2 = await email(addr("pitch"), "outreach");
    check("two outreach conversations don't block the sender", !!o2 && o2.ticketId !== o1!.ticketId && !(await isSenderBlocked(A, "email", addr("pitch"))));
    const o3 = await email(addr("pitch"), "spam");
    check("outreach doesn't count towards the block when the sender later sends spam", !!o3 && o3.spam === true && !(await isSenderBlocked(A, "email", addr("pitch"))));

    // ---- Legit, known senders and failures ----
    const l1 = await email(addr("customer"), "legit");
    check("a legit email stays in the inbox", !!l1 && l1.spam === false && (await inView("all", l1.ticketId)));
    await close(l1!.ticketId);
    const known = checks.length;
    const l2 = await email(addr("customer"), "spam");
    check("a sender with a conversation that isn't spam is never checked", checks.length === known && !!l2 && l2.spam === false);
    await superPool.query("INSERT INTO contacts (tenant_id, email, name) VALUES ($1, $2, 'SPAMTEST imported')", [A, addr("imported")]);
    const i1 = await email(addr("imported"), "spam");
    check("a contact that the team added without a conversation is never checked", checks.length === known && !!i1 && i1.spam === false);
    // The post-ingest steps run in the background: the topic, and the ticket.created automations.
    await new Promise((r) => setTimeout(r, 2000));
    const topics = await superPool.query("SELECT id, topic FROM tickets WHERE id = ANY($1)", [[l1!.ticketId, s2!.ticketId]]);
    const topicOf = (id: string) => topics.rows.find((r) => r.id === id)?.topic ?? null;
    check("a legit ticket gets the post-ingest steps and a spam ticket doesn't", topicOf(l1!.ticketId) !== null && topicOf(s2!.ticketId) === null, topics.rows);
    const createdRuns = async (id: string) =>
      Number((await superPool.query("SELECT count(*)::int AS n FROM automation_runs WHERE ticket_id = $1 AND trigger_event = 'ticket.created'", [id])).rows[0].n);
    check("a legit ticket runs the ticket.created automations and a spam ticket doesn't", (await createdRuns(l1!.ticketId)) > 0 && (await createdRuns(s2!.ticketId)) === 0);
    const f1 = await email(addr("broken"), "fail");
    check("if the model fails, the email stays in the inbox", !!f1 && f1.spam === false && (await ticket(f1.ticketId)).spam_at === null);

    // ---- Every check is an AI trace on its ticket ----
    const traceOf = async (id: string) => (await listTicketTraces(A, id)).find((t) => t.kind === "spam_check");
    const ts = await traceOf(s1!.ticketId), tl = await traceOf(l1!.ticketId), tf = await traceOf(f1!.ticketId);
    check("a spam check records its verdict, reason and tokens", ts?.gateOutcome === "spam" && ts?.gateReason === "stub says spam" && ts?.tokensIn === 1 && ts?.model.includes("spam-model") === true, ts);
    check("a legit verdict keeps its reason too", tl?.gateOutcome === "legit" && tl?.gateReason === "stub says legit", tl);
    check("a failed check is recorded as failed", tf?.gateOutcome === "failed" && !!tf?.gateReason, tf);
    check("a known sender's email has no check", !(await traceOf(l2!.ticketId)));
    const listed = await listTraces(A, { page: 1, pageSize: 200, outcome: "spam_check", q: "SPAMTEST", from: null, to: null });
    const noSources = await listTraces(A, { page: 1, pageSize: 200, outcome: "no_sources", q: "SPAMTEST", from: null, to: null });
    check("the trace list files spam checks under their own category, not under no sources",
      listed.traces.some((t) => t.ticketId === s1!.ticketId) && !noSources.traces.some((t) => t.kind === "spam_check"));

    // ---- A workspace prompt is what the model gets ----
    await putSpamSettings(A, { prompt: "SPAMTEST own prompt for {company}." });
    await email(addr("ownprompt"), "legit");
    check("the model gets the workspace's prompt", checks[checks.length - 1]?.startsWith("SPAMTEST own prompt for TestCo."), checks[checks.length - 1]?.slice(0, 80));
    await putSpamSettings(A, { prompt: null });

    // ---- An agent's mark on a ticket that the AI hid ----
    await markConversationSpam(A, o1!.ticketId, { actorId: null });
    const re = await ticket(o1!.ticketId);
    check("an agent marking an AI-hidden ticket keeps the AI as its source and makes it spam", re.spam_source === "ai" && re.spam_kind === "spam" && re.spam_reason === "stub says outreach", re);

    // ---- Restoring an AI mark ----
    const hook = await createWebhook(A, { url: `https://hooks-${RUN}.spamtest.invalid/in`, events: ["ticket.created"] });
    const deliveries = async () =>
      Number((await superPool.query("SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1", [hook.webhook.id])).rows[0].n);
    const restored = await unmarkConversationSpam(A, s2!.ticketId);
    const t2 = await ticket(s2!.ticketId);
    check("restoring clears the mark", !!restored && t2.spam_at === null && t2.spam_source === null && t2.spam_kind === null && t2.spam_reason === null, t2);
    check("restoring unblocks the sender", !(await isSenderBlocked(A, "email", addr("spammer"))));
    await unmarkConversationSpam(A, o1!.ticketId);
    await new Promise((r) => setTimeout(r, 2000));
    check("restoring an AI-hidden ticket runs the ticket.created automations it skipped", (await createdRuns(s2!.ticketId)) > 0 && (await createdRuns(o1!.ticketId)) > 0);
    // A delivery row is written once the attempt finishes, which can take up to the delivery timeout.
    for (let i = 0; i < 40 && (await deliveries()) < 2; i++) await new Promise((r) => setTimeout(r, 250));
    check("restoring an AI-hidden ticket fires the ticket.created webhook it skipped", (await deliveries()) === 2, await deliveries());
    await deleteWebhook(A, hook.webhook.id);

    // ---- An agent's mark counts towards the block ----
    await close(l2!.ticketId);
    const m1 = await markConversationSpam(A, l1!.ticketId, { actorId: null });
    check("an agent's mark is recorded as such", (await ticket(l1!.ticketId)).spam_source === "agent" && (await ticket(l1!.ticketId)).spam_kind === "spam");
    check("one agent mark doesn't block", m1?.blocked === null);
    const m2 = await markConversationSpam(A, i1!.ticketId, { actorId: null });
    check("a different sender's mark doesn't block this one", m2?.blocked === null);
    const l3 = await email(addr("customer"), "legit");
    await close(l3!.ticketId);
    const m3 = await markConversationSpam(A, l3!.ticketId, { actorId: null });
    check("a second agent mark blocks the sender", m3?.blocked === addr("customer") && (await isSenderBlocked(A, "email", addr("customer"))), m3);

    // ---- Widget ban ----
    const banned = `SpamTest-User-${RUN}`;
    await blockSender(A, { channelType: "widget", handle: banned });
    const refused = await ask({ question: "SPAMTEST hello", clientMessageId: `spamtest-w1-${RUN}`, userId: banned });
    check("a banned user's message is refused with the chat-unavailable answer", refused.status === 403 && refused.body.error === "chat_unavailable", refused);
    const streamed = await ask({ question: "SPAMTEST hello", clientMessageId: `spamtest-w2-${RUN}`, userId: banned }, "/public/ask/stream");
    check("the streaming lane refuses them too", streamed.status === 403 && streamed.body.error === "chat_unavailable", streamed);
    const stored = await superPool.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND idempotency_key LIKE $2", [A, `widget:spamtest-w%-${RUN}`]);
    check("nothing from a banned user is stored", stored.rows[0].n === 0, stored.rows[0]);
    const other = await ask({ question: "SPAMTEST hello", clientMessageId: `spamtest-w3-${RUN}`, userId: `other-${RUN}` });
    check("another user can still write", other.status === 200, other.status);

    const secret = "spamtest-secret";
    await setIdentitySecret(A, key.publicKey, secret);
    await updateWidgetKey(A, key.publicKey, { config: { verifyIdentity: true } as never });
    const claimed = await ask({ question: "SPAMTEST hi", clientMessageId: `spamtest-w4-${RUN}`, userId: banned });
    check("with verification on, an unproven claim of a banned id isn't refused", claimed.status === 200, claimed.status);
    const proven = await ask({ question: "SPAMTEST hi", clientMessageId: `spamtest-w5-${RUN}`, userId: banned, userHash: computeUserHash(secret, banned) });
    check("with verification on, the proven banned user is refused", proven.status === 403, proven.status);

    // ---- Marking a widget conversation blocks its user, not the conversation ----
    const wc = (await superPool.query(
      "INSERT INTO contacts (tenant_id, name, external_id) VALUES ($1, 'SPAMTEST widget', $2) RETURNING id", [A, `Widget-User-${RUN}`],
    )).rows[0].id as string;
    const wt = (await superPool.query(
      "INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, contact_id) VALUES ($1, 'SPAMTEST widget mark', 'widget', $2, $3) RETURNING id",
      [A, `${RUN}-wconv`, wc],
    )).rows[0].id as string;
    // A whole-domain choice left over from an e-mail ticket must not reach a widget ban.
    const wm = await markConversationSpam(A, wt, { block: true, blockScope: "domain", actorId: null });
    check("marking a widget conversation bans its user", wm?.blocked === `widget-user-${RUN}` && (await isSenderBlocked(A, "widget", `Widget-User-${RUN}`)), wm);

    const ec = (await superPool.query(
      "INSERT INTO contacts (tenant_id, name, email) VALUES ($1, 'SPAMTEST widget', $2) RETURNING id", [A, addr("chat")],
    )).rows[0].id as string;
    const et = (await superPool.query(
      "INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, contact_id) VALUES ($1, 'SPAMTEST widget mark', 'widget', $2, $3) RETURNING id",
      [A, `${RUN}-econv`, ec],
    )).rows[0].id as string;
    const em = await markConversationSpam(A, et, { block: true, actorId: null });
    check("marking an e-mail-only widget visitor bans their e-mail", em?.blocked === addr("chat"), em);
    const proven2 = await ask({ question: "SPAMTEST hi", clientMessageId: `spamtest-w6-${RUN}`, email: addr("chat"), userHash: computeUserHash(secret, addr("chat")) });
    check("a banned e-mail-only visitor is refused", proven2.status === 403, proven2.status);
    await superPool.query("UPDATE contacts SET external_id = $2 WHERE id = $1", [ec, `Later-User-${RUN}`]);
    await unmarkConversationSpam(A, et);
    check("restoring lifts an e-mail ban after the visitor got a user id", !(await isSenderBlocked(A, "widget", addr("chat"))));

    const ec2 = (await superPool.query(
      "INSERT INTO contacts (tenant_id, name, email) VALUES ($1, 'SPAMTEST widget', $2) RETURNING id", [A, addr("chat2")],
    )).rows[0].id as string;
    const chatMarks: Array<string | null> = [];
    for (const conv of ["a", "b"]) {
      const id = (await superPool.query(
        "INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, contact_id) VALUES ($1, 'SPAMTEST widget mark', 'widget', $2, $3) RETURNING id",
        [A, `${RUN}-e2conv-${conv}`, ec2],
      )).rows[0].id as string;
      chatMarks.push((await markConversationSpam(A, id, { actorId: null }))?.blocked ?? null);
    }
    check("two spam marks ban an e-mail-only widget visitor", chatMarks[0] === null && chatMarks[1] === addr("chat2"), chatMarks);

    // ---- Unread counts per lane ----
    const user = (await superPool.query("SELECT id FROM users WHERE tenant_id = $1 LIMIT 1", [A])).rows[0]?.id as string;
    const counts = () => unreadCounts(A, user, { spam: viewFilter("spam"), all: viewFilter("all") });
    const c0 = await counts();
    const u1 = await email(addr("unread"), "spam");
    const c1 = await counts();
    check("a new spam conversation counts as unread in Spam only", c1.spam === c0.spam + 1 && c1.all === c0.all, { c0, c1 });
    await markTicketRead(A, u1!.ticketId, user);
    check("reading it clears the count", (await counts()).spam === c0.spam);

    // ---- The migration moves widget blocks from a conversation id to its user ----
    const contact = (await superPool.query(
      "INSERT INTO contacts (tenant_id, name, external_id) VALUES ($1, 'SPAMTEST widget', $2) RETURNING id", [A, `Conv-User-${RUN}`],
    )).rows[0].id as string;
    const conv = `${RUN}-conv`;
    await superPool.query("INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, contact_id) VALUES ($1, 'SPAMTEST widget', 'widget', $2, $3)", [A, conv, contact]);
    await superPool.query("INSERT INTO blocked_senders (tenant_id, channel_type, scope, handle) VALUES ($1, 'widget', 'address', $2)", [A, conv]);
    await superPool.query(fs.readFileSync(new URL("../../../packages/db/migrations/0139_spam_detection.sql", import.meta.url), "utf8"));
    const moved = await superPool.query("SELECT handle FROM blocked_senders WHERE tenant_id = $1 AND channel_type = 'widget' AND handle IN ($2, $3)", [A, conv, `conv-user-${RUN}`]);
    check("the migration moves a conversation block to the user", moved.rows.length === 1 && moved.rows[0].handle === `conv-user-${RUN}`, moved.rows);
    // A conversation id is chosen by the browser, so one can equal a banned user's id.
    const other2 = (await superPool.query(
      "INSERT INTO contacts (tenant_id, name, external_id) VALUES ($1, 'SPAMTEST widget', $2) RETURNING id", [A, `Other-User-${RUN}`],
    )).rows[0].id as string;
    await superPool.query("INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, contact_id) VALUES ($1, 'SPAMTEST widget', 'widget', $2, $3)", [A, `conv-user-${RUN}`, other2]);
    await superPool.query(fs.readFileSync(new URL("../../../packages/db/migrations/0139_spam_detection.sql", import.meta.url), "utf8"));
    const kept = await superPool.query("SELECT handle FROM blocked_senders WHERE tenant_id = $1 AND channel_type = 'widget' AND handle IN ($2, $3)", [A, `conv-user-${RUN}`, `other-user-${RUN}`]);
    check("a re-run leaves a user's block where it is", kept.rows.length === 1 && kept.rows[0].handle === `conv-user-${RUN}`, kept.rows);
  } finally {
    globalThis.fetch = realFetch;
    await putModelConfig(A, { provider: "managed" });
    await deleteWidgetKey(A, key.publicKey);
    await app.close();
    await superPool.query("DELETE FROM spam_settings WHERE tenant_id = $1", [A]);
    await superPool.query("DELETE FROM blocked_senders WHERE tenant_id = $1 AND (handle LIKE '%spamtest%' OR handle LIKE $2)", [A, `%${RUN}%`]);
    await superPool.query(
      "DELETE FROM draft_traces WHERE tenant_id = $1 AND ticket_id IN (SELECT id FROM tickets WHERE tenant_id = $1 AND subject LIKE 'SPAMTEST%')", [A],
    );
    await superPool.query("DELETE FROM tickets WHERE tenant_id = $1 AND subject LIKE 'SPAMTEST%'", [A]);
    await superPool.query("DELETE FROM contacts WHERE tenant_id = $1 AND (email LIKE '%@spamtest.example' OR name = 'SPAMTEST widget' OR external_id LIKE $2)", [A, `%${RUN}%`]);
    await superPool.end();
  }

  if (failures > 0) { console.error(`\nSPAM DETECTION: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nSPAM DETECTION: all checks green");
  process.exit(0);
}

main().catch((e) => { console.error("spam detection ERROR", e); process.exit(1); });
