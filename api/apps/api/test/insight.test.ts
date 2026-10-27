import { appPool, relayPool } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { ruleTopic, assignTicketTopic, listTopics } from "../src/topics.js";
import { ruleScore, scoreTicket, listScores, qaSummary } from "../src/qa.js";
import { getPersona, putPersona, personaPrompt, DEFAULT_PERSONA } from "../src/persona.js";
import { createSegment, deleteSegment } from "../src/segments.js";
import { createBroadcast, getBroadcast } from "../src/broadcasts.js";
import { createContact } from "../src/contacts.js";

// Wave-3 insight gate: deterministic topic + QA scorers (pure), then DB-backed topic assignment,
// QA scoring + review list, persona upsert/render, and broadcast-from-saved-segment. FORCE_RULE_MODEL
// keeps the model paths deterministic. Postgres only; tenant A (Acme), isolation checked against B.

const A = "33333333-3333-3333-3333-333333333333";
const B = "22222222-2222-2222-2222-222222222222";
const MARK = "INSIGHTTEST";
const RUN = Date.now().toString(36); // run-unique suffix so re-runs don't collide on unique emails

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  // ---- pure: deterministic topic classifier ----
  check("ruleTopic → billing", ruleTopic("Invoice question", "I was charged twice on my subscription") === "billing");
  check("ruleTopic → account", ruleTopic("Can't log in", "password reset isn't working, I'm locked out") === "account");
  check("ruleTopic → refund beats billing", ruleTopic("refund please", "I want my money back for the invoice") === "refund");
  check("ruleTopic → general fallback", ruleTopic("hello", "zqxwv blorptth") === "general");

  // ---- pure: deterministic QA scorer ----
  const good = ruleScore(
    { subject: "s", status: "closed", sentiment: "positive", created_at: "", closed_at: "x" },
    [{ author_type: "customer", body: "help", auto: false }, { author_type: "agent", body: "x".repeat(220), auto: false }],
  );
  const bad = ruleScore(
    { subject: "s", status: "open", sentiment: "negative", created_at: "", closed_at: null },
    [{ author_type: "customer", body: "help", auto: false }],
  );
  check("ruleScore resolved+positive scores high", good.overall >= 80 && good.band === "excellent");
  check("ruleScore open+unanswered+negative scores low", bad.overall < 50 && bad.band === "poor");
  check("ruleScore sub-scores are 0..100", [good.resolution, good.tone, good.completeness].every((n) => n >= 0 && n <= 100));

  // ---- pure: persona render ----
  check("personaPrompt empty for default", personaPrompt(DEFAULT_PERSONA) === "");
  const rendered = personaPrompt({ tone: "formal", signature: "— Acme", guardrails: "promise refunds", instructions: "Be brief." });
  check("personaPrompt includes tone/instructions/guardrails/signature",
    rendered.includes("formal") && rendered.includes("Be brief.") && rendered.includes("promise refunds") && rendered.includes("— Acme"));

  // ---- DB: topic assignment + explorer ----
  const t1 = await ingestInbound({ tenantId: A, authorType: "customer", subject: `${MARK} billing`, body: "I was charged twice on my invoice this month" });
  await assignTicketTopic(A, t1.ticketId, `${MARK} billing`, "I was charged twice on my invoice this month");
  const topics = await listTopics(A);
  const billing = topics.find((t) => t.topic === "billing");
  check("listTopics surfaces the billing topic", !!billing && billing.total >= 1);
  check("topic summary has a 14-length spark", !!billing && billing.spark.length === 14);

  // ---- DB: QA scoring + review list ----
  const t2 = await ingestInbound({ tenantId: A, authorType: "customer", subject: `${MARK} qa`, body: "how do I export my data?" });
  await ingestInbound({ tenantId: A, authorType: "agent", ticketId: t2.ticketId, body: "You can export from Settings → Data. " + "x".repeat(200) });
  const score = await scoreTicket(A, t2.ticketId);
  check("scoreTicket returns a score row", !!score && score.overall >= 0 && score.overall <= 100);
  check("scoreTicket persists band", !!score && ["excellent", "good", "fair", "poor"].includes(score.band));
  const rescored = await scoreTicket(A, t2.ticketId);
  check("re-score upserts (one row, stable ticket_id)", rescored?.ticket_id === score?.ticket_id);
  const list = await listScores(A);
  check("listScores includes the scored ticket", list.some((s) => s.ticket_id === t2.ticketId && s.subject.includes(MARK)));
  const summary = await qaSummary(A);
  check("qaSummary counts at least one scored", summary.scored >= 1);
  check("scoreTicket on unknown ticket → null", (await scoreTicket(A, "00000000-0000-0000-0000-000000000000")) === null);

  // ---- DB: persona upsert + isolation ----
  const before = await getPersona(A);
  const saved = await putPersona(A, { tone: "playful", signature: `${MARK}-sig` });
  check("putPersona sets tone", saved.tone === "playful" && saved.signature === `${MARK}-sig`);
  check("putPersona partial keeps other fields", saved.guardrails === before.guardrails);
  check("getPersona reads it back", (await getPersona(A)).tone === "playful");
  check("persona is tenant-isolated (B unaffected)", (await getPersona(B)).signature !== `${MARK}-sig`);
  await putPersona(A, { tone: DEFAULT_PERSONA.tone, signature: "" }); // reset

  // ---- DB: broadcast from a saved segment ----
  const co = `${MARK}Co${RUN}`;
  await createContact(A, { name: "Insight One", email: `insight-1-${RUN}@${MARK}.test`, company: co });
  await createContact(A, { name: "Insight Two", email: `insight-2-${RUN}@${MARK}.test`, company: co });
  const seg = await createSegment(A, { name: `${MARK} seg`, resource: "contacts", definition: { company: co } });
  const bc = await createBroadcast(A, { subject: `${MARK} bcast`, body: "hi", segmentId: seg.id });
  check("broadcast records segment_id provenance", bc.segment_id === seg.id);
  check("broadcast resolved the saved segment's audience", bc.recipient_count >= 2);
  const round = await getBroadcast(A, bc.id);
  check("saved-segment broadcast reads back with segment_id", round?.broadcast.segment_id === seg.id);
  const bogus = await createBroadcast(A, { subject: `${MARK} bcast2`, body: "hi", segmentId: "00000000-0000-0000-0000-000000000000" });
  check("unknown segmentId is dropped (null), broadcast still created", bogus.segment_id === null);
  await deleteSegment(A, seg.id);

  await appPool.end();
  await relayPool.end();
  if (failures > 0) { console.error(`\nINSIGHT: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nINSIGHT: all checks green");
}

main().catch((e) => { console.error("insight seam ERROR", e); process.exit(1); });
