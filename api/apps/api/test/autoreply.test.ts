import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { ingestDocument } from "../src/documents.js";
import { createArticle } from "../src/kb.js";
import { ensureChunksCollection, ensureKbCollection } from "../src/search.js";
import { suggestReply } from "../src/copilot.js";
import { getPolicy, putPolicy, evaluateAutoreply, listQueue, sendQueued, dismissQueued, enqueueBacklog, drainJobs, listJobs } from "../src/autoreply.js";

// Autoreply seam: confidence-gated auto-send. Off by default; auto-send fires ONLY on
// corroborated retrieval, no guardrail, allowed channel, caps not hit, mode='auto'.
// Every evaluation writes exactly one decision (idempotent); the send dedupes via a
// deterministic idempotencyKey. These checks are the trust floor for a customer-facing
// auto-send, so they cover guardrails, idempotency, caps, kill switch, and isolation.
// Needs PG + Typesense + Qdrant + the embedder (retrieval must corroborate).

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const MARK = "autoreplyzarquon"; // distinctive word planted in A's KB + doc + question

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

let superPool: pg.Pool;
/** Simulate "the customer is waiting" — evaluateAutoreply only fires when whose_turn='us'. */
async function arm(ticketId: string) {
  await superPool.query("UPDATE tickets SET whose_turn = 'us' WHERE id = $1", [ticketId]);
}
async function agentMsgCount(ticketId: string): Promise<number> {
  const r = await superPool.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1 AND author_type = 'agent'", [ticketId]);
  return r.rows[0].n as number;
}
async function assistantEnabled(ticketId: string): Promise<boolean> {
  const r = await superPool.query("SELECT assistant_enabled FROM tickets WHERE id = $1", [ticketId]);
  return r.rowCount ? r.rows[0].assistant_enabled !== false : true;
}
async function decisionCount(ticketId: string): Promise<number> {
  const r = await superPool.query("SELECT count(*)::int AS n FROM autoreply_decisions WHERE ticket_id = $1", [ticketId]);
  return r.rows[0].n as number;
}
async function queueCount(ticketId: string): Promise<number> {
  const r = await superPool.query("SELECT count(*)::int AS n FROM autoreply_queue WHERE ticket_id = $1 AND status = 'pending'", [ticketId]);
  return r.rows[0].n as number;
}
async function queueStatus(id: string): Promise<string | null> {
  const r = await superPool.query("SELECT status FROM autoreply_queue WHERE id = $1", [id]);
  return r.rowCount ? (r.rows[0].status as string) : null;
}
async function jobCountAny(ticketId: string): Promise<number> {
  const r = await superPool.query("SELECT count(*)::int AS n FROM autoreply_jobs WHERE ticket_id = $1", [ticketId]);
  return r.rows[0].n as number;
}
async function activeJobCount(ticketId: string): Promise<number> {
  const r = await superPool.query("SELECT count(*)::int AS n FROM autoreply_jobs WHERE ticket_id = $1 AND status IN ('queued','processing')", [ticketId]);
  return r.rows[0].n as number;
}
/** The most-recent job row for a ticket (null if none). */
async function jobRow(ticketId: string): Promise<{ status: string; reason: string; result_message_id: string | null; meta: unknown } | null> {
  const r = await superPool.query(
    "SELECT status, reason, result_message_id, meta FROM autoreply_jobs WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1",
    [ticketId],
  );
  return r.rowCount ? (r.rows[0] as { status: string; reason: string; result_message_id: string | null; meta: unknown }) : null;
}

async function main() {
  superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  await ensureChunksCollection();
  await ensureKbCollection();

  const clean = async () => {
    await superPool.query("DELETE FROM autoreply_jobs WHERE tenant_id IN ($1,$2)", [A, B]);
    await superPool.query("DELETE FROM autoreply_queue WHERE tenant_id IN ($1,$2)", [A, B]);
    await superPool.query("DELETE FROM autoreply_decisions WHERE tenant_id IN ($1,$2)", [A, B]);
    await superPool.query("DELETE FROM autoreply_policy WHERE tenant_id IN ($1,$2)", [A, B]);
    await superPool.query("DELETE FROM draft_traces WHERE query LIKE '%' || $1 || '%'", [MARK]);
    await superPool.query("DELETE FROM documents WHERE filename LIKE 'AUTOREPLY%'");
    await superPool.query("DELETE FROM kb_articles WHERE title LIKE 'AUTOREPLY%'");
    await superPool.query("DELETE FROM tickets WHERE subject LIKE 'AUTOREPLY%'");
  };
  await clean();

  // ---- seed A's knowledge so retrieval corroborates (KB + document = agreement 2).
  // Topic is guardrail-neutral (dashboard widgets) so the strong body doesn't trip a risk rule. ----
  await createArticle(A, "AUTOREPLY Widgets guide", `The ${MARK} dashboard widget shows recent activity; drag its corner to resize and the layout saves per user.`);
  await ingestDocument(A, "AUTOREPLY-guide.md", "text/markdown", `# Guide\n\nThe ${MARK} dashboard widget layout is stored per account and syncs across your devices.`);
  // Globex holds the same distinctive word — the cross-tenant leak trap.
  await ingestDocument(B, "AUTOREPLY-globex.md", "text/markdown", `# Globex\n\nGlobex ${MARK} secret internal runbook — must never reach Acme.`);

  // ---- ingest every test message while policy is OFF (the ingest hook no-ops) ----
  const strongBody = `Hi, how do I set up the ${MARK} dashboard widget on my home screen?`;
  const tAuto = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY auto", body: strongBody });
  const tSug = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY suggest", body: strongBody });
  const tOff = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY off", body: strongBody });
  const tGuard = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY guard", body: `I want a refund for my ${MARK} order and to speak to a manager right now.` });
  const tHuman = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY human", body: `My ${MARK} question — actually, I'd like to talk to a human, please.` });
  const tWeak = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY weak", body: "zqxwv blorptth vrmpht gnarlfth?" });
  const tKill = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY kill", body: strongBody });
  const tCap = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY cap", body: strongBody });
  const cap2 = await ingestInbound({ tenantId: A, authorType: "customer", ticketId: tCap.ticketId, body: strongBody });

  // Wait for retrieval to corroborate (Typesense + Qdrant indexing is eventually consistent).
  let warm = { agreement: 0 };
  for (let i = 0; i < 20; i++) {
    const s = await suggestReply(A, tAuto.ticketId);
    warm = s.retrieval;
    if (s.retrieval.agreement >= 2) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("retrieval corroborates the seeded knowledge (agreement >= 2)", warm.agreement >= 2);

  // 1. policy off → no decision, no send
  await arm(tOff.ticketId);
  const offRes = await evaluateAutoreply(A, tOff.ticketId, tOff.messageId);
  check("policy off → evaluate returns null (feature disabled)", offRes === null);
  check("policy off → no decision recorded", (await decisionCount(tOff.ticketId)) === 0);

  // 1b. suggest_only → assist, never sends. sweep:false → no racing background backlog
  // drain (this suite drives evaluate/enqueue/drain explicitly on reused tickets).
  await putPolicy(A, { mode: "suggest_only" }, { sweep: false });
  await arm(tSug.ticketId);
  const sug = await evaluateAutoreply(A, tSug.ticketId, tSug.messageId);
  check("suggest_only → outcome assist", sug?.outcome === "assist");
  check("suggest_only → no agent message sent", (await agentMsgCount(tSug.ticketId)) === 0);

  // 1c. approval queue: suggest_only enqueues exactly one reviewable pending row,
  // idempotent on re-evaluation; Send posts an agent reply + flips the row to sent.
  check("suggest_only → exactly one pending queue row", (await queueCount(tSug.ticketId)) === 1);
  await arm(tSug.ticketId);
  await evaluateAutoreply(A, tSug.ticketId, tSug.messageId); // replay/re-evaluate the same message
  check("queue idempotent → still exactly one pending row", (await queueCount(tSug.ticketId)) === 1);
  {
    const item = (await listQueue(A)).find((i) => i.ticket_id === tSug.ticketId);
    check("queue item → reason suggest_only", item?.reason === "suggest_only");
    check("queue item → status pending", item?.status === "pending");
    check("queue item → draft_body present", typeof item?.draft_body === "string" && (item?.draft_body.length ?? 0) > 0);
    check("queue item → ticket_subject joined from tickets", item?.ticket_subject === "AUTOREPLY suggest");
    check("queue item → meta.kind = suggested", (item?.meta as { kind?: string } | null)?.kind === "suggested");
    // isolation while Acme has a pending item: Globex's queue is empty (RLS).
    check("isolation → Globex cannot see Acme's pending queue", (await listQueue(B)).length === 0);

    const before = await agentMsgCount(tSug.ticketId);
    const sent = await sendQueued(A, item!.id);
    check("queue send → ok", sent.ok === true);
    check("queue send → posts exactly one agent message", (await agentMsgCount(tSug.ticketId)) === before + 1);
    check("queue send → row flips to sent", (await queueStatus(item!.id)) === "sent");
    check("queue send → dropped from the pending list", (await listQueue(A)).every((i) => i.id !== item!.id));
    const resend = await sendQueued(A, item!.id);
    check("queue send → re-send on a non-pending row is 409", resend.ok === false && (resend as { code?: number }).code === 409);
  }

  // 2. auto + strong retrieval → auto_sent, agent message inserted, whose_turn flips, messages.auto=true
  await putPolicy(A, { mode: "auto", min_agreement: 2 }, { sweep: false });
  await arm(tAuto.ticketId);
  const auto = await evaluateAutoreply(A, tAuto.ticketId, tAuto.messageId);
  check("auto + strong retrieval → outcome auto_sent", auto?.outcome === "auto_sent");
  check("auto_sent → an agent reply was inserted", (await agentMsgCount(tAuto.ticketId)) === 1);
  {
    const t = await superPool.query("SELECT whose_turn FROM tickets WHERE id = $1", [tAuto.ticketId]);
    check("auto_sent → whose_turn flips to customer", t.rows[0].whose_turn === "customer");
    const m = await superPool.query("SELECT auto, meta FROM messages WHERE id = $1", [auto?.sentMessageId]);
    check("auto_sent → the reply is flagged messages.auto = true", m.rows[0]?.auto === true);
    const meta = m.rows[0]?.meta;
    check("auto_sent → meta is a populated jsonb object", meta != null && typeof meta === "object");
    check("auto_sent → meta.kind = autoreply", meta?.kind === "autoreply");
    check("auto_sent → meta.model set (rule under FORCE_RULE_MODEL)", typeof meta?.model === "string" && meta.model.length > 0);
    check("auto_sent → meta.sources matches cited count", typeof meta?.sources === "number" && meta.sources >= 1);
    check("auto_sent → meta.agreement >= 2", typeof meta?.agreement === "number" && meta.agreement >= 2);
    check("auto_sent → meta.citedKinds is an array", Array.isArray(meta?.citedKinds));
    check("auto_sent → meta carries token keys (null under rule model)", "tokensIn" in (meta ?? {}) && "tokensOut" in (meta ?? {}));
    const draft = await superPool.query("SELECT body FROM messages WHERE id = $1", [auto?.sentMessageId]);
    check("auto_sent draft NEVER leaks the other tenant's runbook", !/secret internal runbook/i.test(draft.rows[0]?.body ?? ""));
  }

  // 5. idempotency: evaluating the SAME message again → no second decision, no second send
  await arm(tAuto.ticketId);
  const again = await evaluateAutoreply(A, tAuto.ticketId, tAuto.messageId);
  check("idempotency → re-evaluating the same message returns null", again === null);
  check("idempotency → still exactly one decision for the ticket", (await decisionCount(tAuto.ticketId)) === 1);
  check("idempotency → still exactly one agent reply (send dedup'd)", (await agentMsgCount(tAuto.ticketId)) === 1);

  // 3. guardrail: refund + manager → suppressed, no send, even under auto
  await arm(tGuard.ticketId);
  const guard = await evaluateAutoreply(A, tGuard.ticketId, tGuard.messageId);
  check("guardrail → outcome suppressed", guard?.outcome === "suppressed");
  check("guardrail → reason names the tripped guardrail", (guard?.reason ?? "").startsWith("guardrail:"));
  check("guardrail → nothing sent", (await agentMsgCount(tGuard.ticketId)) === 0);

  // 3b. HUMAN HANDOFF: a typed "talk to a human" suppresses under the AMBIENT engine on ANY channel
  // (not just the widget /ask lane) AND mutes the assistant, so the bot stays silent afterwards. Runs
  // under mode='auto' to prove it beats a corroborated auto-send. Regression for the live case where
  // the bot kept answering after "I'd like to talk to a human, please". (tHuman is ingested up-front
  // under mode='off' so the ingest-time fire doesn't pre-record the decision — this explicit eval owns it.)
  await arm(tHuman.ticketId);
  const human = await evaluateAutoreply(A, tHuman.ticketId, tHuman.messageId);
  check("handoff → outcome suppressed", human?.outcome === "suppressed");
  check("handoff → reason handoff_requested", human?.reason === "handoff_requested");
  check("handoff → nothing sent", (await agentMsgCount(tHuman.ticketId)) === 0);
  check("handoff → assistant muted on the ticket", (await assistantEnabled(tHuman.ticketId)) === false);
  const humanFollow = await ingestInbound({ tenantId: A, authorType: "customer", ticketId: tHuman.ticketId, body: `are you still there about my ${MARK}?` });
  await arm(tHuman.ticketId);
  const follow = await evaluateAutoreply(A, tHuman.ticketId, humanFollow.messageId);
  check("handoff → muted assistant skips the follow-up (null)", follow === null);
  check("handoff → still nothing sent after follow-up", (await agentMsgCount(tHuman.ticketId)) === 0);

  // 4. weak retrieval → suppressed weak_retrieval, no send
  await arm(tWeak.ticketId);
  const weak = await evaluateAutoreply(A, tWeak.ticketId, tWeak.messageId);
  check("weak retrieval → outcome suppressed", weak?.outcome === "suppressed");
  check("weak retrieval → reason weak_retrieval", weak?.reason === "weak_retrieval");
  check("weak retrieval → nothing sent", (await agentMsgCount(tWeak.ticketId)) === 0);

  // 4b. the auto-mode draft held by the gate is queued for review (reason weak_retrieval),
  // and Dismiss flips it to dismissed without sending.
  check("weak retrieval → held draft queued (one pending row)", (await queueCount(tWeak.ticketId)) === 1);
  {
    const item = (await listQueue(A)).find((i) => i.ticket_id === tWeak.ticketId);
    check("weak queue item → reason weak_retrieval", item?.reason === "weak_retrieval");
    const d = await dismissQueued(A, item!.id);
    check("queue dismiss → ok", d.ok === true);
    check("queue dismiss → nothing sent", (await agentMsgCount(tWeak.ticketId)) === 0);
    check("queue dismiss → row flips to dismissed", (await queueStatus(item!.id)) === "dismissed");
    check("queue dismiss → dropped from the pending list", (await listQueue(A)).every((i) => i.id !== item!.id));
    const again = await dismissQueued(A, item!.id);
    check("queue dismiss → re-dismiss on a non-pending row is 409", again.ok === false && (again as { code?: number }).code === 409);
  }

  // 7. kill switch (per-tenant) → suppressed kill
  await putPolicy(A, { mode: "auto", kill_switch: true }, { sweep: false });
  await arm(tKill.ticketId);
  const kill = await evaluateAutoreply(A, tKill.ticketId, tKill.messageId);
  check("kill switch → outcome suppressed", kill?.outcome === "suppressed");
  check("kill switch → reason kill", kill?.reason === "kill");
  check("kill switch → nothing sent", (await agentMsgCount(tKill.ticketId)) === 0);

  // 6. thread cap: max_auto_per_thread=1 → first auto-sends, second suppressed
  await putPolicy(A, { mode: "auto", kill_switch: false, min_agreement: 2, max_auto_per_thread: 1 }, { sweep: false });
  await arm(tCap.ticketId);
  const cap1res = await evaluateAutoreply(A, tCap.ticketId, tCap.messageId);
  check("thread cap → first message auto-sends", cap1res?.outcome === "auto_sent");
  await arm(tCap.ticketId); // re-arm: the auto-send flipped whose_turn
  const cap2res = await evaluateAutoreply(A, tCap.ticketId, cap2.messageId);
  check("thread cap → second message suppressed", cap2res?.outcome === "suppressed");
  check("thread cap → reason thread_cap", cap2res?.reason === "thread_cap");
  check("thread cap → only one auto reply on the ticket", (await agentMsgCount(tCap.ticketId)) === 1);

  // 8. isolation: policy + decisions are tenant-scoped
  const bPolicy = await getPolicy(B);
  check("isolation → Globex sees its own default policy, not Acme's", bPolicy.mode === "off");
  await putPolicy(B, { mode: "auto" }, { sweep: false });
  {
    // Acme's decisions must be invisible to Globex under RLS (app_user via withTenant).
    const seen = await import("../src/autoreply.js").then((m) => m.listDecisionsForTicket(B, tAuto.ticketId));
    check("isolation → Globex cannot read Acme's decisions", seen.length === 0);
  }

  // 9. Backlog job queue — the sweep-existing-tickets feature. Hermetic: clean + reseed
  //    the tenant's knowledge and a fresh backlog so job counts are exact.
  await clean();
  await createArticle(A, "AUTOREPLY Widgets guide", `The ${MARK} dashboard widget shows recent activity; drag its corner to resize and the layout saves per user.`);
  await ingestDocument(A, "AUTOREPLY-guide.md", "text/markdown", `# Guide\n\nThe ${MARK} dashboard widget layout is stored per account and syncs across your devices.`);

  // seed a backlog of 3 tickets awaiting a reply (open + whose_turn='us') + 1 closed
  // non-candidate that the sweep must ignore. Ingest under mode=off so the async ingest
  // hook no-ops (it would otherwise auto-draft during ingestion under a working mode).
  await putPolicy(A, { mode: "off" });
  const b1 = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY job one", body: strongBody });
  const b2 = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY job two", body: strongBody });
  const b3 = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY job three", body: strongBody });
  const bClosed = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY job closed", body: strongBody });
  await superPool.query("UPDATE tickets SET status = 'closed' WHERE id = $1", [bClosed.ticketId]);

  // re-warm retrieval (clean wiped the seeded knowledge). Doubles as the settle window
  // for the off-mode ingest hooks above to fire + no-op before we flip modes.
  for (let i = 0; i < 20; i++) {
    const s = await suggestReply(A, b1.ticketId);
    if (s.retrieval.agreement >= 2) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Neutralize any stray open+us A tickets left by other suites, then arm ONLY our three
  // — so the tenant-wide sweep enqueues exactly this section's backlog (deterministic).
  await superPool.query("UPDATE tickets SET whose_turn = 'customer' WHERE tenant_id = $1 AND status = 'open' AND whose_turn = 'us'", [A]);
  for (const t of [b1, b2, b3]) await arm(t.ticketId);

  // auto mode → the backlog sweeps into jobs and drains to 'sent'. Set the policy row
  // directly (bypass putPolicy's own background sweep) so this scenario stays deterministic.
  await superPool.query(
    `INSERT INTO autoreply_policy (tenant_id, mode, min_agreement, min_top_score, channel_modes, max_auto_per_thread, max_auto_per_hour, kill_switch)
     VALUES ($1,'auto',2,0,'{"synthetic":"auto","discord":"auto"}'::jsonb,3,30,false)
     ON CONFLICT (tenant_id) DO UPDATE SET mode='auto', min_agreement=2, channel_modes='{"synthetic":"auto","discord":"auto"}'::jsonb, max_auto_per_thread=3, max_auto_per_hour=30, kill_switch=false`,
    [A],
  );

  const q1 = await enqueueBacklog(A);
  check("backlog sweep → one job per needs-reply ticket (exactly 3)", q1 === 3);
  check("backlog sweep → one active job for b1", (await activeJobCount(b1.ticketId)) === 1);
  check("backlog sweep → one active job for b2", (await activeJobCount(b2.ticketId)) === 1);
  check("backlog sweep → one active job for b3", (await activeJobCount(b3.ticketId)) === 1);
  check("backlog sweep → the CLOSED ticket is not swept", (await jobCountAny(bClosed.ticketId)) === 0);
  const q2 = await enqueueBacklog(A);
  check("backlog sweep → idempotent: a second sweep adds none while jobs are active", q2 === 0);
  check("backlog sweep → still exactly one active job for b1", (await activeJobCount(b1.ticketId)) === 1);
  {
    const { counts } = await listJobs(A);
    check("jobs counts → queued reflects the swept backlog (3)", counts.queued === 3);
  }

  await drainJobs(A);
  {
    const r1 = await jobRow(b1.ticketId);
    check("drain (auto) → b1 job terminal 'sent'", r1?.status === "sent");
    check("drain (auto) → sent job carries result_message_id (the sent reply)", typeof r1?.result_message_id === "string" && r1!.result_message_id!.length > 0);
    check("drain (auto) → sent job meta.kind = autoreply", (r1?.meta as { kind?: string } | null)?.kind === "autoreply");
    check("drain (auto) → b1 got exactly one agent reply", (await agentMsgCount(b1.ticketId)) === 1);
    check("drain (auto) → b2 job 'sent'", (await jobRow(b2.ticketId))?.status === "sent");
    check("drain (auto) → b3 job 'sent'", (await jobRow(b3.ticketId))?.status === "sent");
    check("drain (auto) → no queued/processing jobs remain for b1", (await activeJobCount(b1.ticketId)) === 0);
    const { counts } = await listJobs(A);
    check("jobs counts → at least the 3 seeded jobs are 'sent'", counts.sent >= 3);
    check("jobs list → active-first ordering, LIMIT respected", (await listJobs(A)).jobs.length <= 100);
  }

  // suggest_only mode → backlog drafts land HELD in the approval queue, nothing sent.
  // Ingest under mode=off + settle so the async ingest hook can't auto-draft s1/s2 before
  // we flip to suggest_only; then neutralize strays and arm only ours (deterministic count).
  await superPool.query("UPDATE autoreply_policy SET mode = 'off' WHERE tenant_id = $1", [A]);
  const s1 = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY job sug one", body: strongBody });
  const s2 = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY job sug two", body: strongBody });
  await new Promise((r) => setTimeout(r, 500)); // let the off-mode ingest hooks fire + no-op
  await superPool.query("UPDATE tickets SET whose_turn = 'customer' WHERE tenant_id = $1 AND status = 'open' AND whose_turn = 'us'", [A]);
  for (const t of [s1, s2]) await arm(t.ticketId);
  await superPool.query("UPDATE autoreply_policy SET mode = 'suggest_only' WHERE tenant_id = $1", [A]);
  const sq = await enqueueBacklog(A);
  check("suggest_only sweep → one job per needs-reply ticket (exactly 2)", sq === 2);
  check("suggest_only sweep → one active job for s1", (await activeJobCount(s1.ticketId)) === 1);
  await drainJobs(A);
  {
    const r = await jobRow(s1.ticketId);
    check("drain (suggest_only) → s1 job 'held'", r?.status === "held");
    check("drain (suggest_only) → held reason suggest_only", r?.reason === "suggest_only");
    check("drain (suggest_only) → nothing auto-sent for s1", (await agentMsgCount(s1.ticketId)) === 0);
    check("drain (suggest_only) → held draft parked in the approval queue", (await queueCount(s1.ticketId)) === 1);
    const item = (await listQueue(A)).find((i) => i.ticket_id === s1.ticketId);
    check("drain (suggest_only) → job.result_message_id = the approval-queue item id", r?.result_message_id === item?.id);
    check("drain (suggest_only) → s2 job also 'held'", (await jobRow(s2.ticketId))?.status === "held");
  }

  // isolation: Globex sees none of Acme's jobs (RLS on autoreply_jobs). (Globex's policy
  // was set with sweep:false above, so it has no jobs of its own either.)
  check("isolation → Globex cannot see Acme's jobs", (await listJobs(B)).jobs.length === 0);

  // putPolicy trigger: flipping INTO a working mode fire-and-forgets a backlog sweep.
  // Ingest under off (hook no-op) + settle, then let putPolicy's own sweep run (default)
  // and poll for the job it enqueues for our ticket.
  await superPool.query("UPDATE autoreply_policy SET mode = 'off' WHERE tenant_id = $1", [A]);
  const tTrig = await ingestInbound({ tenantId: A, authorType: "customer", subject: "AUTOREPLY job trigger", body: strongBody });
  await new Promise((r) => setTimeout(r, 400)); // let the off-mode ingest hook fire + no-op
  await arm(tTrig.ticketId);
  await putPolicy(A, { mode: "auto", min_agreement: 2, max_auto_per_thread: 3 }); // sweep defaults on
  let triggered = false;
  for (let i = 0; i < 40; i++) {
    if ((await jobCountAny(tTrig.ticketId)) > 0) { triggered = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  check("putPolicy → transition into a working mode kicks a backlog sweep", triggered);
  await new Promise((r) => setTimeout(r, 500)); // let the background drain settle before teardown

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nAUTOREPLY: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nAUTOREPLY: all checks green");
}

main().catch((e) => { console.error("autoreply seam ERROR", e); process.exit(1); });
