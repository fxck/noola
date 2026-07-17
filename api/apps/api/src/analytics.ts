import { withTenant } from "@repo/db";
import { csatSummary, type CsatSummary } from "./csat.js";
import { npsSummary, type NpsSummary } from "./nps.js";
import { localeName } from "./locale.js";
import { getSlaPolicy, computeSla } from "./sla.js";

// Support analytics — the reporting layer. Everything is a cheap aggregate over tickets +
// messages, RLS-scoped (withTenant → tenant GUC). One round-trip per widget; the dashboard
// reads the whole overview at once. Numbers reflect the shared dev/stage tenant in non-prod.

export interface AnalyticsOverview {
  totals: { total: number; open: number; closed: number };
  byPriority: { priority: string; count: number }[];
  bySentiment: { positive: number; neutral: number; negative: number };
  byChannel: { channel: string; count: number }[];
  // Ticket volume by detected customer language (Wave 4). `locale` is the ISO code (or "unknown"),
  // `label` its display name. Powers the language breakdown on analytics/topics.
  byLanguage: { locale: string; label: string; count: number }[];
  topTags: { tag: string; count: number }[];
  resolution: { avgHours: number | null; medianHours: number | null; p90Hours: number | null; closedCount: number };
  // Time-to-first-response (ticket open → first agent reply).
  responseTime: { avgHours: number | null; medianHours: number | null; p90Hours: number | null; respondedCount: number };
  // Per-agent workload + throughput (assignee-scoped).
  byAgent: { agentId: string; agentName: string; assigned: number; closed: number; avgResolutionHours: number | null }[];
  volume: { day: string; count: number }[]; // last 14 days, one row per day with tickets
  deflection: { autoRepliedTickets: number; aiMessages: number; agentMessages: number; rate: number };
  csat: CsatSummary;
  nps: NpsSummary;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

// ── Workload (Wave 3) — the live ops picture: who is carrying what RIGHT NOW ──
// "waiting" = open tickets where it's our turn to reply (the queue that ages into SLA
// breaches); "closedToday" = throughput since local midnight (UTC-anchored — the shared
// convention of the volume chart). Team rows also count the lane's unassigned backlog.

export interface WorkloadReport {
  totals: { open: number; waiting: number; unassigned: number };
  byAgent: {
    agentId: string; agentName: string; role: string; outOfOffice: boolean; oooUntil: string | null;
    open: number; waiting: number; closedToday: number;
  }[];
  byTeam: {
    teamId: string; teamName: string; emoji: string | null; memberCount: number;
    open: number; waiting: number; unassigned: number; closedToday: number;
  }[];
}

export async function getWorkload(tenantId: string): Promise<WorkloadReport> {
  const { clearExpiredOoo } = await import("./assignments.js");
  return withTenant(tenantId, async (c) => {
    await clearExpiredOoo(c); // auto-return before the Away badges render
    const totalsR = await c.query(
      // Community-mode threads are observed, not agent work (§5.1): excluded from the "waiting"
      // (needs-a-reply) count. They still count toward open/unassigned for record-keeping.
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'open' AND whose_turn = 'us' AND support_mode = 'staffed')::int AS waiting,
              count(*) FILTER (WHERE status = 'open' AND assignee_id IS NULL)::int AS unassigned
         FROM tickets`,
    );
    // Every agent appears (LEFT JOIN from users), so an idle agent reads 0/0/0 instead of
    // vanishing — the workload view is exactly for spotting imbalance.
    const byAgentR = await c.query(
      `SELECT u.id AS agent_id, u.name AS agent_name, u.role, u.out_of_office, u.ooo_until,
              count(t.id) FILTER (WHERE t.status = 'open')::int AS open,
              count(t.id) FILTER (WHERE t.status = 'open' AND t.whose_turn = 'us' AND t.support_mode = 'staffed')::int AS waiting,
              count(t.id) FILTER (WHERE t.status = 'closed' AND t.closed_at >= date_trunc('day', now()))::int AS closed_today
         FROM users u
         LEFT JOIN tickets t ON t.tenant_id = u.tenant_id AND t.assignee_id = u.id
        GROUP BY u.id, u.name, u.role, u.out_of_office, u.ooo_until
        ORDER BY open DESC, agent_name`,
    );
    const byTeamR = await c.query(
      `SELECT tm.id AS team_id, tm.name AS team_name, tm.emoji,
              (SELECT count(*)::int FROM team_members m
                 WHERE m.tenant_id = tm.tenant_id AND m.team_id = tm.id) AS member_count,
              count(t.id) FILTER (WHERE t.status = 'open')::int AS open,
              count(t.id) FILTER (WHERE t.status = 'open' AND t.whose_turn = 'us' AND t.support_mode = 'staffed')::int AS waiting,
              count(t.id) FILTER (WHERE t.status = 'open' AND t.assignee_id IS NULL)::int AS unassigned,
              count(t.id) FILTER (WHERE t.status = 'closed' AND t.closed_at >= date_trunc('day', now()))::int AS closed_today
         FROM teams tm
         LEFT JOIN tickets t ON t.tenant_id = tm.tenant_id AND t.team_id = tm.id
        GROUP BY tm.tenant_id, tm.id, tm.name, tm.emoji
        ORDER BY open DESC, team_name`,
    );
    const tt = totalsR.rows[0] as Record<string, unknown>;
    return {
      totals: { open: num(tt.open), waiting: num(tt.waiting), unassigned: num(tt.unassigned) },
      byAgent: byAgentR.rows.map((x) => ({
        agentId: x.agent_id as string,
        agentName: (x.agent_name as string) ?? "Unknown",
        role: (x.role as string) ?? "agent",
        outOfOffice: Boolean(x.out_of_office),
        oooUntil: (x.ooo_until as string | null) ?? null,
        open: num(x.open),
        waiting: num(x.waiting),
        closedToday: num(x.closed_today),
      })),
      byTeam: byTeamR.rows.map((x) => ({
        teamId: x.team_id as string,
        teamName: x.team_name as string,
        emoji: (x.emoji as string | null) ?? null,
        memberCount: num(x.member_count),
        open: num(x.open),
        waiting: num(x.waiting),
        unassigned: num(x.unassigned),
        closedToday: num(x.closed_today),
      })),
    };
  });
}

export async function getOverview(tenantId: string): Promise<AnalyticsOverview> {
  return withTenant(tenantId, async (c) => {
    const totalsR = await c.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'closed')::int AS closed
         FROM tickets`,
    );
    const byPriorityR = await c.query(
      `SELECT priority, count(*)::int AS count FROM tickets GROUP BY priority`,
    );
    const byChannelR = await c.query(
      `SELECT channel_type AS channel, count(*)::int AS count FROM tickets GROUP BY channel_type ORDER BY count DESC`,
    );
    const bySentimentR = await c.query(
      `SELECT count(*) FILTER (WHERE sentiment = 'positive')::int AS positive,
              count(*) FILTER (WHERE sentiment = 'neutral')::int  AS neutral,
              count(*) FILTER (WHERE sentiment = 'negative')::int AS negative
         FROM tickets`,
    );
    const topTagsR = await c.query(
      `SELECT tag, count(*)::int AS count
         FROM tickets, unnest(tags) AS tag
        GROUP BY tag ORDER BY count DESC, tag LIMIT 8`,
    );
    const resolutionR = await c.query(
      `SELECT avg(extract(epoch FROM (closed_at - created_at))) AS avg_s,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (closed_at - created_at))) AS median_s,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (closed_at - created_at))) AS p90_s,
              count(*)::int AS closed_count
         FROM tickets
        WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at >= created_at`,
    );
    // Time-to-first-response — the first agent reply per ticket, minus ticket creation.
    const responseR = await c.query(
      `WITH fr AS (
         SELECT t.created_at,
                (SELECT min(m.created_at) FROM messages m
                  WHERE m.ticket_id = t.id AND m.tenant_id = t.tenant_id AND m.author_type = 'agent') AS first_resp
           FROM tickets t
       )
       SELECT avg(extract(epoch FROM (first_resp - created_at))) AS avg_s,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_resp - created_at))) AS median_s,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (first_resp - created_at))) AS p90_s,
              count(*)::int AS responded_count
         FROM fr
        WHERE first_resp IS NOT NULL AND first_resp >= created_at`,
    );
    // Per-agent workload + throughput (assignee-scoped; agents with no assignments are omitted).
    const byAgentR = await c.query(
      `SELECT t.assignee_id AS agent_id, u.name AS agent_name,
              count(*)::int AS assigned,
              count(*) FILTER (WHERE t.status = 'closed')::int AS closed,
              avg(extract(epoch FROM (t.closed_at - t.created_at)))
                FILTER (WHERE t.status = 'closed' AND t.closed_at IS NOT NULL AND t.closed_at >= t.created_at) AS avg_res_s
         FROM tickets t
         JOIN users u ON u.id = t.assignee_id AND u.tenant_id = t.tenant_id
        WHERE t.assignee_id IS NOT NULL
        GROUP BY t.assignee_id, u.name
        ORDER BY assigned DESC, agent_name
        LIMIT 20`,
    );
    const volumeR = await c.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS count
         FROM tickets
        WHERE created_at > now() - interval '14 days'
        GROUP BY 1 ORDER BY 1`,
    );
    // Ticket volume by detected language — nulls (undetected) roll up into a single "unknown" bucket.
    const byLanguageR = await c.query(
      `SELECT COALESCE(locale, 'unknown') AS locale, count(*)::int AS count
         FROM tickets GROUP BY 1 ORDER BY count DESC, locale`,
    );
    const deflectionR = await c.query(
      `SELECT count(*) FILTER (WHERE auto)::int AS ai_messages,
              count(*) FILTER (WHERE author_type = 'agent')::int AS agent_messages,
              count(DISTINCT ticket_id) FILTER (WHERE auto)::int AS auto_replied_tickets
         FROM messages`,
    );

    const t = totalsR.rows[0] as Record<string, unknown>;
    const r = resolutionR.rows[0] as Record<string, unknown>;
    const rt = responseR.rows[0] as Record<string, unknown>;
    const d = deflectionR.rows[0] as Record<string, unknown>;
    const agentMessages = num(d.agent_messages);
    const aiMessages = num(d.ai_messages);

    const toHours = (s: unknown): number | null => (s == null ? null : Math.round((Number(s) / 3600) * 10) / 10);

    const csat = await csatSummary(tenantId);
    const nps = await npsSummary(tenantId);

    return {
      totals: { total: num(t.total), open: num(t.open), closed: num(t.closed) },
      byPriority: byPriorityR.rows.map((x) => ({ priority: x.priority as string, count: num(x.count) })),
      bySentiment: {
        positive: num((bySentimentR.rows[0] as Record<string, unknown>).positive),
        neutral: num((bySentimentR.rows[0] as Record<string, unknown>).neutral),
        negative: num((bySentimentR.rows[0] as Record<string, unknown>).negative),
      },
      byChannel: byChannelR.rows.map((x) => ({ channel: x.channel as string, count: num(x.count) })),
      byLanguage: byLanguageR.rows.map((x) => ({
        locale: x.locale as string,
        label: (x.locale as string) === "unknown" ? "Unknown" : localeName(x.locale as string),
        count: num(x.count),
      })),
      topTags: topTagsR.rows.map((x) => ({ tag: x.tag as string, count: num(x.count) })),
      resolution: { avgHours: toHours(r.avg_s), medianHours: toHours(r.median_s), p90Hours: toHours(r.p90_s), closedCount: num(r.closed_count) },
      responseTime: {
        avgHours: toHours(rt.avg_s), medianHours: toHours(rt.median_s), p90Hours: toHours(rt.p90_s),
        respondedCount: num(rt.responded_count),
      },
      byAgent: byAgentR.rows.map((x) => ({
        agentId: x.agent_id as string,
        agentName: (x.agent_name as string) ?? "Unknown",
        assigned: num(x.assigned),
        closed: num(x.closed),
        avgResolutionHours: toHours(x.avg_res_s),
      })),
      volume: volumeR.rows.map((x) => ({ day: x.day as string, count: num(x.count) })),
      deflection: {
        autoRepliedTickets: num(d.auto_replied_tickets),
        aiMessages,
        agentMessages,
        rate: agentMessages > 0 ? Math.round((aiMessages / agentMessages) * 1000) / 10 : 0,
      },
      csat,
      nps,
    };
  });
}

// ── SLA adherence (Wave 3, item 13) — met vs breached over a rolling window ──
// Adherence is computed per ticket via computeSla (the SAME business-hours-aware math the
// badges use — reporting never disagrees with the inbox). A target counts only once it is
// DECIDED: met (answered/closed in time) or breached (answered/closed late, or still open past
// due). Open tickets inside their window are "pending" and excluded from the rates.

interface SlaBucket {
  tickets: number;
  frMet: number; frBreached: number;
  resMet: number; resBreached: number;
}

export interface SlaReport {
  enabled: boolean;
  windowWeeks: number;
  totals: SlaBucket & { frRate: number | null; resRate: number | null; pending: number };
  byWeek: (SlaBucket & { week: string; avgFrHours: number | null; avgResHours: number | null })[];
  byPriority: (SlaBucket & { priority: string })[];
  byTeam: (SlaBucket & { teamId: string | null; teamName: string })[];
}

const rate = (met: number, breached: number): number | null =>
  met + breached > 0 ? Math.round((met / (met + breached)) * 1000) / 10 : null;

export async function getSlaReport(tenantId: string, weeks = 8): Promise<SlaReport> {
  const windowWeeks = Math.min(Math.max(weeks, 1), 26);
  const policy = await getSlaPolicy(tenantId);
  const empty: SlaBucket = { tickets: 0, frMet: 0, frBreached: 0, resMet: 0, resBreached: 0 };
  if (!policy.enabled) {
    return {
      enabled: false, windowWeeks,
      totals: { ...empty, frRate: null, resRate: null, pending: 0 },
      byWeek: [], byPriority: [], byTeam: [],
    };
  }

  const rows = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.id, t.created_at, t.closed_at, t.priority, t.team_id,
              to_char(date_trunc('week', t.created_at), 'YYYY-MM-DD') AS week,
              (SELECT tem.name FROM teams tem
                 WHERE tem.tenant_id = t.tenant_id AND tem.id = t.team_id) AS team_name,
              (SELECT min(m.created_at) FROM messages m
                 WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id
                   AND m.author_type = 'agent') AS first_response_at
         FROM tickets t
        WHERE t.created_at > now() - make_interval(weeks => $1)
          AND t.merged_into IS NULL
        ORDER BY t.created_at`,
      [windowWeeks],
    );
    return r.rows as Array<{
      id: string; created_at: string; closed_at: string | null; priority: string;
      team_id: string | null; team_name: string | null; week: string; first_response_at: string | null;
    }>;
  });

  const now = Date.now();
  const totals: SlaBucket & { frRate: number | null; resRate: number | null; pending: number } =
    { ...empty, frRate: null, resRate: null, pending: 0 };
  const weeksMap = new Map<string, SlaBucket & { week: string; frSumH: number; frN: number; resSumH: number; resN: number }>();
  const prioMap = new Map<string, SlaBucket & { priority: string }>();
  const teamMap = new Map<string, SlaBucket & { teamId: string | null; teamName: string }>();

  for (const t of rows) {
    const sla = computeSla(policy, t, now);
    if (!sla) continue;
    const wk = weeksMap.get(t.week) ?? { ...empty, week: t.week, frSumH: 0, frN: 0, resSumH: 0, resN: 0 };
    const pr = prioMap.get(t.priority) ?? { ...empty, priority: t.priority };
    const tKey = t.team_id ?? "none";
    const tm = teamMap.get(tKey) ?? { ...empty, teamId: t.team_id, teamName: t.team_name ?? "No team" };
    totals.tickets++; wk.tickets++; pr.tickets++; tm.tickets++;

    let decidedAny = false;
    const frState = sla.firstResponse.state;
    if (frState === "met" || frState === "breached") {
      decidedAny = true;
      const key = frState === "met" ? "frMet" : "frBreached";
      totals[key]++; wk[key]++; pr[key]++; tm[key]++;
    }
    const resState = sla.resolution.state;
    if (resState === "met" || resState === "breached") {
      decidedAny = true;
      const key = resState === "met" ? "resMet" : "resBreached";
      totals[key]++; wk[key]++; pr[key]++; tm[key]++;
    }
    if (!decidedAny) totals.pending++;

    // Calendar-hour trends (independent of the adherence verdicts).
    if (t.first_response_at) {
      const h = (new Date(t.first_response_at).getTime() - new Date(t.created_at).getTime()) / 3_600_000;
      if (h >= 0) { wk.frSumH += h; wk.frN++; }
    }
    if (t.closed_at) {
      const h = (new Date(t.closed_at).getTime() - new Date(t.created_at).getTime()) / 3_600_000;
      if (h >= 0) { wk.resSumH += h; wk.resN++; }
    }
    weeksMap.set(t.week, wk); prioMap.set(t.priority, pr); teamMap.set(tKey, tm);
  }

  totals.frRate = rate(totals.frMet, totals.frBreached);
  totals.resRate = rate(totals.resMet, totals.resBreached);
  const prioOrder = ["urgent", "high", "normal", "low"];
  return {
    enabled: true,
    windowWeeks,
    totals,
    byWeek: [...weeksMap.values()]
      .sort((a, b) => a.week.localeCompare(b.week))
      .map(({ frSumH, frN, resSumH, resN, ...w }) => ({
        ...w,
        avgFrHours: frN > 0 ? Math.round((frSumH / frN) * 10) / 10 : null,
        avgResHours: resN > 0 ? Math.round((resSumH / resN) * 10) / 10 : null,
      })),
    byPriority: [...prioMap.values()].sort(
      (a, b) => prioOrder.indexOf(a.priority) - prioOrder.indexOf(b.priority),
    ),
    byTeam: [...teamMap.values()].sort((a, b) => b.tickets - a.tickets),
  };
}

// ── Ops dashboard (Wave 4, item 15) — the live floor view ────────────────────
// What needs a human RIGHT NOW: the waiting queue's age tail, SLA targets about to slip
// (same computeSla math as the badges), and today's flow. "Agents online" is NOT here —
// the web reads it straight from the edge presence channel it already subscribes to.

export interface OpsTicketRef {
  id: string;
  subject: string;
  contactName: string | null;
  teamName: string | null;
  priority: string;
  /** For oldest-waiting: when the customer last left it with us. For breaching: the due time. */
  at: string;
  /** Breaching rows: which target ("first_response" | "resolution") and its state. */
  target?: string;
  state?: string;
}

export interface OpsDashboard {
  queue: { open: number; waiting: number; unassigned: number; snoozed: number };
  today: { created: number; closed: number };
  oldestWaiting: OpsTicketRef[];
  breaching: OpsTicketRef[];
  slaEnabled: boolean;
}

export async function getOpsDashboard(tenantId: string): Promise<OpsDashboard> {
  const policy = await getSlaPolicy(tenantId);
  return withTenant(tenantId, async (c) => {
    const queueR = await c.query(
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'open' AND whose_turn = 'us' AND support_mode = 'staffed'
                               AND (snoozed_until IS NULL OR snoozed_until <= now()))::int AS waiting,
              count(*) FILTER (WHERE status = 'open' AND assignee_id IS NULL)::int AS unassigned,
              count(*) FILTER (WHERE status = 'open' AND snoozed_until > now())::int AS snoozed,
              count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS created_today,
              count(*) FILTER (WHERE status = 'closed' AND closed_at >= date_trunc('day', now()))::int AS closed_today
         FROM tickets`,
    );
    // Oldest customer-waiting conversations: age anchor is the LAST customer message (falls
    // back to updated_at) — "how long have they been waiting on us", not ticket age.
    const oldestR = await c.query(
      `SELECT t.id, t.subject, t.priority,
              co.name AS contact_name,
              (SELECT tem.name FROM teams tem WHERE tem.tenant_id = t.tenant_id AND tem.id = t.team_id) AS team_name,
              COALESCE((SELECT max(m.created_at) FROM messages m
                          WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id
                            AND m.author_type = 'customer'), t.updated_at) AS waiting_since
         FROM tickets t
         LEFT JOIN contacts co ON co.tenant_id = t.tenant_id AND co.id = t.contact_id
        WHERE t.status = 'open' AND t.whose_turn = 'us' AND t.support_mode = 'staffed'
          AND (t.snoozed_until IS NULL OR t.snoozed_until <= now())
        ORDER BY waiting_since ASC
        LIMIT 8`,
    );
    let breaching: OpsTicketRef[] = [];
    if (policy.enabled) {
      const openR = await c.query(
        `SELECT t.id, t.subject, t.priority, t.created_at, t.closed_at,
                co.name AS contact_name,
                (SELECT tem.name FROM teams tem WHERE tem.tenant_id = t.tenant_id AND tem.id = t.team_id) AS team_name,
                (SELECT min(m.created_at) FROM messages m
                   WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id
                     AND m.author_type = 'agent') AS first_response_at
           FROM tickets t
           LEFT JOIN contacts co ON co.tenant_id = t.tenant_id AND co.id = t.contact_id
          WHERE t.status = 'open' AND (t.snoozed_until IS NULL OR t.snoozed_until <= now())`,
      );
      const now = Date.now();
      const rows: (OpsTicketRef & { dueMs: number })[] = [];
      for (const t of openR.rows as Array<Record<string, unknown>>) {
        const sla = computeSla(policy, t as { created_at: string; closed_at: string | null; first_response_at: string | null }, now);
        if (!sla) continue;
        // The ACTIVE target: first-response until answered, then resolution.
        const target = (t.first_response_at ? sla.resolution : sla.firstResponse);
        const which = t.first_response_at ? "resolution" : "first_response";
        if (target.state === "at_risk" || target.state === "breached") {
          rows.push({
            id: t.id as string,
            subject: t.subject as string,
            contactName: (t.contact_name as string | null) ?? null,
            teamName: (t.team_name as string | null) ?? null,
            priority: t.priority as string,
            at: target.dueAt,
            target: which,
            state: target.state,
            dueMs: new Date(target.dueAt).getTime(),
          });
        }
      }
      breaching = rows.sort((a, b) => a.dueMs - b.dueMs).slice(0, 8).map(({ dueMs: _d, ...r }) => r);
    }
    const q = queueR.rows[0] as Record<string, unknown>;
    return {
      queue: { open: num(q.open), waiting: num(q.waiting), unassigned: num(q.unassigned), snoozed: num(q.snoozed) },
      today: { created: num(q.created_today), closed: num(q.closed_today) },
      oldestWaiting: (oldestR.rows as Array<Record<string, unknown>>).map((t) => ({
        id: t.id as string,
        subject: t.subject as string,
        contactName: (t.contact_name as string | null) ?? null,
        teamName: (t.team_name as string | null) ?? null,
        priority: t.priority as string,
        at: t.waiting_since as string,
      })),
      breaching,
      slaEnabled: policy.enabled,
    };
  });
}

// ── CSAT trends + agent leaderboard (Wave 4, item 16) ────────────────────────

export interface CsatReport {
  byWeek: { week: string; responses: number; average: number | null; positive: number }[];
  leaderboard: {
    agentId: string; agentName: string;
    closed: number; responses: number; avgCsat: number | null;
    avgFirstResponseHours: number | null;
  }[];
  windowWeeks: number;
}

export async function getCsatReport(tenantId: string, weeks = 12): Promise<CsatReport> {
  const windowWeeks = Math.min(Math.max(weeks, 1), 26);
  return withTenant(tenantId, async (c) => {
    const byWeekR = await c.query(
      `SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
              count(*)::int AS responses,
              round(avg(rating)::numeric, 2) AS average,
              count(*) FILTER (WHERE rating >= 4)::int AS positive
         FROM csat_responses
        WHERE created_at > now() - make_interval(weeks => $1)
        GROUP BY 1 ORDER BY 1`,
      [windowWeeks],
    );
    // Leaderboard: throughput + satisfaction + responsiveness per agent over the window.
    // CSAT attributes to the ticket's assignee at rating time; unassigned-at-close tickets
    // drop out of the per-agent cut (they still count in the tenant-wide byWeek).
    const lbR = await c.query(
      `SELECT u.id AS agent_id, u.name AS agent_name,
              (SELECT count(*)::int FROM tickets t
                 WHERE t.tenant_id = u.tenant_id AND t.assignee_id = u.id
                   AND t.status = 'closed' AND t.closed_at > now() - make_interval(weeks => $1)) AS closed,
              (SELECT count(*)::int FROM csat_responses cr
                 JOIN tickets t ON t.tenant_id = cr.tenant_id AND t.id = cr.ticket_id
                 WHERE cr.tenant_id = u.tenant_id AND t.assignee_id = u.id
                   AND cr.created_at > now() - make_interval(weeks => $1)) AS responses,
              (SELECT round(avg(cr.rating)::numeric, 2) FROM csat_responses cr
                 JOIN tickets t ON t.tenant_id = cr.tenant_id AND t.id = cr.ticket_id
                 WHERE cr.tenant_id = u.tenant_id AND t.assignee_id = u.id
                   AND cr.created_at > now() - make_interval(weeks => $1)) AS avg_csat,
              (SELECT avg(extract(epoch FROM (fr.first_resp - t.created_at)) / 3600)
                 FROM tickets t
                 CROSS JOIN LATERAL (
                   SELECT min(m.created_at) AS first_resp FROM messages m
                    WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id AND m.author_type = 'agent'
                 ) fr
                 WHERE t.tenant_id = u.tenant_id AND t.assignee_id = u.id
                   AND t.created_at > now() - make_interval(weeks => $1)
                   AND fr.first_resp IS NOT NULL AND fr.first_resp >= t.created_at) AS avg_fr_h
         FROM users u
        ORDER BY closed DESC, agent_name`,
      [windowWeeks],
    );
    return {
      windowWeeks,
      byWeek: byWeekR.rows.map((x) => ({
        week: x.week as string,
        responses: num(x.responses),
        average: x.average == null ? null : Number(x.average),
        positive: num(x.positive),
      })),
      leaderboard: lbR.rows.map((x) => ({
        agentId: x.agent_id as string,
        agentName: (x.agent_name as string) ?? "Unknown",
        closed: num(x.closed),
        responses: num(x.responses),
        avgCsat: x.avg_csat == null ? null : Number(x.avg_csat),
        avgFirstResponseHours: x.avg_fr_h == null ? null : Math.round(Number(x.avg_fr_h) * 10) / 10,
      })),
    };
  });
}

// ── Containment funnel (Wave 5 item 19) ──────────────────────────────────────
// The headline AI-support metric: of everything customers asked, how much did AI absorb?
// Two lanes feed it. DEFLECTED = public questions answered with no ticket ever created
// (widget asks, docs-embed asks, public answer API — draft_traces rows with no ticket).
// TICKETS bucket into: aiResolved (closed, AI replied, no human agent ever typed),
// aiAssisted (AI + human both touched it), humanOnly, and untouched (no agent-side reply
// yet — the open backlog). Containment rate = aiResolved / handled tickets.

export interface ContainmentWeek {
  week: string;
  deflected: number;
  aiResolved: number;
  aiAssisted: number;
  humanOnly: number;
  untouched: number;
  containment: number | null; // % of handled (aiResolved+aiAssisted+humanOnly) resolved by AI alone
}

export interface ContainmentReport {
  windowWeeks: number;
  totals: {
    deflected: number;
    created: number;
    aiResolved: number;
    aiAssisted: number;
    humanOnly: number;
    untouched: number;
    containment: number | null;
    deflectionShare: number | null; // deflected / (deflected + created)
  };
  byWeek: ContainmentWeek[];
}

export async function getContainment(tenantId: string, weeks = 8): Promise<ContainmentReport> {
  const windowWeeks = Math.min(Math.max(weeks, 1), 26);
  return withTenant(tenantId, async (c) => {
    // Per-ticket AI/human involvement, bucketed per creation week. auto=true marks an
    // AI-sent message; a human agent message is agent-authored AND NOT auto (approval-queue
    // sends count as human — a person reviewed and pressed send).
    const tickR = await c.query(
      `SELECT to_char(date_trunc('week', t.created_at), 'YYYY-MM-DD') AS week,
              count(*)::int AS created,
              count(*) FILTER (WHERE has_auto AND NOT has_human AND t.status = 'closed')::int AS ai_resolved,
              count(*) FILTER (WHERE has_auto AND has_human)::int AS ai_assisted,
              count(*) FILTER (WHERE has_human AND NOT has_auto)::int AS human_only,
              count(*) FILTER (WHERE NOT has_human AND NOT (has_auto AND t.status = 'closed'))::int AS untouched
         FROM tickets t
         CROSS JOIN LATERAL (
           SELECT COALESCE(bool_or(m.auto), false) AS has_auto,
                  COALESCE(bool_or(m.author_type = 'agent' AND NOT COALESCE(m.auto, false)), false) AS has_human
             FROM messages m WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id
         ) inv
        WHERE t.created_at > now() - make_interval(weeks => $1)
          AND t.merged_into IS NULL
        GROUP BY 1 ORDER BY 1`,
      [windowWeeks],
    );
    // Deflected: live public questions that never attached to a ticket.
    const deflR = await c.query(
      `SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week, count(*)::int AS n
         FROM draft_traces
        WHERE source = 'live' AND ticket_id IS NULL
          AND created_at > now() - make_interval(weeks => $1)
        GROUP BY 1 ORDER BY 1`,
      [windowWeeks],
    );

    const deflByWeek = new Map<string, number>(deflR.rows.map((x: { week: string; n: unknown }) => [x.week, num(x.n)]));
    const weeksSet = new Set<string>([...tickR.rows.map((x) => x.week as string), ...deflByWeek.keys()]);
    const rate = (ai: number, assisted: number, human: number): number | null => {
      const handled = ai + assisted + human;
      return handled > 0 ? Math.round((ai / handled) * 1000) / 10 : null;
    };

    const byWeek: ContainmentWeek[] = [...weeksSet].sort().map((week) => {
      const t = tickR.rows.find((x) => x.week === week);
      const aiResolved = num(t?.ai_resolved), aiAssisted = num(t?.ai_assisted), humanOnly = num(t?.human_only);
      return {
        week,
        deflected: deflByWeek.get(week) ?? 0,
        aiResolved, aiAssisted, humanOnly,
        untouched: num(t?.untouched),
        containment: rate(aiResolved, aiAssisted, humanOnly),
      };
    });

    const tot = byWeek.reduce(
      (a, w) => ({
        deflected: a.deflected + w.deflected, created: a.created,
        aiResolved: a.aiResolved + w.aiResolved, aiAssisted: a.aiAssisted + w.aiAssisted,
        humanOnly: a.humanOnly + w.humanOnly, untouched: a.untouched + w.untouched,
      }),
      { deflected: 0, created: 0, aiResolved: 0, aiAssisted: 0, humanOnly: 0, untouched: 0 },
    );
    const created = tickR.rows.reduce((a, x) => a + num(x.created), 0);
    return {
      windowWeeks,
      totals: {
        ...tot,
        created,
        containment: rate(tot.aiResolved, tot.aiAssisted, tot.humanOnly),
        deflectionShare:
          tot.deflected + created > 0 ? Math.round((tot.deflected / (tot.deflected + created)) * 1000) / 10 : null,
      },
      byWeek,
    };
  });
}
