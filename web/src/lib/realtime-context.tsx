import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Socket, Presence } from "phoenix";
import {
  EDGE_URL,
  type EdgeEvent,
  type PresenceMeta,
  type PresencePatch,
  type PresenceUser,
  type RtStatus,
} from "@/lib/realtime";
import { useAuth } from "@/auth/auth";
import { getToken } from "@/lib/api";

/**
 * App-wide realtime layer. One socket + one tenant channel (`tickets:<tenantId>`)
 * for the whole session, mounted once near the root. Everything multiplayer hangs
 * off this: a live event bus any route can tap, tenant-wide presence, per-agent
 * viewing/typing broadcast, and a lightweight round-trip latency read.
 */
export interface RealtimeApi {
  /** Socket/channel connection state. */
  status: RtStatus;
  /** Measured push→ack round-trip in ms, or null before the first sample. */
  latencyMs: number | null;
  /** Rolling count of `new_event`s seen in the last 60s. */
  eventsPerMin: number;
  /** Everyone currently online on the tenant channel (includes you). */
  presence: PresenceUser[];
  /** Everyone online except you — for "who else is here" UI. */
  others: PresenceUser[];
  /** Your own user id (from the session), or null before auth resolves. */
  myId: string | null;
  /** Broadcast a change to your presence (viewing / typing a ticket). Debounced-safe: cheap to call. */
  setPresence: (patch: PresencePatch) => void;
  /** Subscribe to every `new_event`. Returns an unsubscribe fn. Stable identity. */
  subscribe: (fn: (e: EdgeEvent) => void) => () => void;
  /** Force a fresh socket connection (tear down + reconnect) — a manual retry affordance. */
  reconnect: () => void;
}

const RealtimeContext = createContext<RealtimeApi | null>(null);

/** Access the app-wide realtime layer. Safe to call outside the provider — returns a null-object. */
export function useRealtime(): RealtimeApi {
  const ctx = useContext(RealtimeContext);
  return ctx ?? NULL_API;
}

/**
 * Refetch a surface live when a relevant event arrives. Subscribes to the tenant bus, keeps only
 * events whose `type` starts with one of `prefixes` (e.g. "contact.", "company."), and calls
 * `refetch` — coalescing bursts into one call (250ms) so a bulk change is a single reload. The
 * `prefixes`/`refetch` are read through a ref, so callers can pass inline values without
 * re-subscribing every render. One line to make any list/detail surface live.
 */
export function useLiveRefresh(prefixes: string[], refetch: () => void) {
  const { subscribe } = useRealtime();
  const ref = useRef({ prefixes, refetch });
  ref.current = { prefixes, refetch };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribe((e) => {
      if (!ref.current.prefixes.some((p) => e.type.startsWith(p))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => ref.current.refetch(), 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [subscribe]);
}

// When no provider is mounted (e.g. the login screen), consumers still render.
const NULL_API: RealtimeApi = {
  status: "connecting",
  latencyMs: null,
  eventsPerMin: 0,
  presence: [],
  others: [],
  myId: null,
  setPresence: () => {},
  subscribe: () => () => {},
  reconnect: () => {},
};

function flattenPresence(presence: Presence): PresenceUser[] {
  return presence
    .list((id: string, entry: { metas: PresenceMeta[] }) => {
      const meta = entry.metas[entry.metas.length - 1] ?? ({} as PresenceMeta);
      return {
        user_id: (meta.user_id as string) ?? id,
        name: meta.name ?? "Someone",
        online_at: meta.online_at ?? "",
        viewing: meta.viewing ?? null,
        typing: meta.typing ?? null,
      } satisfies PresenceUser;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? null;
  const myId = user?.id ?? null;

  const [status, setStatus] = useState<RtStatus>("connecting");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [eventsPerMin, setEventsPerMin] = useState(0);
  // Bumping this nonce tears down and recreates the socket — a manual reconnect.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const reconnect = useRef(() => setReconnectNonce((n) => n + 1)).current;

  // Live-event fan-out: consumers register here; the channel handler calls them all.
  const listeners = useRef(new Set<(e: EdgeEvent) => void>());
  // Timestamps of recent events, pruned to a 60s window for events/min.
  const eventTimes = useRef<number[]>([]);
  // The presence we want to broadcast; merged across partial patches.
  const desired = useRef<{ viewing: string | null; typing: string | null }>({
    viewing: null,
    typing: null,
  });
  // A push fn wired once the channel joins; buffers the latest desired state otherwise.
  const pushPresence = useRef<() => void>(() => {});

  const subscribe = useRef((fn: (e: EdgeEvent) => void) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }).current;

  const setPresencePatch = useRef((patch: PresencePatch) => {
    if (patch.viewing !== undefined) desired.current.viewing = patch.viewing;
    if (patch.typing !== undefined) desired.current.typing = patch.typing;
    pushPresence.current();
  }).current;

  useEffect(() => {
    if (!tenantId) {
      setStatus("connecting");
      setPresence([]);
      return;
    }
    setStatus("connecting");

    const socket = new Socket(`${EDGE_URL}/socket`, {
      params: { token: getToken() ?? "" },
      reconnectAfterMs: (tries) => [500, 1000, 2000, 5000][tries - 1] ?? 5000,
    });
    socket.onError(() => setStatus("down"));
    socket.onClose(() => setStatus("down"));
    socket.connect();

    const channel = socket.channel(`tickets:${tenantId}`, {});
    const presenceTracker = new Presence(channel);
    presenceTracker.onSync(() => setPresence(flattenPresence(presenceTracker)));

    channel.on("new_event", (payload) => {
      const now = Date.now();
      eventTimes.current.push(now);
      const evt = payload as EdgeEvent;
      listeners.current.forEach((fn) => {
        try {
          fn(evt);
        } catch {
          /* one bad listener must not sink the bus */
        }
      });
      // recompute events/min immediately on activity
      const cutoff = now - 60_000;
      eventTimes.current = eventTimes.current.filter((t) => t >= cutoff);
      setEventsPerMin(eventTimes.current.length);
    });

    let joined = false;
    // Push the merged desired presence and time the ack for a latency read.
    const doPush = () => {
      if (!joined) return;
      const sentAt = performance.now();
      channel
        .push("presence_update", { ...desired.current })
        .receive("ok", () => setLatencyMs(Math.round(performance.now() - sentAt)));
    };
    pushPresence.current = doPush;

    channel
      .join()
      .receive("ok", () => {
        joined = true;
        setStatus("live");
        doPush(); // announce our initial viewing/typing + prime latency
      })
      .receive("error", () => setStatus("down"));

    // Keepalive + fresh latency sample; also prunes the events/min window.
    const heartbeat = setInterval(() => {
      doPush();
      const cutoff = Date.now() - 60_000;
      eventTimes.current = eventTimes.current.filter((t) => t >= cutoff);
      setEventsPerMin(eventTimes.current.length);
    }, 15_000);

    return () => {
      clearInterval(heartbeat);
      joined = false;
      pushPresence.current = () => {};
      channel.leave();
      socket.disconnect();
    };
  }, [tenantId, reconnectNonce]);

  const others = useMemo(
    () => presence.filter((p) => p.user_id !== myId),
    [presence, myId],
  );

  const value = useMemo<RealtimeApi>(
    () => ({
      status,
      latencyMs,
      eventsPerMin,
      presence,
      others,
      myId,
      setPresence: setPresencePatch,
      subscribe,
      reconnect,
    }),
    [status, latencyMs, eventsPerMin, presence, others, myId, setPresencePatch, subscribe, reconnect],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
