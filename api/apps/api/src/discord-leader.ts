// Single-leader handling of Discord GATEWAY EVENTS across api containers.
//
// Every api process logs the bot in (it needs the REST client for outbound writes: replies, relays,
// reactions). But a Discord bot with several concurrent gateway sessions receives EVERY event on EVERY
// session — so with two containers (prod autoscales 1→2, and rolling deploys briefly overlap) each
// reaction, message and thread update was handled twice: two "Resolved" notices, two CSAT surveys, two
// racing archive/tag sequences, duplicate notes. Only the process holding this Postgres advisory lock
// acts on gateway events; the others ignore them. The lock lives on a DEDICATED connection (not a pool
// client), so it's released the moment the holder dies, and a follower takes over within one probe.
//
// A process competes only while its gateway is connected.
// A leader whose gateway stays down longer than STEP_DOWN_AFTER_MS steps down, so a connected follower takes over.
import pg from "pg";

type LeaderLog = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

export interface LeaderOptions {
  log?: LeaderLog;
  /** When this process's gateway was last seen connected: null while connected, a timestamp while not. */
  gatewayDownSince: () => number | null;
  /** Called each time this process becomes the leader. */
  onAcquired?: () => void;
}

// Stable 64-bit-ish key for pg_try_advisory_lock(int, int): namespace + name.
const LOCK_NS = 7337;
const LOCK_KEY = 1; // noola discord gateway event leader
const PROBE_MS = 10_000;
// A resume replays the missed events to the same session, so a short drop must not hand over leadership.
const STEP_DOWN_AFTER_MS = 60_000;

let leader = false;
let conn: pg.Client | null = null;
let probing = false;
let started = false;
let opts: LeaderOptions | null = null;

/** True when this process should act on Discord gateway events. */
export function isDiscordEventLeader(): boolean {
  return leader;
}

async function dropConnection(): Promise<void> {
  const c = conn;
  conn = null;
  leader = false;
  if (c) await c.end().catch(() => {});
}

export function leaderEligible(downSince: number | null, isLeader: boolean, now = Date.now()): boolean {
  return downSince === null || (isLeader && now - downSince < STEP_DOWN_AFTER_MS);
}

function eligible(): boolean {
  return leaderEligible(opts?.gatewayDownSince() ?? null, leader);
}

async function probe(): Promise<void> {
  if (probing || !opts) return;
  const log = opts.log;
  probing = true;
  try {
    if (!eligible()) {
      if (leader) {
        log?.warn("discord: gateway disconnected for too long - stepping down as the gateway-event leader");
        await dropConnection();
      }
      return;
    }
    if (leader && conn) {
      // Still holding it? A dead connection means the lock is already gone server-side.
      await conn.query("SELECT 1").catch(async () => {
        log?.warn({}, "discord: lost the gateway-leader connection — stepping down");
        await dropConnection();
      });
      return;
    }
    if (!conn) {
      const c = new pg.Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT ?? 5432),
        database: process.env.DB_NAME,
        user: process.env.RELAY_DB_USER ?? "event_relay",
        password: process.env.RELAY_DB_PASSWORD,
      });
      // An idle client can emit 'error' asynchronously (backend restart) — without a listener that
      // would crash the process. Step down; the next probe reconnects.
      c.on("error", () => {
        if (conn !== c) return;
        if (leader) log?.warn("discord: the gateway-leader connection failed - stepping down");
        conn = null;
        leader = false;
      });
      await c.connect();
      conn = c;
    }
    const r = await conn.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS ok", [LOCK_NS, LOCK_KEY]);
    if (r.rows[0]?.ok) {
      leader = true;
      log?.info("discord: this process is the gateway-event leader");
      opts.onAcquired?.();
    } else {
      // Someone else leads; don't hold an idle connection while following.
      await dropConnection();
    }
  } catch (err) {
    log?.warn({ err }, "discord: gateway-leader probe failed");
    await dropConnection();
  } finally {
    probing = false;
  }
}

/** Start competing for gateway-event leadership. Idempotent. */
export function startDiscordLeaderElection(options: LeaderOptions): void {
  if (started) return;
  started = true;
  opts = options;
  void probe();
  const t = setInterval(() => void probe(), PROBE_MS);
  if (typeof t.unref === "function") t.unref();
}

/** Probe now instead of at the next tick, e.g. as soon as the gateway connects. */
export function probeDiscordLeaderNow(): void {
  void probe();
}
