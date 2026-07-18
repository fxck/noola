import { Socket } from "phoenix";

// The Phoenix edge relays outbox events (NATS → channel). Base URL only; the Phoenix client
// appends `/websocket`. A production build MUST inject VITE_EDGE_URL; the dev/stage fallback to
// the durable stage edge is scoped to `import.meta.env.DEV` so a prod build fails loud rather
// than silently wiring realtime to stage. Stage builds set VITE_EDGE_URL explicitly (zerops.yaml).
function resolveEdgeUrl(): string {
  const explicit = import.meta.env.VITE_EDGE_URL as string | undefined;
  if (explicit) return explicit;
  if (import.meta.env.DEV) return "wss://edgestage-561-4000.prg1.zerops.app";
  throw new Error(
    "VITE_EDGE_URL must be set for a production build — refusing to silently fall back to the stage edge.",
  );
}
export const EDGE_URL = resolveEdgeUrl();

/** The event envelope the api emits and the edge fans out as "new_event". */
export interface EdgeEvent {
  id: string;
  type: string;
  tenantId: string;
  ticketId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export type RtStatus = "connecting" | "live" | "down";

/** One presence meta on the tenant channel — who's online and what they're on. */
export interface PresenceMeta {
  user_id: string;
  name: string;
  online_at: string;
  /** Ticket id the person is currently reading, or null. */
  viewing: string | null;
  /** Ticket id the person is currently composing on, or null. */
  typing: string | null;
}

/** A flattened presence entry (one row per online user, latest meta). */
export interface PresenceUser {
  user_id: string;
  name: string;
  online_at: string;
  viewing: string | null;
  typing: string | null;
}

/** The partial state a client broadcasts via `channel.push("presence_update", …)`. */
export interface PresencePatch {
  viewing?: string | null;
  typing?: string | null;
}

/**
 * Open a tenant-scoped Phoenix channel (`tickets:<tenantId>`) and invoke
 * `onEvent` for every "new_event" broadcast. Returns a disconnect fn.
 *
 * The session Bearer token is sent as the socket `token` param: the edge
 * verifies it against the api and derives the tenant server-side, then rejects
 * any join whose topic tenant ≠ the session's. Without a token the connect is
 * refused, so realtime carries the same tenant boundary as the HTTP path.
 */
export function connectTenantChannel(
  tenantId: string,
  handlers: { onEvent: (e: EdgeEvent) => void; onStatus?: (s: RtStatus) => void },
  token: string | null,
): () => void {
  handlers.onStatus?.("connecting");
  const socket = new Socket(`${EDGE_URL}/socket`, {
    params: { token: token ?? "" },
    reconnectAfterMs: (tries) => [500, 1000, 2000, 5000][tries - 1] ?? 5000,
  });
  socket.onError(() => handlers.onStatus?.("down"));
  socket.onClose(() => handlers.onStatus?.("down"));
  socket.connect();

  const channel = socket.channel(`tickets:${tenantId}`, {});
  channel.on("new_event", (payload) => handlers.onEvent(payload as EdgeEvent));
  channel
    .join()
    .receive("ok", () => handlers.onStatus?.("live"))
    .receive("error", () => handlers.onStatus?.("down"));

  return () => {
    channel.leave();
    socket.disconnect();
  };
}
