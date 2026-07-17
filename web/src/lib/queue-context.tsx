import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/auth/auth";
import { useRealtime } from "@/lib/realtime-context";
import { fetchQueue, type QueueItem } from "@/lib/autoreply";
import type { ApiError } from "@/lib/api";

/**
 * App-wide approval-queue layer. One place owns the pending drafts so the nav
 * count badge, the /queue page, and the in-ticket "Suggested reply" card all read
 * the same list and stay in lockstep. Refetches on a realtime `new_event` (a new
 * inbound may enqueue a draft) and after any action. A 404 (endpoint not wired
 * yet) is treated as an empty queue, not an error — degrade gracefully.
 */
export interface QueueApi {
  /** Pending drafts, newest-first. */
  items: QueueItem[];
  /** Pending count — the nav badge reads this. */
  count: number;
  /** True until the first load resolves. */
  loading: boolean;
  /** A genuine load failure (not a 404 "not wired yet"). */
  error: boolean;
  /** Re-pull the queue from the server. */
  refetch: () => void;
  /** Optimistically drop an item (after Send/Dismiss); the next refetch reconciles. */
  removeItem: (id: string) => void;
}

const QueueContext = createContext<QueueApi | null>(null);

const NULL_API: QueueApi = {
  items: [],
  count: 0,
  loading: false,
  error: false,
  refetch: () => {},
  removeItem: () => {},
};

/** Access the app-wide approval queue. Safe outside the provider — returns a null-object. */
export function useQueue(): QueueApi {
  return useContext(QueueContext) ?? NULL_API;
}

function byNewest(a: QueueItem, b: QueueItem): number {
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const { isAuthed } = useAuth();
  const { subscribe } = useRealtime();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const authedRef = useRef(isAuthed);
  authedRef.current = isAuthed;

  const refetch = useCallback(async () => {
    if (!authedRef.current) {
      setItems([]);
      setLoading(false);
      return;
    }
    try {
      const list = await fetchQueue();
      setItems([...list].sort(byNewest));
      setError(false);
    } catch (e) {
      // 404 = endpoint not built yet → an empty queue, not a failure.
      if ((e as ApiError)?.status === 404) {
        setItems([]);
        setError(false);
      } else {
        setError(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + re-run when auth resolves/changes.
  useEffect(() => {
    setLoading(true);
    void refetch();
  }, [refetch, isAuthed]);

  // Live: a new inbound may enqueue a draft — refetch (debounced) on any event.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe, refetch]);

  const removeItem = useCallback((id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const value = useMemo<QueueApi>(
    () => ({ items, count: items.length, loading, error, refetch, removeItem }),
    [items, loading, error, refetch, removeItem],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}
