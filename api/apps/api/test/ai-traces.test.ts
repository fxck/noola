import Fastify from "fastify";
import pg from "pg";
import { withTenant } from "@repo/db";
import { getTrace, listTicketTraces, listTraces, parseTraceListQuery, recordDraftTrace, updateTraceGate } from "../src/trace.js";
import settingsRoutes from "../src/routes/settings.js";
import { getPolicies, putPolicies, runTraceRetentionSweep, TRACE_RETENTION_DEFAULT_DAYS } from "../src/governance.js";
import { routeFloor } from "../src/rbac.js";
import { ingestInbound } from "../src/ingest.js";
import { getContainment } from "../src/analytics.js";
import { createArticle, deleteArticle } from "../src/kb.js";
import { ensureKbCollection } from "../src/search.js";
import { suggestForQuery } from "../src/copilot.js";

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
  let article: string | null = null;
  const policiesBefore = await getPolicies(A);
  // The sweep counts Globex's old test trace into its daily counts, which are put back afterwards.
  const globexCounts = (await superPool.query("SELECT day, drafts, deflected FROM draft_trace_counts WHERE tenant_id = $1", [B])).rows;
  const trace = async (
    tenantId: string, ticketId: string | null, draft: string,
    opts: { query?: string; model?: string; gate?: [string, string]; sourceless?: boolean } = {},
  ) => {
    const id = await recordDraftTrace({
      tenantId, ticketId, messageId: null, query: opts.query ?? "TRACETEST bye",
      sources: opts.sourceless ? [] : [{ kind: "kb", id: "a1", title: "Guide", score: 0.8, rank: 0 }],
      retrieval: { topScore: 0.8, agreement: 1 }, draft, model: opts.model ?? "custom:tracetest", embedModel: "tracetest-embed", confidence: 0.7,
      tokensIn: 10, tokensOut: 5, latencyMs: 12, source: "live",
    });
    if (id && opts.gate) await updateTraceGate(tenantId, id, { outcome: opts.gate[0], reason: opts.gate[1], riskTags: [] });
    return id;
  };
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

    // The workspace list: one trace per category, two of them older, and one in another workspace.
    const paged = (query: string, gate?: [string, string], model?: string) =>
      trace(A, null, "paged", { query: `TRACETEST paging ${query}`, gate, model });
    const sent = await paged("alpha", ["auto_sent", "sent"]); await age(sent, 5);
    const held = await paged("beta", ["suppressed", "weak_retrieval"]); await age(held, 2);
    const noteOnly = await paged("gamma", ["assist", "note_only"]);
    const noReply = await paged("delta", ["suppressed", "no_reply_needed"]);
    const handoff = await paged("epsilon", ["assist", "handoff"]);
    const noSources = await paged("zeta", ["auto_sent", "sent"], "grounding-guard");
    const noDecision = await paged("eta");
    const other = await trace(B, null, "paged", { query: "TRACETEST paging other" });
    const list = (q: Partial<Parameters<typeof listTraces>[1]>) =>
      listTraces(A, { page: 1, pageSize: 50, outcome: null, q: "TRACETEST paging", from: null, to: null, ...q });
    const ids = (r: { traces: { id: string }[] }) => r.traces.map((t) => t.id);

    const page1 = await list({ pageSize: 3 });
    const page3 = await list({ pageSize: 3, page: 3 });
    const page4 = await list({ pageSize: 3, page: 4 });
    check("a page holds its size, newest first, with the total across pages",
      page1.total === 7 && page1.traces.length === 3 && !ids(page1).includes(sent!) && !ids(page1).includes(held!),
      { total: page1.total, ids: ids(page1) });
    check("the last page holds the oldest trace, and a page past the end is empty but keeps the total",
      ids(page3).join() === sent && page4.traces.length === 0 && page4.total === 7, { page3: ids(page3), page4 });
    const expected: [string, string | null][] = [
      ["sent", sent], ["held", held], ["note_only", noteOnly], ["no_reply", noReply], ["handoff", handoff], ["no_sources", noSources], ["no_decision", noDecision],
    ];
    for (const [outcome, id] of expected) {
      const r = await list({ outcome: outcome as "sent" });
      check(`the ${outcome} filter finds exactly that trace`, ids(r).join() === id && r.total === 1, ids(r));
    }
    const sourceless = await trace(A, null, "<no_reply/>", { query: "TRACETEST sourceless thanks", gate: ["suppressed", "no_reply_needed"], sourceless: true });
    const bySourceless = (outcome: "no_sources" | "no_reply") => listTraces(A, { page: 1, pageSize: 50, outcome, q: "TRACETEST sourceless", from: null, to: null });
    check("no sources found also finds a draft the model wrote without sources", ids(await bySourceless("no_sources")).join() === sourceless);
    check("which still shows under what Noola did with it", ids(await bySourceless("no_reply")).join() === sourceless);
    check("a trace reports how many sources it had", (await bySourceless("no_reply")).traces[0]?.sourceCount === 0 && (await list({})).traces.every((t) => t.sourceCount === 1));
    const since = new Date(Date.now() - 3 * 86_400_000);
    const until = new Date(Date.now() - 86_400_000);
    check("from keeps traces on or after the date", (await list({ from: since })).total === 6);
    check("to excludes traces on or after the date", ids(await list({ to: until })).sort().join() === [sent, held].sort().join());
    check("the text search matches part of the customer's text", ids(await list({ q: "tracetest paging ALPH" })).join() === sent);
    const percent = await trace(A, null, "paged", { query: "TRACETEST 100% sure_thing" });
    await trace(A, null, "paged", { query: "TRACETEST 100x sureXthing" });
    check("the text search reads % and _ literally", ids(await list({ q: "100% sure_" })).join() === percent);
    const withTicket = (await list({ q: "TRACETEST bye" })).traces.find((t) => t.id === quiet);
    const subject = (await superPool.query("SELECT subject FROM tickets WHERE id = $1", [opened.ticketId])).rows[0]?.subject;
    check("a trace on a ticket carries the ticket and its subject", withTicket?.ticketId === opened.ticketId && !!subject && withTicket?.ticketSubject === subject, withTicket);
    check("a trace without a ticket has no subject", page1.traces.every((t) => t.ticketId === null && t.ticketSubject === null));
    const otherList = await listTraces(B, { page: 1, pageSize: 50, outcome: null, q: "TRACETEST paging", from: null, to: null });
    check("a workspace lists only its own traces", ids(otherList).join() === other && otherList.total === 1, ids(otherList));

    const rejects = (q: Record<string, unknown>) => {
      try { parseTraceListQuery(q); return false; } catch (e) { return (e as { statusCode?: number }).statusCode === 400; }
    };
    const defaults = parseTraceListQuery({});
    check("the list query defaults to the first page of 50", defaults.page === 1 && defaults.pageSize === 50 && defaults.outcome === null && defaults.q === null);
    check("the list query rejects a bad page, page size, outcome or date",
      rejects({ page: "0" }) && rejects({ page: "x" }) && rejects({ pageSize: "101" }) && rejects({ outcome: "bogus" }) && rejects({ from: "nope" }) && rejects({ to: "2026-13-45" }));
    check("the list query reads valid values", (() => {
      const p = parseTraceListQuery({ page: "2", pageSize: "10", outcome: "held", q: "  hi  ", from: "2026-01-01", to: "2026-02-01T00:00:00Z" });
      return p.page === 2 && p.pageSize === 10 && p.outcome === "held" && p.q === "hi" && p.from?.toISOString() === "2026-01-01T00:00:00.000Z" && p.to?.toISOString() === "2026-02-01T00:00:00.000Z";
    })());

    const app = Fastify();
    let role = "agent";
    app.addHook("onRequest", async (req) => {
      (req as unknown as { session: unknown }).session = { userId: "tracetest", tenantId: A, role, email: "t@example.invalid", name: "T" };
    });
    await app.register(settingsRoutes);
    const asAgent = await app.inject({ method: "GET", url: "/traces?q=TRACETEST%20paging" });
    role = "admin";
    const asAdmin = await app.inject({ method: "GET", url: "/traces?q=TRACETEST%20paging" });
    const badPage = await app.inject({ method: "GET", url: "/traces?page=0" });
    await app.close();
    check("an agent gets 403 from the workspace trace list", asAgent.statusCode === 403 && routeFloor("GET", "/traces") === "admin", asAgent.statusCode);
    check("an admin gets the list", asAdmin.statusCode === 200 && asAdmin.json().total === 7, { status: asAdmin.statusCode, body: asAdmin.body.slice(0, 200) });
    check("a bad filter gets 400", badPage.statusCode === 400, badPage.statusCode);

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

    // ---- A drafted answer's trace says where each search ranked its sources ----
    await ensureKbCollection();
    article = (await createArticle(A, "TRACETEST zebrafish feeding", "Feed the TRACETEST zebrafish twice a day with flakes.", null, { visibility: "public" })).id;
    const answered = await suggestForQuery(A, "TRACETEST how do I feed a zebrafish", { audience: "public", forceScope: ["kb"], source: "eval" });
    const cited = (await getTrace(A, answered.traceId!))?.sources.find((s) => s.id === article);
    check("the keyword search's rank is on the source", cited?.keywordRank === 1, cited);
    check("the source keeps the start of its text", cited?.excerpt === "Feed the TRACETEST zebrafish twice a day with flakes.", cited);
    check("without a search query no source says what found it", cited?.foundBy === undefined, cited);
  } finally {
    if (article) await deleteArticle(A, article);
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
