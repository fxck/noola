import { api } from "@/lib/api";

// SLA policy + per-ticket state (computed server-side from ticket timestamps).

export interface BusinessHours {
  tzOffsetMins: number;
  workdays: number[]; // 0=Sun … 6=Sat
  dayStartMin: number;
  dayEndMin: number;
}

export interface SlaPolicy {
  firstResponseMins: number;
  resolutionMins: number;
  enabled: boolean;
  businessHoursEnabled: boolean;
  businessHours: BusinessHours;
}

/** Flat patch shape the PUT accepts (business-hours fields are top-level, not nested). */
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

export async function fetchSlaPolicy(): Promise<SlaPolicy> {
  return (await api<{ policy: SlaPolicy }>("/settings/sla")).policy;
}

export async function updateSlaPolicy(patch: SlaPolicyPatch): Promise<SlaPolicy> {
  return (await api<{ policy: SlaPolicy }>("/settings/sla", { method: "PUT", body: JSON.stringify(patch) })).policy;
}
