import { relayPool } from "@repo/db";
import { sendBroadcast, runContinuousTick, inSendWindow, type BroadcastSendFn, type BroadcastDispatchFn } from "./broadcasts.js";

// The broadcast scheduler — one interval worker (server.ts, 30s) covering both delivery
// modes: fire due 'scheduled' oneshots, and tick every 'active' continuous broadcast
// (re-resolve audience, send once to first-time matchers, honor stop_at). Discovery is a
// cross-tenant relayPool scan (event_relay is BYPASSRLS; broadcasts_scheduler_idx keeps it
// O(live rows)); all mutation goes back through the tenant-scoped broadcast functions.
// Same discipline as detectSlaBreaches: a running-flag skip (no overlapping scans) and
// per-row error isolation (one tenant's failure never starves the rest).

type SchedLog = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

let running = false;

export async function runBroadcastScheduler(
  log?: SchedLog,
  opts: { send?: BroadcastSendFn; dispatch?: BroadcastDispatchFn; now?: Date } = {},
): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = opts.now ?? new Date();
    const r = await relayPool.query(
      `SELECT tenant_id, id, status, window_days, window_start_min, window_end_min, window_tz_offset_min
         FROM broadcasts WHERE (status = 'scheduled' AND send_at <= $1) OR status = 'active'`,
      [now],
    );
    for (const row of r.rows as Array<{
      tenant_id: string; id: string; status: string;
      window_days: number[] | null; window_start_min: number | null; window_end_min: number | null; window_tz_offset_min: number | null;
    }>) {
      try {
        // Send window (0072): a due send outside the window just waits — the next tick inside
        // the window fires it. Applies to scheduled fires AND continuous ticks.
        if (!inSendWindow(row, now)) continue;
        if (row.status === "scheduled") {
          const out = await sendBroadcast(row.tenant_id, row.id, opts);
          await out?.done;
          if (out) log?.info({ broadcastId: row.id, status: out.status }, "scheduler: fired scheduled broadcast");
        } else {
          const out = await runContinuousTick(row.tenant_id, row.id, opts);
          await out?.done;
          if (out && out.sent > 0) {
            log?.info({ broadcastId: row.id, sent: out.sent }, "scheduler: continuous tick sent to new matches");
          }
          if (out?.status === "stopped") log?.info({ broadcastId: row.id }, "scheduler: continuous broadcast reached stop_at");
        }
      } catch (e) {
        log?.warn({ broadcastId: row.id, err: (e as Error)?.message }, "scheduler: broadcast tick failed");
      }
    }
  } finally {
    running = false;
  }
}
