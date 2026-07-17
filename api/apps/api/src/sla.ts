import { withTenant, relayPool } from "@repo/db";
import { emitDomainEvent, reserveOnce } from "./automations.js";

// SLA policy + per-ticket state. One policy per tenant (first-response + resolution targets in
// minutes). State is computed in the app from ticket timestamps — no stored due dates, so
// changing the policy re-derives everything.
//
// Business hours: when enabled, the target clock ticks ONLY during the configured weekly working
// window (a fixed schedule, no DST — tzOffsetMins maps UTC → the workspace's wall clock). So a
// ticket opened Friday 6pm with a 4h target is due Monday ~1pm, not Saturday.

export interface BusinessHours {
  tzOffsetMins: number;
  workdays: number[]; // 0=Sun … 6=Sat
  dayStartMin: number; // minutes past local midnight
  dayEndMin: number;
}

export interface SlaPolicy {
  firstResponseMins: number;
  resolutionMins: number;
  enabled: boolean;
  businessHoursEnabled: boolean;
  businessHours: BusinessHours;
}

const DEFAULT_BH: BusinessHours = { tzOffsetMins: 0, workdays: [1, 2, 3, 4, 5], dayStartMin: 540, dayEndMin: 1020 };
const DEFAULT_SLA: SlaPolicy = {
  firstResponseMins: 60,
  resolutionMins: 1440,
  enabled: false,
  businessHoursEnabled: false,
  businessHours: DEFAULT_BH,
};

function rowToPolicy(row: Record<string, unknown>): SlaPolicy {
  return {
    firstResponseMins: row.first_response_mins as number,
    resolutionMins: row.resolution_mins as number,
    enabled: row.enabled as boolean,
    businessHoursEnabled: (row.business_hours_enabled as boolean) ?? false,
    businessHours: {
      tzOffsetMins: (row.tz_offset_mins as number) ?? 0,
      workdays: (row.workdays as number[]) ?? DEFAULT_BH.workdays,
      dayStartMin: (row.day_start_min as number) ?? DEFAULT_BH.dayStartMin,
      dayEndMin: (row.day_end_min as number) ?? DEFAULT_BH.dayEndMin,
    },
  };
}

export async function getSlaPolicy(tenantId: string): Promise<SlaPolicy> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT first_response_mins, resolution_mins, enabled,
              business_hours_enabled, tz_offset_mins, workdays, day_start_min, day_end_min
         FROM sla_policies LIMIT 1`,
    );
    if (!r.rowCount) return DEFAULT_SLA;
    return rowToPolicy(r.rows[0]);
  });
}

export interface SlaPolicyPatch {
  firstResponseMins?: number;
  resolutionMins?: number;
  enabled?: boolean;
  businessHoursEnabled?: boolean;
  tzOffsetMins?: number;
  workdays?: number[];
  dayStartMin?: number;
  dayEndMin?: number;
}

export async function upsertSlaPolicy(tenantId: string, patch: SlaPolicyPatch): Promise<SlaPolicy> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO sla_policies
         (tenant_id, first_response_mins, resolution_mins, enabled,
          business_hours_enabled, tz_offset_mins, workdays, day_start_min, day_end_min)
       VALUES (current_tenant(),
               COALESCE($1, 60), COALESCE($2, 1440), COALESCE($3, false),
               COALESCE($4, false), COALESCE($5, 0), COALESCE($6::int[], '{1,2,3,4,5}'),
               COALESCE($7, 540), COALESCE($8, 1020))
       ON CONFLICT (tenant_id) DO UPDATE SET
         first_response_mins    = COALESCE($1, sla_policies.first_response_mins),
         resolution_mins        = COALESCE($2, sla_policies.resolution_mins),
         enabled                = COALESCE($3, sla_policies.enabled),
         business_hours_enabled = COALESCE($4, sla_policies.business_hours_enabled),
         tz_offset_mins         = COALESCE($5, sla_policies.tz_offset_mins),
         workdays               = COALESCE($6::int[], sla_policies.workdays),
         day_start_min          = COALESCE($7, sla_policies.day_start_min),
         day_end_min            = COALESCE($8, sla_policies.day_end_min),
         updated_at             = now()
       RETURNING first_response_mins, resolution_mins, enabled,
                 business_hours_enabled, tz_offset_mins, workdays, day_start_min, day_end_min`,
      [
        patch.firstResponseMins ?? null,
        patch.resolutionMins ?? null,
        patch.enabled ?? null,
        patch.businessHoursEnabled ?? null,
        patch.tzOffsetMins ?? null,
        patch.workdays ?? null,
        patch.dayStartMin ?? null,
        patch.dayEndMin ?? null,
      ],
    );
    return rowToPolicy(r.rows[0]);
  });
}

// ── Business-hours arithmetic (fixed weekly schedule, no DST) ────────────────────────────────
const DAY_MS = 86_400_000;

/** Local-midnight ms for the day containing a shifted (local) timestamp. */
function startOfLocalDay(localMs: number): number {
  return Math.floor(localMs / DAY_MS) * DAY_MS;
}

/** The wall-clock (UTC ms) at which `mins` business minutes have elapsed from `startUtcMs`. */
function addBusinessMinutes(startUtcMs: number, mins: number, bh: BusinessHours): number {
  const workdays = new Set(bh.workdays);
  const off = bh.tzOffsetMins * 60_000;
  const startL = startUtcMs + off;
  let remaining = mins;
  let dayMs = startOfLocalDay(startL);
  // Walk forward day by day; cap the search so a misconfigured (empty) schedule can't spin.
  for (let guard = 0; guard < 4000; guard++) {
    const wd = new Date(dayMs).getUTCDay();
    if (workdays.has(wd)) {
      const winStart = dayMs + bh.dayStartMin * 60_000;
      const winEnd = dayMs + bh.dayEndMin * 60_000;
      const s = Math.max(winStart, startL);
      if (winEnd > s) {
        const avail = (winEnd - s) / 60_000;
        if (avail >= remaining) return s + remaining * 60_000 - off;
        remaining -= avail;
      }
    }
    dayMs += DAY_MS;
  }
  // Fallback (no usable working window) — treat as calendar time.
  return startUtcMs + mins * 60_000;
}

export type SlaState = "ok" | "at_risk" | "breached" | "met";
export interface SlaTarget {
  dueAt: string;
  metAt: string | null;
  state: SlaState;
}
export interface TicketSla {
  firstResponse: SlaTarget;
  resolution: SlaTarget;
}

/** The fields computeSla reads off a ticket row (available on every ticket-list query). */
export interface SlaTicketInput {
  created_at: string;
  closed_at?: string | null;
  first_response_at?: string | null;
}

function target(
  createdAt: string,
  mins: number,
  metAt: string | null,
  nowMs: number,
  bh: BusinessHours | null,
): SlaTarget {
  const createdMs = new Date(createdAt).getTime();
  const dueMs = bh ? addBusinessMinutes(createdMs, mins, bh) : createdMs + mins * 60_000;
  const dueAt = new Date(dueMs).toISOString();
  if (metAt) {
    return { dueAt, metAt, state: new Date(metAt).getTime() <= dueMs ? "met" : "breached" };
  }
  if (nowMs > dueMs) return { dueAt, metAt: null, state: "breached" };
  // "at risk" once inside the last 20% of the (business or calendar) window.
  const atRiskMs = bh ? addBusinessMinutes(createdMs, mins * 0.8, bh) : dueMs - mins * 60_000 * 0.2;
  if (nowMs > atRiskMs) return { dueAt, metAt: null, state: "at_risk" };
  return { dueAt, metAt: null, state: "ok" };
}

/** Per-ticket SLA state, or null when the policy is disabled. metAt for first-response is the
 *  first agent reply; for resolution it's closed_at. Business-hours-aware when enabled. */
export function computeSla(
  policy: SlaPolicy,
  t: SlaTicketInput,
  nowMs: number = Date.now(),
): TicketSla | null {
  if (!policy.enabled) return null;
  const bh = policy.businessHoursEnabled ? policy.businessHours : null;
  return {
    firstResponse: target(t.created_at, policy.firstResponseMins, t.first_response_at ?? null, nowMs, bh),
    resolution: target(t.created_at, policy.resolutionMins, t.closed_at ?? null, nowMs, bh),
  };
}

// ── SLA-breach detector (dogfood L2-D3) ──────────────────────────────────────
// SLA state is computed, not stored, so nothing "fires" when a ticket crosses its target. This
// per-minute scan closes that gap: for every SLA-enabled tenant it computes each open ticket's
// state and raises `sla.at_risk` / `sla.breached` through the event bus — once per (ticket, target,
// level) via flow_dedupe — so flows can escalate/notify/reassign. The SLA math stays code; only the
// "act on a breach" policy is a flow. Cross-tenant read on the relay pool; overlap-guarded; never
// throws out of the interval.

let slaDetectRunning = false;

type SlaLog = { error?: (...a: unknown[]) => void };

export async function detectSlaBreaches(log?: SlaLog): Promise<void> {
  if (slaDetectRunning) return; // previous scan still in flight → skip
  slaDetectRunning = true;
  try {
    const tenants = await relayPool.query("SELECT tenant_id FROM sla_policies WHERE enabled");
    const now = Date.now();
    for (const row of tenants.rows) {
      const tenantId = row.tenant_id as string;
      try {
        const policy = await getSlaPolicy(tenantId);
        if (!policy.enabled) continue;
        const tickets = await withTenant(tenantId, async (c) => {
          const r = await c.query(
            `SELECT t.id, t.created_at, t.closed_at,
                    (SELECT min(m.created_at) FROM messages m
                       WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id AND m.author_type = 'agent') AS first_response_at
               FROM tickets t WHERE t.status = 'open'`,
          );
          return r.rows as Array<{ id: string; created_at: string; closed_at: string | null; first_response_at: string | null }>;
        });
        for (const t of tickets) {
          const sla = computeSla(policy, t, now);
          if (!sla) continue;
          const targets: Array<["first_response" | "resolution", SlaTarget]> = [
            ["first_response", sla.firstResponse],
            ["resolution", sla.resolution],
          ];
          for (const [name, tgt] of targets) {
            if (tgt.state !== "breached" && tgt.state !== "at_risk") continue;
            const event = tgt.state === "breached" ? "sla.breached" : "sla.at_risk";
            // Once per (ticket, target, level): at_risk and breached use distinct keys, so a ticket
            // that escalates ok → at_risk → breached fires each transition exactly once.
            if (await reserveOnce(tenantId, `${event}:${name}:${t.id}`)) {
              emitDomainEvent(tenantId, event, { ticketId: t.id, slaTarget: name, dueAt: tgt.dueAt });
            }
          }
        }
      } catch (e) {
        log?.error?.({ err: e, tenantId }, "sla breach detection (tenant) failed");
      }
    }
  } catch (e) {
    log?.error?.({ err: e }, "sla breach detector tick failed");
  } finally {
    slaDetectRunning = false;
  }
}
