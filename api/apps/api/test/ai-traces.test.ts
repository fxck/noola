import pg from "pg";
import { withTenant } from "@repo/db";
import { getTrace, listTicketTraces, recordDraftTrace } from "../src/trace.js";
import { getPolicies, putPolicies, runTraceRetentionSweep, TRACE_RETENTION_DEFAULT_DAYS } from "../src/governance.js";
import { routeFloor } from "../src/rbac.js";
import { ingestInbound } from "../src/ingest.js";
import { getContainment } from "../src/analytics.js";

// The admin AI trace viewer and trace retention. TRACETEST data on the dev DB, removed at the end.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex, which never sets a trace retention here
const log = { info: () => {}, warn: () => {}, error: () => {} };

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
  const clean = async () => {
    await superPool.query("DELETE FROM draft_traces WHERE query LIKE 'TRACETEST%'");
    await superPool.query("DELETE FROM messages WHERE ticket_id IN (SELECT id FROM tickets WHERE external_channel_id = 'tracetest')");
    await superPool.query("DELETE FROM tickets WHERE external_channel_id = 'tracetest'");
    await superPool.query("DELETE FROM draft_trace_counts WHERE tenant_id = $1", [A]);
  };
  await clean();
  const policiesBefore = await getPolicies(A);
  // The sweep counts Globex's old test trace into its daily counts, which are put back afterwards.
  const globexCounts = (await superPool.query("SELECT day, drafts, deflected FROM draft_trace_counts WHERE tenant_id = $1", [B])).rows;
  const trace = (tenantId: string, ticketId: string | null, draft: string) =>
    recordDraftTrace({
      tenantId, ticketId, messageId: null, query: "TRACETEST bye", sources: [{ kind: "kb", id: "a1", title: "Guide", score: 0.8, rank: 0 }],
      retrieval: { topScore: 0.8, agreement: 1 }, draft, model: "custom:tracetest", embedModel: "tracetest-embed", confidence: 0.7,
      tokensIn: 10, tokensOut: 5, latencyMs: 12, source: "live",
    });
  const age = (id: string | null, days: number) => superPool.query("UPDATE draft_traces SET created_at = now() - make_interval(days => $2) WHERE id = $1", [id, days]);
  const exists = async (id: string | null) => (await superPool.query("SELECT 1 FROM draft_traces WHERE id = $1", [id])).rowCount === 1;

  try {
    // The viewer shows what the model wrote and what Noola made of it, also for a draft that sent nothing.
    const opened = await ingestInbound({
      tenantId: A, body: "TRACETEST bye", authorType: "customer", channelType: "synthetic",
      externalChannelId: "tracetest", identity: { externalId: "tracetest-cust" }, idempotencyKey: "tracetest:1", skipAutoreply: true,
    });
    const quiet = await trace(A, opened.ticketId, "<no_reply/>\n<internal>They said goodbye.</internal>");
    const listed = await listTicketTraces(A, opened.ticketId);
    check("a ticket lists its AI drafts, including one that sent nothing", listed.some((t) => t.id === quiet), listed);
    const detail = await getTrace(A, quiet!);
    check("a trace keeps the model's raw text", detail?.draft === "<no_reply/>\n<internal>They said goodbye.</internal>", detail?.draft);
    check("a trace shows how the tags were read", detail?.parsed.kind === "ok" && detail.parsed.noReply && detail.parsed.note === "They said goodbye.", detail?.parsed);
    check("another workspace can't read it", (await getTrace(B, quiet!)) === null);
    check("only admins open traces", routeFloor("GET", "/traces/:id") === "admin" && routeFloor("GET", "/tickets/:id/traces") === "admin");

    // Retention: a workspace's own window, and the default for one that never set it.
    await putPolicies(A, { traceRetentionDays: null });
    await putPolicies(A, { require2fa: policiesBefore.require2fa });
    check("saving another policy leaves the trace retention unset", (await getPolicies(A)).traceRetentionDays === null);
    const setWindow = await putPolicies(A, { traceRetentionDays: 30 });
    check("a workspace sets how long traces are kept", setWindow.traceRetentionDays === 30 && (await getPolicies(A)).traceRetentionDays === 30);
    check("the default is 90 days", TRACE_RETENTION_DEFAULT_DAYS === 90);
    const recentA = await trace(A, null, "recent"); await age(recentA, 10);
    const oldA = await trace(A, null, "old"); await age(oldA, 40);
    const recentB = await trace(B, null, "recent"); await age(recentB, 60);
    const oldB = await trace(B, null, "old"); await age(oldB, 100);
    const deflected = async () => (await getContainment(A, 26)).totals.deflected;
    const deflectedBefore = await deflected();
    await runTraceRetentionSweep(log);
    const deflectedAfter = await deflected();
    check("reports count the deleted traces from the daily counts", deflectedAfter === deflectedBefore && deflectedBefore >= 2, { deflectedBefore, deflectedAfter });
    check("traces past the workspace's window are deleted", !(await exists(oldA)) && (await exists(recentA)));
    const globexWindow = (await getPolicies(B)).traceRetentionDays;
    check("without a window, the 90-day default applies", globexWindow === null && !(await exists(oldB)) && (await exists(recentB)), globexWindow);
    check("a deleted trace reads as gone", (await getTrace(A, oldA!)) === null);
  } finally {
    await putPolicies(A, { traceRetentionDays: policiesBefore.traceRetentionDays });
    await superPool.query("DELETE FROM draft_trace_counts WHERE tenant_id = $1", [B]);
    for (const r of globexCounts) {
      await superPool.query("INSERT INTO draft_trace_counts (tenant_id, day, drafts, deflected) VALUES ($1, $2, $3, $4)", [B, r.day, r.drafts, r.deflected]);
    }
    await clean();
    await superPool.end();
  }
  console.log(failures ? `\n${failures} FAILURES` : "\nAI-TRACES: all checks green");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
