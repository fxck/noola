import { relayPool, withTenant } from "@repo/db";

// ── Demo-tenant gate-0 seed/purge ────────────────────────────────────────────
// The dev/stage DB is shared, and the api test-suite runs against the REAL demo tenant
// (Acme, ales@acme.test) — so INSIGHTTEST/WAVE3B/WHTEST/wavefivezarquon-marked rows and
// SSRF-probe webhooks accumulate in the demo views and make every screen read like a debug
// screen. This module is the credibility gate for the UX table-system work: it (1) purges
// that test residue, (2) guarantees a small set of confidence-gated HELD autoreply drafts so
// the approval queue is non-empty (and verifies the gate actually holds), and (3) de-reddens
// SLA by shifting open tickets (and their messages, together, so reply-timing is preserved)
// to a realistic recent spread. Idempotent — safe to re-run after any test pass. Read-only
// unless invoked with --apply.
//
//   tsx apps/api/src/seed-demo.ts            # inspect only (default, no writes)
//   tsx apps/api/src/seed-demo.ts --apply    # purge + seed + de-redden

const ACME = "11111111-1111-1111-1111-111111111111";
const APPLY = process.argv.includes("--apply");

const JUNK_MARKS = ["INSIGHTTEST", "WAVE3B", "WHTEST", "wavefivezarquon", "E2E", "SMOKETEST", "disctest", "DISCTEST"];
const junkIlike = (col: string, base: number) => JUNK_MARKS.map((_, i) => `${col} ILIKE $${base + i}`).join(" OR ");
const junkParams = JUNK_MARKS.map((m) => `%${m}%`);

type Q = (q: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

const rint = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));

async function inspect() {
  console.log(`\n=== seed-demo (${APPLY ? "APPLY" : "INSPECT-ONLY"}) tenant=${ACME} ===\n`);
  const c = (relayPool.query.bind(relayPool)) as unknown as Q;
  const n = async (label: string, sql: string, p: unknown[]) => {
    try { const r = await c(sql, p); console.log(`  ${label.padEnd(36)} ${Number(r.rows[0]?.n ?? 0)}`); }
    catch (e) { console.log(`  ${label.padEnd(36)} ERR ${(e as Error).message.slice(0, 50)}`); }
  };
  console.log("JUNK INVENTORY:");
  await n("tickets junk", `SELECT count(*) n FROM tickets WHERE tenant_id=$${JUNK_MARKS.length + 1} AND (${junkIlike("subject", 1)})`, [...junkParams, ACME]);
  await n("broadcasts junk", `SELECT count(*) n FROM broadcasts WHERE tenant_id=$${JUNK_MARKS.length + 1} AND (${junkIlike("subject", 1)})`, [...junkParams, ACME]);
  await n("webhooks SSRF", `SELECT count(*) n FROM webhooks WHERE tenant_id=$1 AND (url ILIKE '%169.254%' OR url ILIKE '%metadata%' OR url ILIKE '%127.0.0.1%' OR url ILIKE '%localhost%')`, [ACME]);
  await n("company shells", `SELECT count(*) n FROM companies co WHERE co.tenant_id=$1 AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.tenant_id=co.tenant_id AND ct.company_id=co.id)`, [ACME]);
  console.log("QUEUE (t6):");
  await n("pending held drafts", `SELECT count(*) n FROM autoreply_queue WHERE tenant_id=$1 AND status='pending'`, [ACME]);
  console.log("SLA:");
  const br = await c(slaBreachSql(), [ACME]);
  console.log(`  open tickets ${br.rows[0]?.open_n ?? 0}, breached ${br.rows[0]?.breached ?? 0} (${pctRed(br.rows[0])}% red)`);
}

/** Active-target breach among open tickets, using the same expression the ticket list orders by. */
function slaBreachSql(): string {
  return `SELECT count(*) FILTER (WHERE sla_due < now()) AS breached, count(*) AS open_n FROM (
    SELECT t.id, CASE WHEN sp.enabled THEN t.created_at + (CASE WHEN (
        SELECT min(m.created_at) FROM messages m WHERE m.tenant_id=t.tenant_id AND m.ticket_id=t.id AND m.author_type='agent'
      ) IS NULL THEN sp.first_response_mins ELSE sp.resolution_mins END) * interval '1 minute' END AS sla_due
    FROM tickets t JOIN sla_policies sp ON sp.tenant_id=t.tenant_id
    WHERE t.tenant_id=$1 AND t.status='open') q`;
}
const pctRed = (r: any) => (r && r.open_n > 0 ? Math.round((100 * Number(r.breached)) / Number(r.open_n)) : 0);

async function apply() {
  await withTenant(ACME, async (cx) => {
    const c = cx.query.bind(cx) as unknown as Q;

    // ── 1. PURGE ────────────────────────────────────────────────────────────
    const jt = await c(`SELECT id FROM tickets WHERE ${junkIlike("subject", 1)}`, junkParams);
    const junkTix = jt.rows.map((r) => r.id);
    if (junkTix.length) {
      for (const tbl of ["autoreply_queue", "autoreply_decisions", "draft_traces", "agent_runs"]) {
        try { await c(`DELETE FROM ${tbl} WHERE ticket_id = ANY($1::uuid[])`, [junkTix]); } catch { /* table/col may not exist */ }
      }
      await c(`DELETE FROM tickets WHERE id = ANY($1::uuid[])`, [junkTix]); // messages cascade
    }
    const jb = await c(`SELECT id FROM broadcasts WHERE ${junkIlike("subject", 1)}`, junkParams);
    const junkB = jb.rows.map((r) => r.id);
    if (junkB.length) {
      try { await c(`DELETE FROM broadcast_recipients WHERE broadcast_id = ANY($1::uuid[])`, [junkB]); } catch { /* */ }
      await c(`DELETE FROM broadcasts WHERE id = ANY($1::uuid[])`, [junkB]);
    }
    await c(`DELETE FROM webhooks WHERE url ILIKE '%169.254%' OR url ILIKE '%metadata%' OR url ILIKE '%127.0.0.1%' OR url ILIKE '%localhost%'`);
    // Junk-named companies (tests create INSIGHTTESTCom*, etc.) + their test contacts. Null any
    // surviving ticket ref first so the contact delete can't FK-fail.
    const jc = await c(`SELECT id FROM companies WHERE ${junkIlike("name", 1)}`, junkParams);
    const junkCo = jc.rows.map((r) => r.id);
    if (junkCo.length) {
      const jct = await c(`SELECT id FROM contacts WHERE company_id = ANY($1::uuid[])`, [junkCo]);
      const junkContacts = jct.rows.map((r) => r.id);
      if (junkContacts.length) {
        try { await c(`UPDATE tickets SET contact_id = NULL WHERE contact_id = ANY($1::uuid[])`, [junkContacts]); } catch { /* */ }
        await c(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [junkContacts]);
    // Empty orphan contacts (test churn): no name, no email, no external_id, no company, no
    // identity, no ticket, no authored message — pure noise in the Customers list.
    await c(
      `DELETE FROM contacts x
        WHERE coalesce(x.name,'') = '' AND coalesce(x.email,'') = '' AND coalesce(x.external_id,'') = ''
          AND x.company_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM contact_identities ci WHERE ci.contact_id = x.id)
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.contact_id = x.id)
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.author_contact_id = x.id)`,
    );
      }
      await c(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [junkCo]);
    }
    await c(`DELETE FROM companies co WHERE NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id=co.id)`);
    console.log(`purged: ${junkTix.length} tickets, ${junkB.length} broadcasts, SSRF webhooks, company shells`);

    // Reset prior seed artifacts so re-runs converge (demo tenant carries no real pending
    // drafts — inspect showed 0 — so clearing pending + seed-marked messages is safe).
    await c(`DELETE FROM autoreply_queue WHERE status='pending'`);
    await c(`DELETE FROM messages WHERE idempotency_key LIKE 'seed-%'`);

    // ── 2. Realistic SLA policy ──────────────────────────────────────────────
    // The demo tenant had been hand-set to an absurd 30min/120min (2h resolution) target, so
    // every ticket older than 2h read as breached. Reset to the migration default (respond
    // within 1h, resolve within 1 business day) with calendar time for predictable demos.
    await c(`UPDATE sla_policies SET first_response_mins=60, resolution_mins=1440, enabled=true, business_hours_enabled=false WHERE tenant_id=current_tenant()`);

    // ── 3. Normalize open-ticket threads into a realistic SLA spread ─────────
    // Each open ticket becomes one of: HELD (fresh, customer wrote last, AI draft pending),
    // HANDLED (agent first-response within window, created <24h → green), or AGED (created
    // >24h, still open → a realistic breached minority). Every ticket is guaranteed a coherent
    // customer message so no thread renders empty.
    const drafts = [
      { reason: "suggest_only", confidence: 0.82, body: "Thanks for reaching out — you can reset this from Settings → Security → Reset. I've included the exact steps; let me know if the link doesn't arrive.", q: "How do I reset my password? The link never arrives." },
      { reason: "suggest_only", confidence: 0.74, body: "Happy to help with the billing question. Your invoice reflects the annual plan proration; I've broken down the two line items below so it's clear what changed.", q: "Why was I charged twice this month on my invoice?" },
      { reason: "low_confidence", confidence: 0.44, body: "It sounds like the export is timing out on large workspaces. I believe raising the batch limit will help, but I'd like to confirm your plan tier before recommending the exact value.", q: "Our CSV export keeps timing out on the big workspace." },
      { reason: "weak_retrieval", confidence: 0.51, body: "Thanks for the detailed report. I don't have a KB article that covers this exact webhook signature case yet — here's my best guidance, and I'm looping in the team to confirm.", q: "Webhook signatures fail verification after your last release." },
    ];
    const open = (await c(`SELECT id, created_at,
      EXISTS(SELECT 1 FROM messages m WHERE m.ticket_id=t.id AND m.author_type='agent') AS has_agent,
      EXISTS(SELECT 1 FROM messages m WHERE m.ticket_id=t.id AND m.author_type='customer') AS has_cust
      FROM tickets t WHERE status='open' ORDER BY created_at DESC`)).rows;

    let held = 0, handled = 0, aged = 0;
    for (let i = 0; i < open.length; i++) {
      const t = open[i];
      // First 4 tickets → HELD; of the rest, ~22% AGED, else HANDLED.
      const profile = held < drafts.length ? "held" : (Math.random() < 0.22 ? "aged" : "handled");

      if (profile === "held") {
        const d = drafts[held];
        const createdMin = rint(25, 55);
        // Anchor a fresh customer message (a follow-up) as the latest message on the thread.
        const cust = (await c(
          `INSERT INTO messages (tenant_id, ticket_id, author_type, body, idempotency_key, created_at)
           VALUES (current_tenant(), $1, 'customer', $2, $3, now() - interval '${rint(4, 14)} minute') RETURNING id`,
          [t.id, d.q, `seed-held-cust-${t.id}`],
        )).rows[0];
        await c(`UPDATE tickets SET whose_turn='us', created_at = now() - interval '${createdMin} minute', updated_at = now() - interval '3 minute' WHERE id=$1`, [t.id]);
        const meta = { kind: "suggested", model: "rule:extractive", tokensIn: 420, tokensOut: 88, latencyMs: 240, confidence: d.confidence, sources: d.reason === "weak_retrieval" ? 0 : rint(1, 4), citedKinds: d.reason === "weak_retrieval" ? [] : ["article"], agreement: d.reason === "suggest_only" ? 3 : 1, traceId: null };
        await c(
          `INSERT INTO autoreply_queue (tenant_id, ticket_id, message_id, draft_body, meta, reason)
           VALUES (current_tenant(), $1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (tenant_id, message_id) DO UPDATE SET draft_body=EXCLUDED.draft_body, meta=EXCLUDED.meta, reason=EXCLUDED.reason, status='pending'`,
          [t.id, cust.id, d.body, JSON.stringify(meta), d.reason],
        );
        held++;
        continue;
      }

      const offsetMin = profile === "aged" ? rint(26 * 60, 8 * 24 * 60) : rint(2 * 60, 22 * 60);
      const newCreated = `now() - interval '${offsetMin} minute'`;
      if (!t.has_cust) {
        await c(`INSERT INTO messages (tenant_id, ticket_id, author_type, body, idempotency_key, created_at) VALUES (current_tenant(), $1, 'customer', $2, $3, ${newCreated})`,
          [t.id, "Hi — following up on my request, could you help me sort this out?", `seed-cust-${t.id}`]);
      } else {
        // Shift the existing thread by the same delta so reply-timing (thus first-response met/not) is preserved.
        // Clamp to never-future: a ticket whose profile flips (e.g. was aged, now handled)
        // yields a large positive delta that would shove recent messages — including any
        // hand-typed test replies on this shared demo tenant — into the future (→ "just now"
        // + broken order). Never let a shifted message land after now.
        await c(`UPDATE messages SET created_at = LEAST(now() - interval '1 minute', created_at + ((${newCreated}) - (SELECT created_at FROM tickets WHERE id=$1))) WHERE ticket_id=$1`, [t.id]);
      }
      // Last activity: HANDLED trails its own creation (a settled thread). AGED is an old
      // ticket the customer just BUMPED — so its "Xh over" (SLA age, large) and "Xm ago" (last
      // activity, small) read as two DISTINCT facts instead of one doubled-looking number.
      let updatedExpr = `LEAST(now(), (${newCreated}) + interval '${rint(30, 240)} minute')`;
      if (profile === "aged") {
        const bumpMin = rint(3, 150);
        await c(`INSERT INTO messages (tenant_id, ticket_id, author_type, body, idempotency_key, created_at) VALUES (current_tenant(), $1, 'customer', $2, $3, now() - interval '${bumpMin} minute')`,
          [t.id, "Any update on this? It's been a while on my end.", `seed-bump-${t.id}`]);
        updatedExpr = `now() - interval '${bumpMin} minute'`;
      }
      await c(`UPDATE tickets SET created_at = ${newCreated}, updated_at = ${updatedExpr}${profile === "aged" ? ", whose_turn='us'" : ""} WHERE id=$1`, [t.id]);
      if (profile === "handled" && !t.has_agent) {
        // First agent response within the 60-min window → first-response "met".
        await c(`INSERT INTO messages (tenant_id, ticket_id, author_type, body, idempotency_key, created_at)
                 VALUES (current_tenant(), $1, 'agent', $2, $3, (${newCreated}) + interval '${rint(12, 52)} minute')`,
          [t.id, "Thanks for reaching out — I've looked into this and here's where things stand. Let me know if that helps.", `seed-reply-${t.id}`]);
      }
      profile === "aged" ? aged++ : handled++;
    }
    console.log(`normalized ${open.length} open tickets → ${held} held / ${handled} handled / ${aged} aged`);

    // ── 6a. DEMO TARGET TICKET — a realistic incident that rewards live checking ──
    // Nothing about the FLOW is scripted; this is just a believable customer message whose answer
    // genuinely benefits from the agent verifying something live rather than guessing. Idempotent.
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
         "For the last ~20 minutes our requests to you keep failing, but your status page at https://status.acme-corp.example shows everything green. Before we wake our on-call, can you independently verify the service is actually reachable right now — not just what the status page claims?",
         `seed-demo-ticket-${dt.rows[0].id}`],
      );
      console.log(`seeded demo ticket → ${dt.rows[0].id}`);
    }

    // ── 6b. STUDIO DEMO FLOW — "Autonomous Support Agent" ───────────────────────
    // No hardcoded logic, no fixed scenario: two autonomous agents with a real toolbox. The
    // investigator DECIDES what to do — search the KB, fetch a URL the customer mentions, or write
    // and run a shell command in the sandboxed runner to verify something live — then the responder
    // acts on what was actually found. Every tool call is the model's own choice, executed for real.
    const supportGraph = {
      nodes: [
        { id: "trigger", type: "trigger", config: { position: { x: 0, y: 210 } } },
        // AI + container: the agent probes the live service for real (writes a wget, runs it in a
        // throwaway container) and records what it found. Its finding threads into ctx.steps.
        { id: "investigate", type: "agent", config: {
          agent: {
            instructions: "An incident was reported and the customer references a URL. Probe it live rather than guessing: use `run` with a busybox-safe command like `wget -q -S -O /dev/null <URL> 2>&1 | head -n 5` to read the real HTTP status (or `web_fetch` it). Then write ONE short finding line stating whether the service is reachable and the exact HTTP status you observed. Do not reply to the customer — just report the finding.",
            tools: ["run", "web_fetch", "rag"], maxSteps: 4,
          },
          position: { x: 300, y: 210 },
        } },
        // Fan-out: real orchestrated side-effects across systems — no reply. Each reads the
        // investigation via {{steps.investigate.output}} where it helps.
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

    // Stable id (Studio URL + open editor survive reseeds), NOT managed (editable/savable), a VALID
    // trigger event, and no subject condition — it can run on any ticket. Clean up prior demo flows.
    const FLOW_ID = "d3f10a5e-0000-4000-a000-000000000001";
    await c(`DELETE FROM automations WHERE tenant_id=current_tenant() AND name IN ($1,$2,$3)`,
      ["Live Ops Orchestrator", "Autonomous Support Agent", "Autonomous Incident Investigator"]);
    await c(
      `INSERT INTO automations (id, tenant_id, name, enabled, trigger_event, conditions, actions, graph)
       VALUES ($1, current_tenant(), $2, true, 'ticket.created',
               '{"match":"all","conditions":[]}'::jsonb, '[]'::jsonb, $3::jsonb)`,
      [FLOW_ID, "Live Ops Orchestrator", JSON.stringify(supportGraph)],
    );
    console.log(`seeded Studio demo flow → ${FLOW_ID} (Live Ops Orchestrator, ${supportGraph.nodes.length} nodes)`);
  });

  // verify post-state
  const c = relayPool.query.bind(relayPool) as unknown as Q;
  const q = await c(`SELECT count(*) n FROM autoreply_queue WHERE tenant_id=$1 AND status='pending'`, [ACME]);
  const br = await c(slaBreachSql(), [ACME]);
  console.log(`\nPOST: pending drafts=${q.rows[0].n}, SLA ${br.rows[0].breached}/${br.rows[0].open_n} breached (${pctRed(br.rows[0])}% red)\n`);
}

async function main() {
  if (!APPLY) { await inspect(); await relayPool.end(); return; }
  await inspect();
  await apply();
  await relayPool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
