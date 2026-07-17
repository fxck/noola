import pg from "pg";
import { ingestInbound } from "../src/ingest.js";
import { ingestDocument } from "../src/documents.js";
import { createArticle } from "../src/kb.js";
import { ensureChunksCollection, ensureKbCollection } from "../src/search.js";
import { suggestForQuery } from "../src/copilot.js";
import {
  getPolicy, putPolicy, evaluateAutoreply, effectiveChannelMode, type AutoreplyPolicy,
} from "../src/autoreply.js";
import {
  validateAgentAction, actionFingerprint, runTicketAgent, listAgentRunsForTicket, __setAgentDriver,
} from "../src/automations.js";
import { handleSlackEvent, upsertSlackConnection, deleteSlackConnection, stripMentions, __setSlackFetch } from "../src/slack.js";
import { getContainment } from "../src/analytics.js";
import { ruleTopic, reclassifyGeneral } from "../src/topics.js";
import { getAiOverview } from "../src/ai-overview.js";

// Wave 5 — AI moat sharpening. Covers: the hardened agent loop (schema validation +
// bounded retry, enforced dedupe, reply-then-stop, persisted agent_runs trace), the
// confidence-routing policy (per-channel modes, min_confidence floor, per-audience
// retrieval scoping), the Slack answer-bot lane, the containment funnel, the topics
// reclassify sweep, and the governance overview aggregate.
// Run with FORCE_RULE_MODEL=1 (deterministic; the loop tests inject a scripted driver).
// Needs PG + Typesense + Qdrant + embedder (the scoping tests retrieve for real).

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const MARK = "wavefivezarquon"; // distinctive retrieval marker for THIS suite

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

let superPool: pg.Pool;

async function main() {
  superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  await ensureChunksCollection();
  await ensureKbCollection();

  const clean = async () => {
    await superPool.query("DELETE FROM agent_runs WHERE tenant_id = $1 AND instructions LIKE 'WAVE5%'", [A]);
    await superPool.query("DELETE FROM autoreply_queue WHERE tenant_id = $1 AND ticket_id IN (SELECT id FROM tickets WHERE subject LIKE 'WAVE5%')", [A]);
    await superPool.query("DELETE FROM autoreply_decisions WHERE tenant_id = $1 AND ticket_id IN (SELECT id FROM tickets WHERE subject LIKE 'WAVE5%')", [A]);
    await superPool.query("DELETE FROM autoreply_policy WHERE tenant_id = $1", [A]);
    await superPool.query("DELETE FROM draft_traces WHERE query LIKE '%' || $1 || '%'", [MARK]);
    await superPool.query("DELETE FROM documents WHERE filename LIKE 'WAVE5%'");
    await superPool.query("DELETE FROM kb_articles WHERE title LIKE 'WAVE5%'");
    await superPool.query("DELETE FROM slack_connections WHERE team_id = 'TWAVE5'");
    await superPool.query("DELETE FROM tickets WHERE subject LIKE 'WAVE5%'");
  };
  await clean();

  // ═══ 1. Pure guards ═══════════════════════════════════════════════════════

  const allowed = new Set(["reply", "set_status", "set_priority"]);
  check("validate: unknown tool rejected",
    validateAgentAction({ type: "kb_upsert" } as never, allowed) !== null);
  check("validate: reply without body rejected",
    validateAgentAction({ type: "reply", body: "  " } as never, allowed) !== null);
  check("validate: good reply passes",
    validateAgentAction({ type: "reply", body: "hi" } as never, allowed) === null);
  check("validate: bad enum rejected",
    validateAgentAction({ type: "set_priority", priority: "mega" } as never, allowed) !== null);
  check("validate: good enum passes",
    validateAgentAction({ type: "set_priority", priority: "urgent" } as never, allowed) === null);
  check("fingerprint: key order irrelevant",
    actionFingerprint({ type: "reply", body: "x" } as never) === actionFingerprint({ body: "x", type: "reply" } as never));
  check("fingerprint: different config differs",
    actionFingerprint({ type: "reply", body: "x" } as never) !== actionFingerprint({ type: "reply", body: "y" } as never));

  const pol = (over: Partial<AutoreplyPolicy>): AutoreplyPolicy => ({
    mode: "auto", min_agreement: 2, min_top_score: 0, channel_modes: {}, min_confidence: null,
    source_scopes: {}, max_auto_per_thread: 3, max_auto_per_hour: 30, kill_switch: false, ...over,
  });
  check("channel mode: explicit auto honored under global auto",
    effectiveChannelMode(pol({ mode: "auto", channel_modes: { email: "auto" } }), "email") === "auto");
  check("channel mode: global suggest_only clamps an explicit channel auto",
    effectiveChannelMode(pol({ mode: "suggest_only", channel_modes: { email: "auto" } }), "email") === "suggest_only");
  check("channel mode: unlisted under auto degrades to suggest_only",
    effectiveChannelMode(pol({ mode: "auto" }), "email") === "suggest_only");
  check("channel mode: skip survives global suggest_only",
    effectiveChannelMode(pol({ mode: "suggest_only", channel_modes: { discord: "skip" } }), "discord") === "skip");
  check("channel mode: skip is honored under auto",
    effectiveChannelMode(pol({ channel_modes: { discord: "skip" } }), "discord") === "skip");

  check("stripMentions removes bot mention", stripMentions("<@U123ABC> how do I reset?") === "how do I reset?");

  check("ruleTopic: tuned bug pattern (freezing/timing out)",
    ruleTopic("", "The app keeps freezing and timing out on load") === "bug");
  check("ruleTopic: tuned how-to pattern (documentation)",
    ruleTopic("", "Where is the documentation for getting started please") === "how-to");

  // ═══ 2. Hardened loop (scripted driver) ═══════════════════════════════════

  const t1 = await ingestInbound({ tenantId: A, authorType: "customer", subject: "WAVE5 loop", body: "Please help with my account settings." });

  // 2a. Invalid JSON then invalid schema then a valid reply → retries recover, reply-then-stop ends it.
  {
    const responses = [
      "sorry, I think we should reply", // no JSON → retry 1
      '{"action":{"type":"reply"},"reason":"missing body"}', // schema error → retry 2
      '{"action":{"type":"reply","body":"WAVE5 the answer"},"reason":"answer"}',
      '{"action":{"type":"set_status","status":"closed"},"reason":"should never be reached"}',
    ];
    let i = 0;
    __setAgentDriver({ name: "scripted", complete: async () => responses[Math.min(i++, responses.length - 1)] });
    const out = await runTicketAgent(A, t1.ticketId, { instructions: "WAVE5 retry", maxSteps: 4 }, { dryRun: true });
    __setAgentDriver(null);
    check("loop: recovered from 2 invalid responses and executed the reply",
      out !== null && out.results.length === 1 && out.results[0].type === "agent:reply" && out.results[0].ok);
    check("loop: reply-then-stop halted before set_status", out !== null && out.results.length === 1);
    check("loop: model saw 4 calls (2 retries + reply)", i === 3);
  }

  // 2b. Duplicate action is skipped without re-execution; done ends the loop.
  {
    const responses = [
      '{"action":{"type":"set_priority","priority":"high"},"reason":"bump"}',
      '{"action":{"type":"set_priority","priority":"high"},"reason":"bump again"}',
      '{"done":true,"summary":"finished"}',
    ];
    let i = 0;
    __setAgentDriver({ name: "scripted", complete: async () => responses[Math.min(i++, responses.length - 1)] });
    const out = await runTicketAgent(A, t1.ticketId, { instructions: "WAVE5 dedupe", tools: ["set_priority", "reply"], maxSteps: 5 }, { dryRun: true });
    __setAgentDriver(null);
    check("loop: duplicate action executed once", out !== null && out.results.filter((r) => r.type === "agent:set_priority").length === 1);
  }

  // 2c. The loop trace persisted to agent_runs with source='manual' + readable steps.
  {
    const runs = await listAgentRunsForTicket(A, t1.ticketId);
    check("agent_runs: both runs persisted", runs.length === 2);
    const retryRun = runs.find((r) => r.instructions === "WAVE5 retry");
    check("agent_runs: source=manual + dry_run recorded",
      retryRun?.source === "manual" && retryRun?.dry_run === true);
    const kinds = (retryRun?.steps ?? []).map((s) => s.kind);
    check("agent_runs: trace shows invalid→invalid→action→reply-stop",
      kinds.filter((k) => k === "invalid").length === 2 && kinds.includes("action") && kinds.includes("limit"));
    const dedupeRun = runs.find((r) => r.instructions === "WAVE5 dedupe");
    check("agent_runs: dedupe trace records the duplicate",
      (dedupeRun?.steps ?? []).some((s) => s.kind === "duplicate"));
  }

  // 2d. Retry budget exhaustion → status=error.
  {
    __setAgentDriver({ name: "scripted", complete: async () => "never json" });
    const out = await runTicketAgent(A, t1.ticketId, { instructions: "WAVE5 exhaust", maxSteps: 3 }, { dryRun: true });
    __setAgentDriver(null);
    check("loop: persistent invalid output ends with zero actions", out !== null && out.results.length === 0);
    const runs = await listAgentRunsForTicket(A, t1.ticketId);
    check("agent_runs: exhausted run recorded as error",
      runs.find((r) => r.instructions === "WAVE5 exhaust")?.status === "error");
  }

  // ═══ 3. Confidence routing (per-channel + floor) ══════════════════════════

  // Seed retrieval: one KB article (agreement=1) with the distinctive marker.
  await createArticle(A, "WAVE5 gadget guide", `The ${MARK} gadget pairs over bluetooth; hold the button five seconds to reset it.`);
  // A separate DOCUMENT with a marker that exists NOWHERE in the KB — the scoping probe.
  await ingestDocument(A, "WAVE5-internal.md", "text/markdown", `# Internal\n\nThe ${MARK}docsecret rollout plan is internal-only and documented here.`);

  const strong = `How do I reset the ${MARK} gadget?`;
  // Wait for indexing so the KB article is retrievable.
  let agr = 0;
  for (let i = 0; i < 20; i++) {
    const s = await suggestForQuery(A, strong, { source: "eval" });
    agr = s.retrieval.agreement;
    if (agr >= 1) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("seed: KB retrieval corroborates (agreement ≥ 1)", agr >= 1);

  const arm = async (ticketId: string) =>
    superPool.query("UPDATE tickets SET whose_turn = 'us' WHERE id = $1", [ticketId]);

  // Each scenario ingests its ticket while mode='off' (the ingest hook would otherwise
  // race the explicit evaluateAutoreply call for the idempotent decision row), then
  // flips the policy and evaluates.

  // 3a. channel 'skip' → terminal suppression without drafting.
  await putPolicy(A, { mode: "off" }, { sweep: false });
  const tSkip = await ingestInbound({ tenantId: A, authorType: "customer", subject: "WAVE5 skip", body: strong });
  await putPolicy(A, { mode: "auto", min_agreement: 1, channel_modes: { synthetic: "skip" } }, { sweep: false });
  await arm(tSkip.ticketId);
  const rSkip = await evaluateAutoreply(A, tSkip.ticketId, tSkip.messageId);
  check("routing: channel skip suppresses without drafting",
    rSkip?.outcome === "suppressed" && rSkip.reason === "channel_skipped");

  // 3b. unlisted channel under global auto → suggest_only (draft held for review).
  await putPolicy(A, { mode: "off" }, { sweep: false });
  const tDeg = await ingestInbound({ tenantId: A, authorType: "customer", subject: "WAVE5 degrade", body: strong });
  await putPolicy(A, { mode: "auto", min_agreement: 1, channel_modes: {} }, { sweep: false });
  await arm(tDeg.ticketId);
  const rDeg = await evaluateAutoreply(A, tDeg.ticketId, tDeg.messageId);
  check("routing: unlisted channel under auto degrades to assist",
    rDeg?.outcome === "assist" && rDeg.reason === "suggest_only" && !!rDeg.queueItemId);

  // 3c. explicit per-channel auto + impossible confidence floor → held as low_confidence.
  await putPolicy(A, { mode: "off" }, { sweep: false });
  const tLow = await ingestInbound({ tenantId: A, authorType: "customer", subject: "WAVE5 lowconf", body: strong });
  await putPolicy(A, { mode: "auto", min_agreement: 1, channel_modes: { synthetic: "auto" }, min_confidence: 0.99 }, { sweep: false });
  await arm(tLow.ticketId);
  const rLow = await evaluateAutoreply(A, tLow.ticketId, tLow.messageId);
  check("routing: confidence floor holds the draft (low_confidence)",
    rLow?.outcome === "suppressed" && rLow.reason === "low_confidence" && !!rLow.queueItemId);

  // 3d. floor cleared → the same setup auto-sends.
  await putPolicy(A, { mode: "off" }, { sweep: false });
  const tGo = await ingestInbound({ tenantId: A, authorType: "customer", subject: "WAVE5 autosend", body: strong });
  await putPolicy(A, { mode: "auto", min_agreement: 1, channel_modes: { synthetic: "auto" }, min_confidence: null }, { sweep: false });
  await arm(tGo.ticketId);
  const rGo = await evaluateAutoreply(A, tGo.ticketId, tGo.messageId);
  check("routing: explicit channel auto + no floor auto-sends",
    rGo?.outcome === "auto_sent" && !!rGo.sentMessageId);

  // ═══ 4. Audience source scoping ═══════════════════════════════════════════

  // The doc-only marker: agents retrieve it, the public audience (KB-only default) must not.
  const docQuery = `Tell me about the ${MARK}docsecret rollout plan`;
  let agentCites = 0;
  for (let i = 0; i < 20; i++) {
    const s = await suggestForQuery(A, docQuery, { source: "eval", audience: "agent" });
    agentCites = s.citations.filter((c) => c.kind === "document").length;
    if (agentCites >= 1) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("scoping: agent audience retrieves the internal document", agentCites >= 1);
  const sPub = await suggestForQuery(A, docQuery, { source: "eval", audience: "public" });
  check("scoping: public audience cannot cite documents/threads",
    sPub.citations.every((c) => c.kind === "kb"));
  check("scoping: public audience found no internal-doc citation",
    sPub.citations.filter((c) => c.kind === "document").length === 0);

  // Configured override: allow documents for public → the doc becomes citable.
  await putPolicy(A, { source_scopes: { public: ["kb", "document"] } }, { sweep: false });
  let pubDocCites = 0;
  for (let i = 0; i < 10; i++) {
    const s2 = await suggestForQuery(A, docQuery, { source: "eval", audience: "public" });
    pubDocCites = s2.citations.filter((c) => c.kind === "document").length;
    if (pubDocCites >= 1) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("scoping: configured public scope widens retrieval", pubDocCites >= 1);
  await putPolicy(A, { source_scopes: {} }, { sweep: false });

  // ═══ 5. Slack answer-bot ═══════════════════════════════════════════════════

  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  __setSlackFetch(async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await upsertSlackConnection(A, { team_id: "TWAVE5", bot_token: "xoxb-wave5-test", active: true, answer_bot: true });

  const mention = (ts: string, text: string) => JSON.stringify({
    type: "event_callback", team_id: "TWAVE5",
    event: { type: "app_mention", user: "U777", channel: "C42", text, ts, event_ts: ts },
  });

  const ansRes = await handleSlackEvent(mention("1000.1", `<@UBOT> how do I reset the ${MARK} gadget?`));
  check("slack: app_mention answered in-thread",
    ansRes.kind === "answered" && (ansRes as { delivered: boolean }).delivered === true);
  check("slack: reply threaded on the question ts",
    posts.length === 1 && posts[0].body.thread_ts === "1000.1" && posts[0].body.channel === "C42");
  check("slack: no ticket created for the mention",
    (await superPool.query("SELECT count(*)::int AS n FROM tickets WHERE tenant_id = $1 AND external_channel_id = 'TWAVE5:C42'", [A])).rows[0].n === 0);

  const dupRes = await handleSlackEvent(mention("1000.1", `<@UBOT> how do I reset the ${MARK} gadget?`));
  check("slack: redelivered mention not answered twice",
    dupRes.kind === "answered" && (dupRes as { delivered: boolean }).delivered === false && posts.length === 1);

  await upsertSlackConnection(A, { team_id: "TWAVE5", answer_bot: false });
  const offRes = await handleSlackEvent(mention("1000.2", "<@UBOT> another question here"));
  check("slack: answer_bot=false ignores the mention",
    offRes.kind === "ignored" && (offRes as { reason: string }).reason === "answer bot disabled");

  // Plain channel message still creates a ticket (the two lanes coexist).
  const msgRes = await handleSlackEvent(JSON.stringify({
    type: "event_callback", team_id: "TWAVE5",
    event: { type: "message", user: "U777", channel: "C42", text: "WAVE5 plain slack message", ts: "1000.3", event_ts: "1000.3" },
  }));
  check("slack: plain message keeps the ticket lane", msgRes.kind === "ingested");
  await superPool.query("UPDATE tickets SET subject = 'WAVE5 slack lane' WHERE tenant_id = $1 AND external_channel_id = 'TWAVE5:C42'", [A]);
  __setSlackFetch(null);

  // ═══ 6. Containment funnel ══════════════════════════════════════════════════

  // Seed one of each bucket (this week), then assert the report reflects ≥ the seeds
  // (shared dev/stage DB — other suites' tickets also land in the window).
  const tAi = await ingestInbound({ tenantId: A, authorType: "customer", subject: "WAVE5 contained", body: "contained?" });
  await superPool.query(
    "INSERT INTO messages (tenant_id, ticket_id, author_type, body, auto) VALUES ($1, $2, 'agent', 'auto answer', true)",
    [A, tAi.ticketId],
  );
  await superPool.query("UPDATE tickets SET status = 'closed', closed_at = now() WHERE id = $1", [tAi.ticketId]);
  const tHum = await ingestInbound({ tenantId: A, authorType: "customer", subject: "WAVE5 humanled", body: "human?" });
  await superPool.query(
    "INSERT INTO messages (tenant_id, ticket_id, author_type, body, auto) VALUES ($1, $2, 'agent', 'human answer', false)",
    [A, tHum.ticketId],
  );
  const cont = await getContainment(A, 4);
  check("containment: aiResolved counts the auto-closed ticket", cont.totals.aiResolved >= 1);
  check("containment: humanOnly counts the human-answered ticket", cont.totals.humanOnly >= 1);
  check("containment: rate is a 0-100 percentage",
    cont.totals.containment !== null && cont.totals.containment >= 0 && cont.totals.containment <= 100);
  check("containment: weekly buckets sorted and present",
    cont.byWeek.length >= 1 && [...cont.byWeek.map((w) => w.week)].sort().join() === cont.byWeek.map((w) => w.week).join());
  // The auto-sent eval from §3d also produced a live decision — deflected lane counts only
  // ticketless traces, so it must NOT include ticket-bound drafts.
  const liveTraceless = (await superPool.query(
    "SELECT count(*)::int AS n FROM draft_traces WHERE tenant_id = $1 AND source = 'live' AND ticket_id IS NULL AND created_at > now() - make_interval(weeks => 4)",
    [A],
  )).rows[0].n as number;
  check("containment: deflected matches ticketless live traces", cont.totals.deflected === liveTraceless);

  // ═══ 7. Topics reclassify sweep ═══════════════════════════════════════════

  const tGen = await ingestInbound({ tenantId: A, authorType: "customer", subject: "WAVE5 reclass", body: "Everything keeps freezing and timing out since yesterday." });
  // Ingest-time classification is fire-and-forget — wait for it to settle before
  // forcing the topic back to 'general' (else it lands after and overwrites us).
  for (let i = 0; i < 20; i++) {
    const t = (await superPool.query("SELECT topic FROM tickets WHERE id = $1", [tGen.ticketId])).rows[0].topic as string | null;
    if (t && t !== "general") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await superPool.query("UPDATE tickets SET topic = 'general' WHERE id = $1", [tGen.ticketId]);
  const rec = await reclassifyGeneral(A, 300);
  const newTopic = (await superPool.query("SELECT topic FROM tickets WHERE id = $1", [tGen.ticketId])).rows[0].topic as string;
  check("reclassify: the general ticket moved to bug", newTopic === "bug");
  check("reclassify: result counts the move", rec.reclassified >= 1 && (rec.byTopic.bug ?? 0) >= 1);

  // ═══ 8. Governance overview ═══════════════════════════════════════════════

  const ov = await getAiOverview(A);
  check("overview: model + policy + queue shape",
    typeof ov.model.provider === "string" && typeof ov.policy.mode === "string" && typeof ov.queue.pending === "number");
  check("overview: 7d activity reflects this suite's work",
    ov.activity7d.agentRuns >= 3 && ov.activity7d.autoSent >= 1 && ov.activity7d.drafts >= 1);
  check("overview: public source scope reported (default kb)",
    Array.isArray(ov.policy.publicSourceKinds) && ov.policy.publicSourceKinds.includes("kb"));

  // ---- restore: policy off so later suites/demo aren't affected; drop the test connection.
  await putPolicy(A, { mode: "off", min_agreement: 2, channel_modes: { synthetic: "auto", discord: "auto" }, min_confidence: null }, { sweep: false });
  const conns = await superPool.query("SELECT id FROM slack_connections WHERE team_id = 'TWAVE5'");
  for (const row of conns.rows) await deleteSlackConnection(A, row.id as string);

  if (failures > 0) { console.error(`\nAI-WAVE5: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nAI-WAVE5: all checks passed");
  process.exit(0);
}

main().catch((e) => { console.error("ai-wave5 ERROR", e); process.exit(1); });
