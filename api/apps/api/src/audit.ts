import crypto from "node:crypto";
import { withTenant } from "@repo/db";
import { prodSecret } from "./prod-secret.js";

// Tamper-evident audit log. Every sensitive mutation appends one row to a per-tenant hash-chain:
//   hash = HMAC-SHA256(secret, prev_hash || canonical(row))
// where `canonical` is a stable, field-ordered string of the row's content. Because each row's hash
// folds in the previous row's hash, editing/deleting/reordering any historical row invalidates every
// later hash — `verifyAuditChain` recomputes the whole chain and reports the first break. The secret
// lives in app env (never the DB), so an actor with only DB access can't forge a self-consistent
// chain. Writes are best-effort and off the request's critical path: an audit failure must never fail
// the underlying action (we log and move on) — but the chain it does write is verifiable.

const SECRET = prodSecret(
  "AUDIT_HMAC_SECRET (or MODEL_KEY_SECRET)",
  process.env.AUDIT_HMAC_SECRET || process.env.MODEL_KEY_SECRET,
  "noola-audit-dev-secret",
);

export interface AuditEntry {
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

export interface AuditRow {
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

/** Stable canonical serialization of the hashed fields — field order is fixed and must never change
 *  (it's baked into every stored hash). `meta` is canonicalized with sorted keys so semantically
 *  equal objects hash identically regardless of insertion order. */
function canonical(f: {
  seq: number;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}): string {
  return [
    f.seq,
    f.actorId ?? "",
    f.action,
    f.entityType,
    f.entityId ?? "",
    stableStringify(f.meta),
    f.createdAt,
  ].join("");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

function hmac(prevHash: string, canon: string): string {
  return crypto.createHmac("sha256", SECRET).update(prevHash).update("").update(canon).digest("hex");
}

/**
 * Append one entry to the tenant's audit chain. Serializes appends per tenant via a transaction-scoped
 * advisory lock so concurrent writers can't fork the chain at the same seq. Best-effort: swallows
 * errors so it never breaks the caller's mutation — call it AFTER the action has committed.
 */
export async function recordAudit(tenantId: string, entry: AuditEntry): Promise<void> {
  try {
    const createdAt = new Date().toISOString();
    const meta = entry.meta ?? {};
    await withTenant(tenantId, async (c) => {
      // One writer per tenant chain at a time (xact-scoped; released on commit).
      await c.query("SELECT pg_advisory_xact_lock(hashtext('audit:' || $1))", [tenantId]);
      const prev = await c.query(
        "SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1",
      );
      const seq = (prev.rowCount ? Number(prev.rows[0].seq) : 0) + 1;
      const prevHash = prev.rowCount ? (prev.rows[0].hash as string) : "";
      const canon = canonical({
        seq,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? "",
        entityId: entry.entityId ?? null,
        meta,
        createdAt,
      });
      const hash = hmac(prevHash, canon);
      await c.query(
        `INSERT INTO audit_log
           (tenant_id, seq, actor_id, actor_name, action, entity_type, entity_id, meta, prev_hash, hash, created_at)
         VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [
          seq,
          entry.actorId ?? null,
          entry.actorName ?? "",
          entry.action,
          entry.entityType ?? "",
          entry.entityId ?? null,
          JSON.stringify(meta),
          prevHash,
          hash,
          createdAt,
        ],
      );
    });
  } catch (e) {
    // Audit is advisory to the mutation — never throw into the caller.
    console.error("audit: record failed", (e as Error).message);
  }
}

const mapRow = (r: Record<string, unknown>): AuditRow => ({
  seq: Number(r.seq),
  id: r.id as string,
  actorId: (r.actor_id as string) ?? null,
  actorName: (r.actor_name as string) ?? "",
  action: r.action as string,
  entityType: (r.entity_type as string) ?? "",
  entityId: (r.entity_id as string) ?? null,
  meta: (r.meta as Record<string, unknown>) ?? {},
  prevHash: (r.prev_hash as string) ?? "",
  hash: r.hash as string,
  createdAt:
    r.created_at instanceof Date ? (r.created_at as Date).toISOString() : String(r.created_at),
});

/** Most-recent-first page of the tenant's audit chain. */
export async function listAudit(
  tenantId: string,
  opts: { limit?: number; before?: number; entityType?: string; entityId?: string } = {},
): Promise<{ entries: AuditRow[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return withTenant(tenantId, async (c) => {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (opts.before != null) { params.push(opts.before); clauses.push(`seq < $${params.length}`); }
    if (opts.entityType) { params.push(opts.entityType); clauses.push(`entity_type = $${params.length}`); }
    if (opts.entityId) { params.push(opts.entityId); clauses.push(`entity_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const r = await c.query(
      `SELECT seq, id, actor_id, actor_name, action, entity_type, entity_id, meta, prev_hash, hash, created_at
         FROM audit_log ${where} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    );
    return { entries: r.rows.map(mapRow) };
  });
}

export interface AuditVerifyResult {
  ok: boolean;
  count: number;
  /** First seq whose recomputed hash or chain link fails, when ok is false. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Recompute the entire tenant chain in seq order and confirm every row: contiguous seq (no gaps),
 * prev_hash matches the prior row's hash, and hash == HMAC(prev_hash, canonical(row)). Any mismatch
 * proves the log was tampered with after the fact and returns the first offending seq.
 */
export async function verifyAuditChain(tenantId: string): Promise<AuditVerifyResult> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT seq, actor_id, action, entity_type, entity_id, meta, prev_hash, hash, created_at
         FROM audit_log ORDER BY seq ASC`,
    );
    let prevHash = "";
    let expectedSeq = 0;
    for (const row of r.rows as Record<string, unknown>[]) {
      expectedSeq += 1;
      const seq = Number(row.seq);
      if (seq !== expectedSeq) {
        return { ok: false, count: r.rowCount ?? 0, brokenAt: seq, reason: `seq gap (expected ${expectedSeq})` };
      }
      if ((row.prev_hash as string) !== prevHash) {
        return { ok: false, count: r.rowCount ?? 0, brokenAt: seq, reason: "prev_hash mismatch" };
      }
      const createdAt =
        row.created_at instanceof Date ? (row.created_at as Date).toISOString() : String(row.created_at);
      const canon = canonical({
        seq,
        actorId: (row.actor_id as string) ?? null,
        action: row.action as string,
        entityType: (row.entity_type as string) ?? "",
        entityId: (row.entity_id as string) ?? null,
        meta: (row.meta as Record<string, unknown>) ?? {},
        createdAt,
      });
      if (hmac(prevHash, canon) !== (row.hash as string)) {
        return { ok: false, count: r.rowCount ?? 0, brokenAt: seq, reason: "hash mismatch" };
      }
      prevHash = row.hash as string;
    }
    return { ok: true, count: r.rowCount ?? 0 };
  });
}
