// Durable delivery for Discord ops-mirror writes. See 0113_discord_relay_outbox.sql for the why:
// mirror relays + the promote ✅ react used to go fire-and-forget into discord.js's in-memory REST
// queue, where a degraded gateway connection made them hang silently and a process restart lost them.
//
// This module is the reliable replacement. The mirror code ENQUEUES an intended write (idempotent by
// dedupe_key); a single-flight drainer leases due rows, performs the actual Discord call behind a
// deadline (so a hung connection can't wedge the loop), and records the outcome: 'delivered', or a
// backed-off retry, or 'failed' (dead-letter + loud log) after max_attempts. The write itself is
// dispatched by deliverRelayRow() in discord-mirror.ts (dynamic import here to avoid an import cycle —
// discord-mirror imports enqueueRelay from this module).
import { relayPool } from "@repo/db";

export type RelayKind = "message" | "note" | "react";

export interface RelayRow {
  id: string;
  tenant_id: string;
  ticket_id: string;
  kind: RelayKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/** The outcome the per-kind deliverer reports back to the drainer. `retriable` distinguishes a
 *  transient miss (bot offline, mirror post not created yet, Discord hiccup — back off and retry) from
 *  a terminal skip (the source row was deleted — nothing to deliver, mark done). */
export interface DeliverResult {
  ok: boolean;
  retriable: boolean;
  error?: string;
}

/** Enqueue an intended Discord-mirror write. Idempotent: the same dedupe_key is a no-op, so a retried
 *  ingest / double event never double-posts. Best-effort — a failed enqueue must never break the caller
 *  (it logs; the message is still persisted in Noola, only its mirror copy is at risk). */
export async function enqueueRelay(
  kind: RelayKind,
  tenantId: string,
  ticketId: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await relayPool.query(
      `INSERT INTO discord_relay_outbox (tenant_id, ticket_id, kind, dedupe_key, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [tenantId, ticketId, kind, dedupeKey, JSON.stringify(payload)],
    );
  } catch (e) {
    try { console.warn(`[discord-relay] enqueue failed (${kind} ${dedupeKey}): ${(e as Error)?.message ?? String(e)}`); } catch { /* noop */ }
  }
}

// A single Discord write shouldn't be able to wedge the drain loop. discord.js awaits its REST queue and
// can hang indefinitely on a degraded connection; the deadline turns that into a retriable timeout so
// the row is re-leased later instead of the loop stalling. Generous enough (20s) that normal rate-limit
// waits don't trip it. A tripped write may still land later in discord.js's queue → at-least-once, so
// the occasional duplicate mirror post under a degraded connection is the accepted trade for never
// losing one.
const DELIVER_DEADLINE_MS = 20_000;
// Lease: on claim, next_attempt_at jumps this far forward so a crashed/hung attempt is retried after the
// lease even if the process died mid-delivery. Longer than the deliver deadline.
const LEASE_SECONDS = 40;
const CLAIM_BATCH = 20;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("deliver deadline exceeded")), ms);
    if (typeof t.unref === "function") t.unref();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

let draining = false;

/**
 * Drain due Discord-relay rows. Single-flight (the module-level flag) so overlapping ticks can't stack;
 * FOR UPDATE SKIP LOCKED + the lease make it safe across multiple api containers too. Each row: lease it
 * (short txn, no I/O under lock), perform the Discord write behind a deadline OUTSIDE any lock, then
 * finalize — delivered, backed-off retry, or dead-lettered 'failed' after max_attempts.
 */
export async function drainDiscordRelay(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Lease the batch in one short transaction: push next_attempt_at forward + bump attempts so a
    // concurrent drainer (or a re-tick) skips these while we do the slow Discord I/O unlocked.
    const claimed = await relayPool.query(
      `UPDATE discord_relay_outbox o
          SET attempts = o.attempts + 1,
              next_attempt_at = now() + ($1 || ' seconds')::interval,
              updated_at = now()
        WHERE o.id IN (
          SELECT id FROM discord_relay_outbox
           WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED
           LIMIT ${CLAIM_BATCH}
        )
      RETURNING id, tenant_id, ticket_id, kind, payload, attempts, max_attempts`,
      [String(LEASE_SECONDS)],
    );
    if (!claimed.rowCount) return;

    const dm = await import("./discord-mirror.js");
    for (const raw of claimed.rows) {
      const row = raw as RelayRow;
      let res: DeliverResult;
      try {
        res = await withDeadline(dm.deliverRelayRow(row), DELIVER_DEADLINE_MS);
      } catch (e) {
        res = { ok: false, retriable: true, error: (e as Error)?.message ?? String(e) };
      }

      if (res.ok) {
        await relayPool
          .query("UPDATE discord_relay_outbox SET status = 'delivered', delivered_at = now(), last_error = $2, updated_at = now() WHERE id = $1", [row.id, res.error ?? null])
          .catch(() => {});
        continue;
      }

      if (!res.retriable || row.attempts >= row.max_attempts) {
        // Terminal: a non-retriable miss (source row gone) or the retry ceiling. Dead-letter + log loud
        // so a persistently-undeliverable mirror (e.g. the bot was removed from the guild) is visible.
        await relayPool
          .query("UPDATE discord_relay_outbox SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [row.id, res.error ?? "gave up"])
          .catch(() => {});
        try {
          console.error(`[discord-relay] gave up on ${row.kind} for ticket ${row.ticket_id} after ${row.attempts} attempt(s): ${res.error ?? "unknown"}`);
        } catch { /* noop */ }
        continue;
      }

      // Retriable: exponential backoff (5s·2^attempts, capped at 15 min), keep it pending.
      await relayPool
        .query(
          `UPDATE discord_relay_outbox
              SET next_attempt_at = now() + LEAST(interval '5 seconds' * pow(2, attempts), interval '15 minutes'),
                  last_error = $2,
                  updated_at = now()
            WHERE id = $1`,
          [row.id, res.error ?? null],
        )
        .catch(() => {});
    }
  } catch (err) {
    try { console.warn(`[discord-relay] drain failed: ${(err as Error)?.message ?? String(err)}`); } catch { /* noop */ }
  } finally {
    draining = false;
  }
}
