import { api } from "@/lib/api";
import type { CsatSummary } from "@/lib/csat";

export interface NpsSummary {
  responses: number;
  score: number | null;
  promoters: number;
  passives: number;
  detractors: number;
  distribution: { score: number; count: number }[];
}

export interface AnalyticsOverview {
  totals: { total: number; open: number; closed: number };
  byPriority: { priority: string; count: number }[];
  bySentiment: { positive: number; neutral: number; negative: number };
  byChannel: { channel: string; count: number }[];
  byLanguage: { locale: string; label: string; count: number }[];
  topTags: { tag: string; count: number }[];
  resolution: { avgHours: number | null; medianHours: number | null; p90Hours: number | null; closedCount: number };
  responseTime: { avgHours: number | null; medianHours: number | null; p90Hours: number | null; respondedCount: number };
  byAgent: { agentId: string; agentName: string; assigned: number; closed: number; avgResolutionHours: number | null }[];
  volume: { day: string; count: number }[];
  deflection: { autoRepliedTickets: number; aiMessages: number; agentMessages: number; rate: number };
  csat: CsatSummary;
  nps: NpsSummary;
}

export async function fetchOverview(): Promise<AnalyticsOverview> {
  return (await api<{ overview: AnalyticsOverview }>("/analytics/overview")).overview;
}

// Live workload snapshot — "waiting" = open tickets where it's our turn to reply (the queue
// that ages into SLA breaches); closedToday = closed since UTC midnight. byAgent includes
// idle agents (0/0/0) on purpose — the view exists to spot imbalance.
export interface WorkloadReport {
  totals: { open: number; waiting: number; unassigned: number };
  byAgent: { agentId: string; agentName: string; role: string; outOfOffice: boolean; oooUntil: string | null; open: number; waiting: number; closedToday: number }[];
  byTeam: { teamId: string; teamName: string; emoji: string | null; memberCount: number; open: number; waiting: number; unassigned: number; closedToday: number }[];
}

export async function fetchWorkload(): Promise<WorkloadReport> {
  return (await api<{ workload: WorkloadReport }>("/analytics/workload")).workload;
}

// SLA attainment over a trailing window. fr = first-response target, res = resolution
// target; a target counts only once DECIDED (met or breached). frRate/resRate are
// met-percentages (0–100, 1 decimal, null when nothing decided); pending = tickets with
// neither target decided yet. Same business-hours-aware math as the inbox SLA badges.
export interface SlaReport {
  enabled: boolean; // false = the tenant's SLA policy is off
  windowWeeks: number;
  totals: {
    tickets: number;
    frMet: number;
    frBreached: number;
    resMet: number;
    resBreached: number;
    frRate: number | null;
    resRate: number | null;
    pending: number;
  };
  byWeek: {
    week: string; // ISO Monday yyyy-mm-dd
    tickets: number;
    frMet: number;
    frBreached: number;
    resMet: number;
    resBreached: number;
    avgFrHours: number | null;
    avgResHours: number | null;
  }[];
  byPriority: { priority: string; tickets: number; frMet: number; frBreached: number; resMet: number; resBreached: number }[];
  byTeam: { teamId: string | null; teamName: string; tickets: number; frMet: number; frBreached: number; resMet: number; resBreached: number }[];
}

export async function fetchSlaReport(weeks = 8): Promise<SlaReport> {
  return (await api<{ report: SlaReport }>(`/analytics/sla?weeks=${weeks}`)).report;
}

// ── Ops dashboard (Wave 4 item 15) — mirrors the api's OpsDashboard ──────────

export interface OpsTicketRef {
  id: string;
  subject: string;
  contactName: string | null;
  teamName: string | null;
  priority: string;
  /** oldest-waiting: waiting since; breaching: the due time. */
  at: string;
  target?: string; // breaching rows: "first_response" | "resolution"
  state?: string;  // "at_risk" | "breached"
}

export interface OpsDashboard {
  queue: { open: number; waiting: number; unassigned: number; snoozed: number };
  today: { created: number; closed: number };
  oldestWaiting: OpsTicketRef[];
  breaching: OpsTicketRef[];
  slaEnabled: boolean;
}

export async function fetchOps(): Promise<OpsDashboard> {
  return (await api<{ ops: OpsDashboard }>("/analytics/ops")).ops;
}

// ── CSAT trends + leaderboard (Wave 4 item 16) ───────────────────────────────

export interface CsatReport {
  byWeek: { week: string; responses: number; average: number | null; positive: number }[];
  leaderboard: {
    agentId: string; agentName: string;
    closed: number; responses: number; avgCsat: number | null;
    avgFirstResponseHours: number | null;
  }[];
  windowWeeks: number;
}

export async function fetchCsatReport(weeks = 12): Promise<CsatReport> {
  return (await api<{ report: CsatReport }>(`/analytics/csat-report?weeks=${weeks}`)).report;
}

// ── Containment funnel (Wave 5 item 19) ──────────────────────────────────────

export interface ContainmentWeek {
  week: string;
  deflected: number;
  aiResolved: number;
  aiAssisted: number;
  humanOnly: number;
  untouched: number;
  containment: number | null;
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
    deflectionShare: number | null;
  };
  byWeek: ContainmentWeek[];
}

export async function fetchContainment(weeks = 8): Promise<ContainmentReport> {
  return (await api<{ containment: ContainmentReport }>(`/analytics/containment?weeks=${weeks}`)).containment;
}
