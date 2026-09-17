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
  /** Fencing token from this claim (0119). Every lease extension + finalize matches on it. */
  lease_token?: string;
}

/** Stable Discord nonce for a relay row (<= 25 chars; Discord's cap). The same row sends the same
 *  nonce on every attempt, and the deliverer posts with enforce_nonce — so when an earlier attempt's
 *  write lands late (after its deadline tripped), Discord returns that message instead of creating a
 *  second copy. Per-chunk suffixes are added by the transport. */
export function relayNonce(rowId: string): string {
  return `nr${rowId}`.slice(0, 21);
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
 *  (it logs; the message is still persisted in Noola, only its mirror copy is at risk).
 *
 *  `reapply` (reactions only): an already-finished row with the same key is reset to pending instead of
 *  ignored — for acks that must be re-asserted on each gesture. Never use it for messages/notes. */
export async function enqueueRelay(
  kind: RelayKind,
  tenantId: string,
  ticketId: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
  opts: { reapply?: boolean } = {},
): Promise<void> {
  const reapply = opts.reapply === true && kind === "react";
  try {
    await relayPool.query(
      reapply
        ? `INSERT INTO discord_relay_outbox (tenant_id, ticket_id, kind, dedupe_key, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (dedupe_key) DO UPDATE
             SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL,
                 payload = EXCLUDED.payload, updated_at = now()
           WHERE discord_relay_outbox.status <> 'pending'`
        : `INSERT INTO discord_relay_outbox (tenant_id, ticket_id, kind, dedupe_key, payload)
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
// the row is re-leased later instead of the loop stalling. A tripped write may still land later in
// discord.js's queue — which used to make this at-least-once and, combined with a deliverer that
// waited on a rate-limited forum sync AFTER posting, re-posted one message on every attempt (prod
// incident, see 0119). Now: the deliverer returns as soon as the write lands (no follow-up work inside
// the deadline), every post carries the row's stable nonce with enforce_nonce so Discord collapses a
// late-landing retry, and each claim is fenced by a lease token so two drainers never deliver one row.
const DELIVER_DEADLINE_MS = 20_000;
// Lease: taken on claim and RE-TAKEN right before each row's Discord call, so the full lease always
// covers the deliver deadline (a batch is delivered sequentially — without the re-take, rows late in a
// slow batch outlived their lease and a second api container could claim and deliver them again).
const LEASE_SECONDS = 60;
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

const DELIVER_CONCURRENCY = 5;

/** Fence, deliver and finalize ONE claimed row. Every write back to the row matches this claim's lease
 *  token, so a drainer that lost its lease can't deliver or record an outcome over the new owner. */
async function deliverClaimedRow(deliver: (row: RelayRow) => Promise<DeliverResult>, row: RelayRow): Promise<void> {
  // Re-take the lease immediately before the slow Discord call. No row back = our lease lapsed and
  // another drainer owns this row now — skip it rather than deliver it a second time.
  const fenced = await relayPool
    .query(
      `UPDATE discord_relay_outbox
          SET next_attempt_at = now() + ($3 || ' seconds')::interval, updated_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'pending'
        RETURNING id`,
      [row.id, row.lease_token, String(LEASE_SECONDS)],
    )
    .catch(() => null);
  if (!fenced?.rowCount) return;

  let res: DeliverResult;
  try {
    res = await withDeadline(deliver(row), DELIVER_DEADLINE_MS);
  } catch (e) {
    res = { ok: false, retriable: true, error: (e as Error)?.message ?? String(e) };
  }

  if (res.ok) {
    await relayPool
      .query(
        "UPDATE discord_relay_outbox SET status = 'delivered', delivered_at = now(), last_error = $2, updated_at = now() WHERE id = $1 AND lease_token = $3",
        [row.id, res.error ?? null, row.lease_token],
      )
      .catch(() => {});
    return;
  }

  if (!res.retriable || row.attempts >= row.max_attempts) {
    // Terminal: a non-retriable miss (source row gone) or the retry ceiling. Dead-letter + log loud so a
    // persistently-undeliverable mirror (e.g. the bot was removed from the guild) is visible.
    await relayPool
      .query("UPDATE discord_relay_outbox SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND lease_token = $3", [
        row.id,
        res.error ?? "gave up",
        row.lease_token,
      ])
      .catch(() => {});
    try {
      console.error(`[discord-relay] gave up on ${row.kind} for ticket ${row.ticket_id} after ${row.attempts} attempt(s): ${res.error ?? "unknown"}`);
    } catch { /* noop */ }
    return;
  }

  // Retriable: exponential backoff (5s·2^attempts, capped at 15 min), keep it pending.
  await relayPool
    .query(
      `UPDATE discord_relay_outbox
          SET next_attempt_at = now() + LEAST(interval '5 seconds' * pow(2, attempts), interval '15 minutes'),
              last_error = $2,
              updated_at = now()
        WHERE id = $1 AND lease_token = $3`,
      [row.id, res.error ?? null, row.lease_token],
    )
    .catch(() => {});
}

let draining = false;

/**
 * Drain due Discord-relay rows. Single-flight per process (the module-level flag); across api containers
 * FOR UPDATE SKIP LOCKED + a per-claim lease token (0119) ensure a row is delivered by one drainer only.
 * Each row: claim it (short txn, no I/O under lock), re-take the lease, perform the Discord write behind
 * a deadline OUTSIDE any lock, then finalize — delivered, backed-off retry, or dead-lettered 'failed'.
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
              lease_token = gen_random_uuid(),
              next_attempt_at = now() + ($1 || ' seconds')::interval,
              updated_at = now()
        WHERE o.id IN (
          SELECT id FROM discord_relay_outbox
           WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED
           LIMIT ${CLAIM_BATCH}
        )
      RETURNING id, tenant_id, ticket_id, kind, payload, attempts, max_attempts, lease_token`,
      [String(LEASE_SECONDS)],
    );
    if (!claimed.rowCount) return;

    const dm = await import("./discord-mirror.js");
    // Deliver per ticket IN PARALLEL (bounded), each ticket's rows in order. The old loop delivered the
    // whole batch one row at a time, so a single thread stuck on Discord's rate limit held up every other
    // ticket's writes for (rows × 20s) — e.g. a 📤-promote's ✅ confirmation queued behind another
    // ticket's stalled relays and dead-lettered. Order within a ticket is preserved so relayed messages
    // still appear in the thread in the order they were written.
    const byTicket = new Map<string, RelayRow[]>();
    for (const raw of claimed.rows) {
      const row = raw as RelayRow;
      const list = byTicket.get(row.ticket_id);
      if (list) list.push(row);
      else byTicket.set(row.ticket_id, [row]);
    }
    const groups = [...byTicket.values()];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const group = groups[next++];
        if (!group) return;
        for (const row of group) await deliverClaimedRow(dm.deliverRelayRow, row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DELIVER_CONCURRENCY, groups.length) }, worker));
  } catch (err) {
    try { console.warn(`[discord-relay] drain failed: ${(err as Error)?.message ?? String(err)}`); } catch { /* noop */ }
  } finally {
    draining = false;
  }
}
