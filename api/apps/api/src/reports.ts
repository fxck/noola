import { withTenant } from "@repo/db";
import { getSlaPolicy, computeSla } from "./sla.js";

// Report builder-lite (Wave 4, item 14) — a typed metrics catalog + one engine that turns a
// report config {metrics, range, groupBy, team/agent filter, compare} into bucketed series.
// Ticket-derived metrics (volume, TTFR/TTR percentiles, SLA rates) come from ONE row fetch
// computed in JS — the SLA math is computeSla, the same as the badges, which SQL can't
// replicate under business hours. CSAT / NPS / deflection are three small bucketed SQL
// aggregates. Saved reports are NOT a new table: they ride the segments store
// (resource='reports', definition = the config).

export const REPORT_METRICS = [
  { key: "volume", label: "New conversations", unit: "count" },
  { key: "closed", label: "Closed conversations", unit: "count" },
  { key: "ttfr_avg", label: "First response — average", unit: "hours" },
  { key: "ttfr_median", label: "First response — median", unit: "hours" },
  { key: "ttfr_p90", label: "First response — p90", unit: "hours" },
  { key: "ttr_avg", label: "Resolution — average", unit: "hours" },
  { key: "ttr_median", label: "Resolution — median", unit: "hours" },
  { key: "ttr_p90", label: "Resolution — p90", unit: "hours" },
  { key: "sla_fr_rate", label: "SLA first-response met", unit: "percent" },
  { key: "sla_res_rate", label: "SLA resolution met", unit: "percent" },
  { key: "csat_avg", label: "CSAT average", unit: "score" },
  { key: "csat_responses", label: "CSAT responses", unit: "count" },
  { key: "nps_score", label: "NPS", unit: "score" },
  { key: "deflection_rate", label: "AI deflection rate", unit: "percent" },
] as const;

export type ReportMetricKey = (typeof REPORT_METRICS)[number]["key"];

export interface ReportConfig {
  metrics: ReportMetricKey[];
  /** ISO dates (inclusive from, exclusive to). Defaults: to = now, from = to − 28d. */
  from?: string;
  to?: string;
  groupBy?: "day" | "week";
  teamId?: string;   // filter: tickets in this team's lane
  agentId?: string;  // filter: tickets assigned to this agent
  compare?: boolean; // also compute totals for the previous period of equal length
}

export interface ReportSeries {
  metric: ReportMetricKey;
  label: string;
  unit: string;
  points: (number | null)[];
  total: number | null;
}

export interface ReportResult {
  from: string;
  to: string;
  groupBy: "day" | "week";
  buckets: string[];
  series: ReportSeries[];
  compare?: { from: string; to: string; totals: { metric: ReportMetricKey; total: number | null }[] };
}

const DAY = 86_400_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function bucketKey(iso: string, groupBy: "day" | "week"): string {
  const d = new Date(iso);
  if (groupBy === "day") return d.toISOString().slice(0, 10);
  // ISO week bucket = the Monday of that week (UTC).
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  const monday = new Date(d.getTime() - (dow - 1) * DAY);
  return monday.toISOString().slice(0, 10);
}

function bucketList(fromMs: number, toMs: number, groupBy: "day" | "week"): string[] {
  const out: string[] = [];
  let cur = new Date(bucketKey(new Date(fromMs).toISOString(), groupBy)).getTime();
  const step = groupBy === "day" ? DAY : 7 * DAY;
  while (cur < toMs) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += step;
  }
  return out;
}

interface TicketRowLite {
  created_at: string;
  closed_at: string | null;
  first_response_at: string | null;
  status: string;
  support_mode?: string;
}

async function runRange(
  tenantId: string,
  cfg: Required<Pick<ReportConfig, "metrics" | "groupBy">> & { fromMs: number; toMs: number; teamId?: string; agentId?: string },
  totalsOnly: boolean,
): Promise<{ buckets: string[]; series: ReportSeries[] }> {
  const { metrics, groupBy, fromMs, toMs } = cfg;
  const buckets = totalsOnly ? [] : bucketList(fromMs, toMs, groupBy);
  const bIdx = new Map(buckets.map((b, i) => [b, i]));
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  const filters: string[] = [];
  const fParams: unknown[] = [from, to];
  if (cfg.teamId) { fParams.push(cfg.teamId); filters.push(`t.team_id = $${fParams.length}`); }
  if (cfg.agentId) { fParams.push(cfg.agentId); filters.push(`t.assignee_id = $${fParams.length}`); }
  const tFilter = filters.length ? ` AND ${filters.join(" AND ")}` : "";

  const wantsTicketMetrics = metrics.some((m) =>
    ["volume", "closed", "ttfr_avg", "ttfr_median", "ttfr_p90", "ttr_avg", "ttr_median", "ttr_p90", "sla_fr_rate", "sla_res_rate"].includes(m),
  );
  const wantsSla = metrics.some((m) => m === "sla_fr_rate" || m === "sla_res_rate");
  const policy = wantsSla ? await getSlaPolicy(tenantId) : null;

  return withTenant(tenantId, async (c) => {
    // One fetch feeds every ticket-derived metric. Created-in-range anchors volume/TTFR/SLA;
    // closed-in-range (fetched separately below) anchors closed/TTR.
    let created: TicketRowLite[] = [];
    let closedRows: TicketRowLite[] = [];
    if (wantsTicketMetrics) {
      const cr = await c.query(
        `SELECT t.created_at, t.closed_at, t.status, t.support_mode,
                (SELECT min(m.created_at) FROM messages m
                   WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id AND m.author_type = 'agent') AS first_response_at
           FROM tickets t
          WHERE t.created_at >= $1 AND t.created_at < $2 AND t.merged_into IS NULL${tFilter}
          LIMIT 50000`,
        fParams,
      );
      created = cr.rows as TicketRowLite[];
      const zr = await c.query(
        `SELECT t.created_at, t.closed_at, t.status, NULL AS first_response_at
           FROM tickets t
          WHERE t.closed_at >= $1 AND t.closed_at < $2 AND t.merged_into IS NULL${tFilter}
          LIMIT 50000`,
        fParams,
      );
      closedRows = zr.rows as TicketRowLite[];
    }

    const series: ReportSeries[] = [];
    const nowMs = Date.now();

    const emit = (metric: ReportMetricKey, points: (number | null)[], total: number | null) => {
      const meta = REPORT_METRICS.find((m) => m.key === metric)!;
      series.push({ metric, label: meta.label, unit: meta.unit, points, total });
    };

    // Generic bucketed reducer over a row set.
    function reduce<T>(rows: T[], keyOf: (r: T) => string, valOf: (r: T) => number | null) {
      const groups: (number[] | undefined)[] = new Array(buckets.length);
      const all: number[] = [];
      for (const r of rows) {
        const v = valOf(r);
        if (v == null) continue;
        all.push(v);
        if (totalsOnly) continue;
        const i = bIdx.get(keyOf(r));
        if (i === undefined) continue;
        (groups[i] ??= []).push(v);
      }
      return { groups, all };
    }

    const hours = (a: string, b: string): number | null => {
      const ms = new Date(b).getTime() - new Date(a).getTime();
      return ms >= 0 ? ms / 3_600_000 : null;
    };

    for (const metric of metrics) {
      switch (metric) {
        case "volume": {
          const { groups, all } = reduce(created, (r) => bucketKey(r.created_at, groupBy), () => 1);
          emit(metric, buckets.map((_b, i) => groups[i]?.length ?? 0), all.length);
          break;
        }
        case "closed": {
          const { groups, all } = reduce(closedRows, (r) => bucketKey(r.closed_at!, groupBy), () => 1);
          emit(metric, buckets.map((_b, i) => groups[i]?.length ?? 0), all.length);
          break;
        }
        case "ttfr_avg": case "ttfr_median": case "ttfr_p90": {
          const { groups, all } = reduce(created, (r) => bucketKey(r.created_at, groupBy),
            (r) => (r.first_response_at ? hours(r.created_at, r.first_response_at) : null));
          const agg = (vals: number[] | undefined): number | null => {
            if (!vals?.length) return null;
            const s = [...vals].sort((a, b) => a - b);
            if (metric === "ttfr_avg") return round1(s.reduce((a, b) => a + b, 0) / s.length);
            const p = percentile(s, metric === "ttfr_median" ? 0.5 : 0.9);
            return p == null ? null : round1(p);
          };
          emit(metric, buckets.map((_b, i) => agg(groups[i])), agg(all));
          break;
        }
        case "ttr_avg": case "ttr_median": case "ttr_p90": {
          const { groups, all } = reduce(closedRows, (r) => bucketKey(r.closed_at!, groupBy),
            (r) => (r.closed_at ? hours(r.created_at, r.closed_at) : null));
          const agg = (vals: number[] | undefined): number | null => {
            if (!vals?.length) return null;
            const s = [...vals].sort((a, b) => a - b);
            if (metric === "ttr_avg") return round1(s.reduce((a, b) => a + b, 0) / s.length);
            const p = percentile(s, metric === "ttr_median" ? 0.5 : 0.9);
            return p == null ? null : round1(p);
          };
          emit(metric, buckets.map((_b, i) => agg(groups[i])), agg(all));
          break;
        }
        case "sla_fr_rate": case "sla_res_rate": {
          if (!policy?.enabled) { emit(metric, buckets.map(() => null), null); break; }
          const { groups, all } = reduce(created, (r) => bucketKey(r.created_at, groupBy), (r) => {
            // Community-mode threads have no SLA clock (§5.1) — excluded from SLA rates.
            if (r.support_mode === "community") return null;
            const sla = computeSla(policy, r, nowMs);
            if (!sla) return null;
            const t = metric === "sla_fr_rate" ? sla.firstResponse : sla.resolution;
            if (t.state === "met") return 1;
            if (t.state === "breached") return 0;
            return null; // pending — not decided, excluded
          });
          const rate = (vals: number[] | undefined): number | null =>
            vals?.length ? round1((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) : null;
          emit(metric, buckets.map((_b, i) => rate(groups[i])), rate(all));
          break;
        }
        case "csat_avg": case "csat_responses": {
          const r = await c.query(
            `SELECT to_char(date_trunc($3, cr.created_at), 'YYYY-MM-DD') AS bucket,
                    count(*)::int AS n, round(avg(cr.rating)::numeric, 2) AS avg
               FROM csat_responses cr
               JOIN tickets t ON t.tenant_id = cr.tenant_id AND t.id = cr.ticket_id
              WHERE cr.created_at >= $1 AND cr.created_at < $2${tFilter}
              GROUP BY 1`,
            [...fParams.slice(0, 2), groupBy, ...fParams.slice(2)].slice(0, fParams.length + 1),
          );
          const byBucket = new Map(r.rows.map((x) => [x.bucket as string, x]));
          const totN = r.rows.reduce((a, x) => a + Number(x.n), 0);
          if (metric === "csat_responses") {
            emit(metric, buckets.map((b) => Number(byBucket.get(b)?.n ?? 0)), totN);
          } else {
            const totAvg = totN > 0
              ? round1(r.rows.reduce((a, x) => a + Number(x.avg) * Number(x.n), 0) / totN)
              : null;
            emit(metric, buckets.map((b) => (byBucket.get(b) ? Number(byBucket.get(b)!.avg) : null)), totAvg);
          }
          break;
        }
        case "nps_score": {
          const r = await c.query(
            `SELECT to_char(date_trunc($3, nr.created_at), 'YYYY-MM-DD') AS bucket,
                    count(*)::int AS n,
                    count(*) FILTER (WHERE nr.score >= 9)::int AS promoters,
                    count(*) FILTER (WHERE nr.score <= 6)::int AS detractors
               FROM nps_responses nr
              WHERE nr.created_at >= $1 AND nr.created_at < $2
              GROUP BY 1`,
            [from, to, groupBy],
          );
          const score = (x: { n: number; promoters: number; detractors: number } | undefined): number | null =>
            x && Number(x.n) > 0 ? Math.round(((Number(x.promoters) - Number(x.detractors)) / Number(x.n)) * 100) : null;
          const byBucket = new Map(r.rows.map((x) => [x.bucket as string, x]));
          const tot = { n: 0, promoters: 0, detractors: 0 };
          for (const x of r.rows) { tot.n += Number(x.n); tot.promoters += Number(x.promoters); tot.detractors += Number(x.detractors); }
          emit(metric, buckets.map((b) => score(byBucket.get(b) as never)), score(tot.n ? tot : undefined));
          break;
        }
        case "deflection_rate": {
          const r = await c.query(
            `SELECT to_char(date_trunc($3, m.created_at), 'YYYY-MM-DD') AS bucket,
                    count(*) FILTER (WHERE m.auto)::int AS ai,
                    count(*) FILTER (WHERE m.author_type = 'agent')::int AS agent
               FROM messages m
               JOIN tickets t ON t.tenant_id = m.tenant_id AND t.id = m.ticket_id
              WHERE m.created_at >= $1 AND m.created_at < $2${tFilter}
              GROUP BY 1`,
            [...fParams.slice(0, 2), groupBy, ...fParams.slice(2)].slice(0, fParams.length + 1),
          );
          const rate = (ai: number, agent: number): number | null =>
            ai + agent > 0 ? round1((ai / (ai + agent)) * 100) : null;
          const byBucket = new Map(r.rows.map((x) => [x.bucket as string, x]));
          const tot = r.rows.reduce((a, x) => ({ ai: a.ai + Number(x.ai), agent: a.agent + Number(x.agent) }), { ai: 0, agent: 0 });
          emit(metric, buckets.map((b) => {
            const x = byBucket.get(b);
            return x ? rate(Number(x.ai), Number(x.agent)) : null;
          }), rate(tot.ai, tot.agent));
          break;
        }
      }
    }
    return { buckets, series };
  });
}

export async function runReport(tenantId: string, cfg: ReportConfig): Promise<ReportResult> {
  const groupBy = cfg.groupBy === "day" ? "day" : "week";
  const toMs = cfg.to ? new Date(cfg.to).getTime() : Date.now();
  const fromMs = cfg.from ? new Date(cfg.from).getTime() : toMs - 28 * DAY;
  if (Number.isNaN(toMs) || Number.isNaN(fromMs) || fromMs >= toMs) throw new Error("invalid range");
  // Bound the range so a typo can't scan a year by day (366 buckets is fine; 10y is not).
  const spanMs = Math.min(toMs - fromMs, 400 * DAY);
  const metrics = [...new Set(cfg.metrics)].slice(0, 8) as ReportMetricKey[];

  const main = await runRange(tenantId, { metrics, groupBy, fromMs: toMs - spanMs, toMs, teamId: cfg.teamId, agentId: cfg.agentId }, false);
  const out: ReportResult = {
    from: new Date(toMs - spanMs).toISOString(),
    to: new Date(toMs).toISOString(),
    groupBy,
    buckets: main.buckets,
    series: main.series,
  };
  if (cfg.compare) {
    const prev = await runRange(
      tenantId,
      { metrics, groupBy, fromMs: toMs - 2 * spanMs, toMs: toMs - spanMs, teamId: cfg.teamId, agentId: cfg.agentId },
      true,
    );
    out.compare = {
      from: new Date(toMs - 2 * spanMs).toISOString(),
      to: new Date(toMs - spanMs).toISOString(),
      totals: prev.series.map((s) => ({ metric: s.metric, total: s.total })),
    };
  }
  return out;
}
