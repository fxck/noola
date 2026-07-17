import { api } from "@/lib/api";

// The tamper-evident audit log. Each entry is a link in a per-tenant HMAC hash-chain; `verify`
// recomputes the whole chain and confirms nothing was edited/deleted/reordered after the fact.

export interface AuditEntry {
  seq: number;
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string | null;
  meta: Record<string, unknown>;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  count: number;
  brokenAt?: number;
  reason?: string;
}

export async function fetchAudit(params: { before?: number; limit?: number } = {}): Promise<AuditEntry[]> {
  const q = new URLSearchParams();
  if (params.before != null) q.set("before", String(params.before));
  if (params.limit != null) q.set("limit", String(params.limit));
  const qs = q.toString();
  return (await api<{ entries: AuditEntry[] }>(`/audit${qs ? `?${qs}` : ""}`)).entries;
}

export async function verifyAudit(): Promise<AuditVerifyResult> {
  return api<AuditVerifyResult>("/audit/verify");
}
