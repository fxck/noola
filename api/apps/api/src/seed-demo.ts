import { authPool, relayPool, withTenant } from "@repo/db";
import { seedRichDemo } from "./seed-demo-data.js";

// Team-member (agent) portraits — stable, real-face avatars for Aleš and Sam.
const AGENT_AVATARS: [string, string][] = [
  ["a0000000-0000-0000-0000-000000000001", "https://i.pravatar.cc/200?img=13"], // Aleš
  ["a0000000-0000-0000-0000-000000000002", "https://i.pravatar.cc/200?img=52"], // Sam
];

// ── Demo-tenant seed (Acme, ales@acme.test) ──────────────────────────────────
// Rebuilds the demo workspace into rich, lived-in data — real companies, people,
// and a months-deep multi-channel ticket backlog (seed-demo-data.ts) — then layers
// on the demo highlights: a non-empty approval queue (confidence-gated HELD drafts),
// the live-check incident ticket, and the Studio demo flow. Idempotent — seedRichDemo
// purges its own prior output, so re-runs converge. Read-only unless --apply.
//
//   tsx apps/api/src/seed-demo.ts            # inspect counts only (no writes)
//   tsx apps/api/src/seed-demo.ts --apply    # rebuild the demo workspace

const ACME = "11111111-1111-1111-1111-111111111111";
const APPLY = process.argv.includes("--apply");

type Q = (q: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
const rint = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));

/** Active-target SLA breach among open tickets — same expression the ticket list orders by. */
function slaBreachSql(): string {
  return `SELECT count(*) FILTER (WHERE sla_due < now()) AS breached, count(*) AS open_n FROM (
    SELECT t.id, CASE WHEN sp.enabled THEN t.created_at + (CASE WHEN (
        SELECT min(m.created_at) FROM messages m WHERE m.tenant_id=t.tenant_id AND m.ticket_id=t.id AND m.author_type='agent'
      ) IS NULL THEN sp.first_response_mins ELSE sp.resolution_mins END) * interval '1 minute' END AS sla_due
    FROM tickets t JOIN sla_policies sp ON sp.tenant_id=t.tenant_id
    WHERE t.tenant_id=$1 AND t.status='open') q`;
}
const pctRed = (r: any) => (r && r.open_n > 0 ? Math.round((100 * Number(r.breached)) / Number(r.open_n)) : 0);

async function inspect() {
  console.log(`\n=== seed-demo (${APPLY ? "APPLY" : "INSPECT-ONLY"}) tenant=${ACME} ===\n`);
  const c = relayPool.query.bind(relayPool) as unknown as Q;
  const n = async (label: string, sql: string) => {
    try { const r = await c(sql, [ACME]); console.log(`  ${label.padEnd(24)} ${Number(r.rows[0]?.n ?? 0)}`); }
    catch (e) { console.log(`  ${label.padEnd(24)} ERR ${(e as Error).message.slice(0, 50)}`); }
  };
  await n("companies", `SELECT count(*) n FROM companies WHERE tenant_id=$1`);
  await n("contacts", `SELECT count(*) n FROM contacts WHERE tenant_id=$1`);
  await n("tickets", `SELECT count(*) n FROM tickets WHERE tenant_id=$1`);
  await n("  open", `SELECT count(*) n FROM tickets WHERE tenant_id=$1 AND status='open'`);
  await n("  closed", `SELECT count(*) n FROM tickets WHERE tenant_id=$1 AND status='closed'`);
  await n("messages", `SELECT count(*) n FROM messages WHERE tenant_id=$1`);
  await n("notes", `SELECT count(*) n FROM ticket_notes WHERE tenant_id=$1`);
  await n("csat", `SELECT count(*) n FROM csat_responses WHERE tenant_id=$1`);
  await n("pending drafts", `SELECT count(*) n FROM autoreply_queue WHERE tenant_id=$1 AND status='pending'`);
  try {
    const br = await c(slaBreachSql(), [ACME]);
    console.log(`  ${"SLA open/breached".padEnd(24)} ${br.rows[0]?.open_n ?? 0}/${br.rows[0]?.breached ?? 0} (${pctRed(br.rows[0])}% red)`);
  } catch { /* fresh DB */ }
}

// AI draft variants for the HELD approval queue — one per confidence-gate reason.
const DRAFTS = [
  { reason: "suggest_only", confidence: 0.82, body: "Thanks for reaching out — you can reset this from Settings → Security → Reset. I've included the exact steps; let me know if the link doesn't arrive." },
  { reason: "suggest_only", confidence: 0.74, body: "Happy to help with the billing question. Your invoice reflects the annual plan proration; I've broken down the two line items below so it's clear what changed." },
  { reason: "low_confidence", confidence: 0.44, body: "It sounds like the export is timing out on large workspaces. I believe raising the batch limit will help, but I'd like to confirm your plan tier before recommending the exact value." },
  { reason: "weak_retrieval", confidence: 0.51, body: "Thanks for the detailed report. I don't have a KB article that covers this exact webhook case yet — here's my best guidance, and I'm looping in the team to confirm." },
];

async function apply() {
  await withTenant(ACME, async (cx) => {
    const c = cx.query.bind(cx) as unknown as Q;

    // ── 1. Rich, lived-in demo dataset (purges its own prior output first) ────
    await seedRichDemo(c);

    // ── 1b. Team-member avatars (app plane — drives assignee + agents list) ───
    for (const [id, url] of AGENT_AVATARS) await c(`UPDATE users SET avatar_url=$1 WHERE id=$2`, [url, id]);

    // ── 2. Realistic SLA policy: respond within 1h, resolve within 1 business day ─
    await c(`UPDATE sla_policies SET first_response_mins=60, resolution_mins=1440, enabled=true, business_hours_enabled=false WHERE tenant_id=current_tenant()`);

    // ── 3. Confidence-gated HELD drafts on the freshest "awaiting us" tickets ──
    // Attach a pending AI suggestion to each one's latest customer message so the
    // approval queue is non-empty and the confidence gate visibly holds.
    const heldTix = (await c(`SELECT id FROM tickets WHERE status='open' AND whose_turn='us' ORDER BY created_at DESC LIMIT $1`, [DRAFTS.length])).rows;
    let held = 0;
    for (let i = 0; i < heldTix.length; i++) {
      const t = heldTix[i]; const d = DRAFTS[i];
      const msg = (await c(`SELECT id FROM messages WHERE ticket_id=$1 AND author_type='customer' ORDER BY created_at DESC LIMIT 1`, [t.id])).rows[0];
      if (!msg) continue;
      await c(`UPDATE tickets SET whose_turn='us', updated_at = now() - interval '3 minute' WHERE id=$1`, [t.id]);
      const meta = { kind: "suggested", model: "rule:extractive", tokensIn: 420, tokensOut: 88, latencyMs: 240, confidence: d.confidence, sources: d.reason === "weak_retrieval" ? 0 : rint(1, 4), citedKinds: d.reason === "weak_retrieval" ? [] : ["article"], agreement: d.reason === "suggest_only" ? 3 : 1, traceId: null };
      await c(
        `INSERT INTO autoreply_queue (tenant_id, ticket_id, message_id, draft_body, meta, reason)
         VALUES (current_tenant(), $1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (tenant_id, message_id) DO UPDATE SET draft_body=EXCLUDED.draft_body, meta=EXCLUDED.meta, reason=EXCLUDED.reason, status='pending'`,
        [t.id, msg.id, d.body, JSON.stringify(meta), d.reason],
      );
      held++;
    }
    console.log(`  held drafts: ${held}`);

    // ── 4. Demo target ticket — a realistic incident that rewards live checking ──
    const DEMO_SUBJECT = "Are you actually up? Status looks green but we're erroring";
    await c(`DELETE FROM tickets WHERE tenant_id=current_tenant() AND subject=$1`, [DEMO_SUBJECT]);
    const dcontact = await c(`SELECT id FROM contacts WHERE tenant_id=current_tenant() ORDER BY created_at ASC LIMIT 1`);
    if (dcontact.rows[0]) {
      const dt = await c(
        `INSERT INTO tickets (tenant_id, subject, channel_type, contact_id, status, priority, whose_turn, created_at, updated_at)
         VALUES (current_tenant(), $1, 'email', $2, 'open', 'high', 'us', now() - interval '32 minute', now() - interval '5 minute')
         RETURNING id`,
        [DEMO_SUBJECT, dcontact.rows[0].id],
      );
      await c(
        `INSERT INTO messages (tenant_id, ticket_id, author_type, body, idempotency_key, channel_type, created_at)
         VALUES (current_tenant(), $1, 'customer', $2, $3, 'email', now() - interval '32 minute')`,
        [dt.rows[0].id,
         "For the last ~20 minutes our requests to you keep failing, but your status page at https://webstage-561.prg1.zerops.app shows everything green. Before we wake our on-call, can you independently verify the service is actually reachable right now — not just what the status page claims?",
         `seed-demo-ticket-${dt.rows[0].id}`],
      );
      console.log(`  demo ticket → ${dt.rows[0].id}`);
    }

    // ── 5. Studio demo flow — "Live Ops Orchestrator" ───────────────────────────
    const supportGraph = {
      nodes: [
        { id: "trigger", type: "trigger", config: { position: { x: 0, y: 210 } } },
        { id: "investigate", type: "agent", config: {
          agent: {
            instructions: "An incident was reported and the customer references a URL. Probe it live rather than guessing: use `run` with a busybox-safe command like `wget -q -S -O /dev/null <URL> 2>&1 | head -n 5` to read the real HTTP status (or `web_fetch` it). Then write ONE short finding line stating whether the service is reachable and the exact HTTP status you observed. Do not reply to the customer — just report the finding.",
            tools: ["run", "web_fetch", "rag"], maxSteps: 4,
          },
          position: { x: 300, y: 210 },
        } },
        { id: "prioritize", type: "action", config: { action: { type: "set_priority", priority: "urgent" }, position: { x: 640, y: 60 } } },
        { id: "tag", type: "action", config: { action: { type: "add_tags", tags: ["incident", "auto-triaged"] }, position: { x: 640, y: 210 } } },
        { id: "logkb", type: "action", config: {
          action: {
            type: "kb_upsert",
            kbTitle: "Incident log — {{subject}}",
            kbBody: "Auto-logged by the Live Ops Orchestrator.\n\n**Customer report:**\n{{body}}\n\n**Live investigation:**\n{{steps.investigate.output}}",
          },
          position: { x: 980, y: 210 },
        } },
      ],
      edges: [
        { from: "trigger", to: "investigate" },
        { from: "investigate", to: "prioritize" },
        { from: "investigate", to: "tag" },
        { from: "investigate", to: "logkb" },
      ],
    };
    const FLOW_ID = "d3f10a5e-0000-4000-a000-000000000001";
    await c(`DELETE FROM automations WHERE tenant_id=current_tenant() AND name IN ($1,$2,$3)`,
      ["Live Ops Orchestrator", "Autonomous Support Agent", "Autonomous Incident Investigator"]);
    await c(
      `INSERT INTO automations (id, tenant_id, name, enabled, trigger_event, conditions, actions, graph)
       VALUES ($1, current_tenant(), $2, true, 'ticket.created',
               '{"match":"all","conditions":[]}'::jsonb, '[]'::jsonb, $3::jsonb)`,
      [FLOW_ID, "Live Ops Orchestrator", JSON.stringify(supportGraph)],
    );
    console.log(`  Studio flow → ${FLOW_ID} (Live Ops Orchestrator, ${supportGraph.nodes.length} nodes)`);
  });

  // Better-auth plane: the logged-in agent's own header/profile avatar (image column).
  for (const [id, url] of AGENT_AVATARS) {
    try { await authPool.query(`UPDATE "user" SET image=$1 WHERE id=$2`, [url, id]); } catch { /* auth db optional */ }
  }
}

async function main() {
  // Self-gate so the deploy initCommand can call this unconditionally: production
  // tiers set DISABLE_DEMO_SEED=1 and get no demo data; dev/stage/demo tiers seed.
  if (process.env.DISABLE_DEMO_SEED === "1") { console.log("DISABLE_DEMO_SEED=1 — skipping demo seed"); return; }
  if (!APPLY) { await inspect(); await relayPool.end(); return; }
  await inspect();
  console.log("\n--- applying ---");
  await apply();
  console.log("\n--- post ---");
  await inspect();
  await relayPool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
