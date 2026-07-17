import { withTenant } from "@repo/db";
import { StringCodec } from "nats";
import { getNatsConnection } from "./nats-conn.js";

// ── Runner runs — the api PRODUCER for the agent-studio execution runner ──────
// A run is enqueued by INSERTing a runner_runs row (status 'queued') AND an outbox row on
// subject `jobs.run` in ONE transaction (withTenant runs inside a tenant-scoped txn). The
// existing single-writer outbox drainer (server.ts) then publishes it → JetStream routes
// `jobs.run` into the RUNS stream → the `runner` docker service consumes and launches ONE
// ephemeral container per job. Reusing the transactional outbox (atomic with the row,
// at-least-once) beats a second NATS client in the request path — the enqueue can't succeed
// while the row write rolls back, or vice versa. Slice A: rows stay 'queued' (the skeleton
// container just echoes); slice B: the worker records lifecycle (started_at/result/finished_at).
// All RLS-scoped via withTenant.

export interface RunnerRun {
  id: string;
  status: string;
  kind: string;
  payload: Record<string, unknown>;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  // Structured flow-container output (0081): produced items + per-node trace. Null for non-flow runs.
  resultJson: unknown;
  nodeEvents: unknown[];
  /** Object-storage key of the run's .webm replay (0092); null when nothing was recorded. */
  replayKey: string | null;
}

function iso(v: unknown): string | null {
  return v ? new Date(v as string).toISOString() : null;
}

function mapRun(r: Record<string, unknown>): RunnerRun {
  return {
    id: r.id as string,
    status: r.status as string,
    kind: r.kind as string,
    payload: (r.payload as Record<string, unknown>) ?? {},
    result: (r.result as string) ?? null,
    error: (r.error as string) ?? null,
    createdAt: iso(r.created_at) as string,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    resultJson: r.result_json ?? null,
    nodeEvents: Array.isArray(r.node_events) ? (r.node_events as unknown[]) : [],
    replayKey: (r.replay_key as string) ?? null,
  };
}

/** Enqueue a run: create a queued runner_runs row + an outbox `jobs.run` job in one txn, so the
 *  job is published (by the drainer) iff the row commits. Returns the new run's id + status; the
 *  runner consumes the job asynchronously. `payload.cmd` is the command the run container runs. */
export async function createRun(
  tenantId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; status: string }> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO runner_runs (tenant_id, kind, payload, status) VALUES (current_tenant(), $1, $2::jsonb, 'queued') RETURNING id, status",
      [kind, JSON.stringify(payload)],
    );
    const run = r.rows[0] as { id: string; status: string };
    // Transactional enqueue onto jobs.run via the same outbox the edge drainer flushes. The
    // worker's job contract is {runId, cmd}; tenantId rides along for slice B's per-tenant writes.
    // `mode`/`url` carry a browser render job (browser_extract) — omitted (empty) for plain runs.
    await c.query(
      "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), 'job.run', 'jobs.run', $1::jsonb)",
      [JSON.stringify({
        runId: run.id, tenantId,
        cmd: payload.cmd ?? "", creds: payload.creds ?? [],
        mode: payload.mode ?? "", url: payload.url ?? "",
        // `flow`-mode jobs carry the whole graph + the seed item; the Go worker passes them to the
        // flow-runner container as GRAPH/INPUT env. Serialize to strings (Job.Graph/Input are strings).
        graph: payload.graph != null ? (typeof payload.graph === "string" ? payload.graph : JSON.stringify(payload.graph)) : "",
        input: payload.input != null ? (typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input)) : "",
      })],
    );
    return { id: run.id, status: run.status };
  });
}

/** List a tenant's recent runs (newest first). */
export async function listRuns(tenantId: string, limit = 50): Promise<RunnerRun[]> {
  const cap = Math.min(Math.max(limit, 1), 200);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, status, kind, payload, result, error, created_at, started_at, finished_at, result_json, node_events, replay_key FROM runner_runs ORDER BY created_at DESC LIMIT $1",
      [cap],
    );
    return r.rows.map(mapRun);
  });
}

/** Fetch a single runner run by id (RLS-scoped). */
export async function getRun(tenantId: string, id: string): Promise<RunnerRun | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, status, kind, payload, result, error, created_at, started_at, finished_at, result_json, node_events, replay_key FROM runner_runs WHERE id = $1",
      [id],
    );
    return r.rowCount ? mapRun(r.rows[0] as Record<string, unknown>) : null;
  });
}

/** A per-node progress frame the flow container publishes to core-NATS `run.<id>` while it
 *  executes: node-start / node-done (status+detail+ms) / agent-step (the browser agent's own
 *  action + reasoning per step) / run-done. */
export interface RunProgressEvent {
  type: string;
  nodeId?: string;
  /** base64 JPEG payload on "frame" events (live browser preview). */
  data?: string;
  kind?: string;
  status?: string;
  detail?: string;
  n?: number;
  action?: string;
  reasoning?: string;
  ok?: boolean;
}

/** Live-subscribe to a run's progress channel. Core NATS (ephemeral, at-most-once — fine: the
 *  authoritative trace lands in runner_runs.node_events regardless; this feeds the interactive
 *  canvas only). Returns an unsubscribe. No connection → no-op (the terminal replay still works). */
export function subscribeRunProgress(
  runId: string,
  onEvent: (e: RunProgressEvent) => void,
): () => void {
  const nc = getNatsConnection();
  if (!nc) return () => {};
  const sc = StringCodec();
  const sub = nc.subscribe(`run.${runId}`);
  void (async () => {
    for await (const m of sub) {
      try {
        onEvent(JSON.parse(sc.decode(m.data)) as RunProgressEvent);
      } catch {
        /* malformed frame — skip */
      }
    }
  })();
  return () => {
    try { sub.unsubscribe(); } catch { /* already closed */ }
  };
}

/** Poll a run until it reaches a terminal state (succeeded/failed) or the timeout elapses.
 *  Closes the run loop for a live flow execution: the runner (a separate service) writes the
 *  terminal row asynchronously, so we poll for it. Returns the terminal run, or the last-seen
 *  row (still queued/running) on timeout, or null if the row vanished. */
export async function awaitRunTerminal(
  tenantId: string,
  id: string,
  timeoutMs = 30_000,
): Promise<RunnerRun | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(tenantId, id);
    if (run && (run.status === "succeeded" || run.status === "failed")) return run;
    if (Date.now() >= deadline) return run;
    await new Promise((r) => setTimeout(r, 400));
  }
}
