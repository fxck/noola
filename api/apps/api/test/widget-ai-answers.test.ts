import Fastify from "fastify";
import pg from "pg";
import { relayPool } from "@repo/db";
import widgetRoutes from "../src/routes/widget.js";
import { createWidgetKey } from "../src/widget.js";
import { getModelConfig, putModelConfig } from "../src/modelconfig.js";
import { createArticle } from "../src/kb.js";
import { getPolicy, putPolicy } from "../src/autoreply.js";
import { ensureChunksCollection, ensureKbCollection } from "../src/search.js";

// The widget's own AI answers honour the note and "no reply" tags, and a widget turn gets one answer, not a second from
// the ambient autoreply. A hosted model sits behind a stubbed endpoint that streams. AIWIDGET data, removed at the end.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const ENDPOINT = "https://llm.aiwidget.invalid/v1";

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
  // A connection the server drops must not crash the run before the finally restores TestCo's model and policy.
  superPool.on("error", () => {});
  if ((await getModelConfig(A)).provider !== "managed") throw new Error("TestCo has a hosted model, which this test would overwrite");

  let pieces: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith(ENDPOINT)) return realFetch(url, init);
    const streaming = JSON.parse(String(init?.body ?? "{}")).stream === true;
    if (!streaming) {
      return new Response(JSON.stringify({ choices: [{ message: { content: pieces.join("") } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    // A streamed answer takes a moment, as a real model's does, so an ambient autoreply on the same turn would finish first.
    await new Promise((r) => setTimeout(r, 2000));
    const sse = pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const policyBefore = await getPolicy(A);
  const key = await createWidgetKey(A, { label: "AIWIDGET" });
  const app = Fastify();
  await app.register(widgetRoutes);
  let n = 0;
  const contacts = "SELECT id FROM contacts WHERE tenant_id = $1 AND email LIKE 'aiwidget-%@example.invalid'";
  const tickets = `SELECT id FROM tickets WHERE contact_id IN (${contacts})`;

  /** One visitor turn on the streaming lane, as the widget sends it. */
  const ask = async (model: string[], question?: string) => {
    pieces = model;
    n++;
    const r = await app.inject({
      method: "POST", url: "/public/ask/stream",
      payload: { key: key.publicKey, question: question ?? `How do I export AIWIDGET reports? (${n})`, email: `aiwidget-${n}@example.invalid`, clientMessageId: `aiwidget-${n}` },
    });
    const events = r.body.split("\n\n").filter((f) => f.startsWith("event:")).map((f) => {
      const [ev, data] = f.split("\n");
      return { event: ev.slice(6).trim(), data: JSON.parse(data.slice(5).trim()) as Record<string, unknown> };
    });
    const shown = events.filter((e) => e.event === "delta").map((e) => String(e.data.t)).join("");
    const done = events.find((e) => e.event === "done")?.data ?? {};
    const conv = String(done.conversationId ?? "");
    const q = (sql: string) => superPool.query(sql, [conv]).then((x) => x.rows);
    return {
      shown, done,
      replies: (await q("SELECT body FROM messages WHERE ticket_id = $1 AND author_type = 'agent'")).map((m) => m.body as string),
      notes: (await q("SELECT body FROM ticket_notes WHERE ticket_id = $1")).map((m) => m.body as string),
      ticket: (await q("SELECT whose_turn, assistant_enabled FROM tickets WHERE id = $1"))[0],
      queued: (await q("SELECT reason FROM autoreply_queue WHERE ticket_id = $1")).map((m) => m.reason as string),
      decisions: (await q("SELECT reason, source FROM autoreply_decisions WHERE ticket_id = $1")),
    };
  };

  try {
    await putModelConfig(A, { provider: "custom", endpoint: ENDPOINT, model: "aiwidget-model", apiKey: "k" });
    // With the ambient autoreply on for the widget, it would record a decision if it also answered.
    await putPolicy(A, { mode: "auto", channel_modes: { widget: "auto" }, min_agreement: 0, min_top_score: 0 }, { sweep: false });
    // A public answer without a matching public article never reaches the model.
    await ensureChunksCollection();
    await ensureKbCollection();
    await createArticle(A, "AIWIDGET reports export", "To export AIWIDGET reports, open Reports and choose Export as CSV.", null, { visibility: "public" });

    const plain = await ask(["Your export ", "is ready."]);
    check("a plain answer streams and is stored", plain.shown === "Your export is ready." && plain.replies[0] === "Your export is ready." && !!plain.done.messageId, plain);
    check("the ambient autoreply leaves a widget turn alone", plain.decisions.length === 0 && plain.replies.length === 1, plain.decisions);

    const noted = await ask(["Try version 2.1. <inter", "nal>Upgrade bug.</inter", "nal>"]);
    check("a reply with a note shows only the reply", noted.shown.trim() === "Try version 2.1." && noted.replies[0] === "Try version 2.1.", noted.shown);
    check("the note goes to the team", noted.notes[0] === "Upgrade bug.", noted.notes);

    const quiet = await ask(["<no_", "reply/>"]);
    check("no reply sends nothing to the visitor", quiet.shown === "" && quiet.done.quiet === true && quiet.done.messageId === null && quiet.replies.length === 0, quiet.done);
    check("no reply hands the turn to the visitor", quiet.ticket.whose_turn === "customer" && quiet.decisions[0]?.reason === "no_reply_needed", quiet);
    const quietTrace = await superPool.query("SELECT gate_reason, draft FROM draft_traces WHERE message_id = (SELECT id FROM messages WHERE ticket_id = $1 AND author_type = 'customer' LIMIT 1)", [quiet.done.conversationId]);
    check("the trace records the decision and keeps what the model wrote", quietTrace.rows[0]?.gate_reason === "no_reply_needed" && quietTrace.rows[0]?.draft === "<no_reply/>", quietTrace.rows);

    // A closing "thanks" takes the ticket out of the needs-reply queue, and the handoff puts it back.
    const handoff = await ask(["<internal>I don't know this one. A teammate should answer.</internal>"], "Thanks, but the AIWIDGET reports export still fails");
    check("a note alone hands the visitor to a teammate", handoff.done.handoff === true && handoff.ticket.assistant_enabled === false && handoff.replies.length === 0 && handoff.notes.length === 1, handoff);
    check("a handoff puts the conversation in the needs-reply queue", handoff.ticket.whose_turn === "us", handoff.ticket);

    const handing = await ask(["A teammate will ", "take it from here. <hand", "off/>"]);
    check("a reply that hands off is shown and sent", handing.shown.trim() === "A teammate will take it from here." && handing.replies[0] === "A teammate will take it from here." && !!handing.done.messageId, handing.shown);
    check("then the AI is paused and the conversation waits for a teammate", handing.ticket.assistant_enabled === false && handing.ticket.whose_turn === "us", handing.ticket);

    const broken = await ask(["Sure, ", "here it is <internal>the secret plan"]);
    check("a broken answer never shows the hidden part", !broken.shown.includes("secret") && !broken.shown.includes("<"), broken.shown);
    check("a broken answer hands off and waits for review", broken.done.handoff === true && broken.ticket.assistant_enabled === false && broken.replies.length === 0 && broken.queued[0] === "malformed_output", broken);

    // The JSON lane answers the same way.
    pieces = ["<no_reply/>"];
    const json = await app.inject({
      method: "POST", url: "/public/ask",
      payload: { key: key.publicKey, question: "How do I export AIWIDGET reports? (json)", email: "aiwidget-json@example.invalid", clientMessageId: "aiwidget-json" },
    });
    const jsonBody = json.json() as Record<string, unknown>;
    const jsonReplies = await superPool.query("SELECT 1 FROM messages WHERE ticket_id = $1 AND author_type = 'agent'", [jsonBody.conversationId]);
    check("the JSON lane sends nothing for no reply", jsonBody.deferred === true && !jsonBody.answer && jsonReplies.rowCount === 0, jsonBody);

    const angled = await ask(["Use the ", "<br> tag ", "for a line break."]);
    check("an answer with a plain < still arrives whole", angled.shown === "Use the <br> tag for a line break." && angled.replies[0] === "Use the <br> tag for a line break.", angled.shown);
  } finally {
    globalThis.fetch = realFetch;
    await putModelConfig(A, { provider: "managed" });
    await putPolicy(A, policyBefore, { sweep: false });
    for (const table of ["autoreply_queue", "autoreply_decisions", "ticket_notes", "draft_traces", "messages"]) {
      await superPool.query(`DELETE FROM ${table} WHERE ticket_id IN (${tickets})`, [A]);
    }
    await superPool.query(`DELETE FROM tickets WHERE id IN (${tickets})`, [A]);
    await superPool.query(`DELETE FROM contacts WHERE id IN (${contacts})`, [A]);
    await superPool.query("DELETE FROM kb_articles WHERE tenant_id = $1 AND title LIKE 'AIWIDGET%'", [A]);
    await relayPool.query("DELETE FROM widget_keys WHERE public_key = $1", [key.publicKey]);
    await app.close();
    await superPool.end();
  }
  console.log(failures ? `\n${failures} FAILURES` : "\nWIDGET-AI-ANSWERS: all checks green");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
