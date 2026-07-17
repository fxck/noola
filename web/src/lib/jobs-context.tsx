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
import { fetchJobs, EMPTY_JOB_COUNTS, type JobItem, type JobCounts } from "@/lib/autoreply";
import type { ApiError } from "@/lib/api";

/**
 * App-wide autopilot-jobs layer — the live worker queue for "auto" mode. One place
 * owns the job board so both the /queue page and the nav "active" indicator read the
 * same state. It stays alive two ways: it refetches on the realtime `new_event` bus
 * (a `noola.autoreply.job` event flows through it), and it polls every ~2.5s WHILE
 * any job is queued/processing, stopping the moment the board is idle. A 404
 * (endpoint not wired yet) is an empty board, not an error — degrade gracefully.
 */
export interface JobsApi {
  /** The jobs, server order preserved (the page sorts for display). */
  jobs: JobItem[];
  /** Per-status tallies for the counts summary. */
  counts: JobCounts;
  /** queued + processing — drives polling and the nav "active" indicator. */
  activeCount: number;
  /** True until the first load resolves. */
  loading: boolean;
  /** A genuine load failure (not a 404 "not wired yet"). */
  error: boolean;
  /** Re-pull the board from the server. */
  refetch: () => void;
}

const POLL_MS = 2500;

const JobsContext = createContext<JobsApi | null>(null);

const NULL_API: JobsApi = {
  jobs: [],
  counts: EMPTY_JOB_COUNTS,
  activeCount: 0,
  loading: false,
  error: false,
  refetch: () => {},
};

/** Access the app-wide autopilot job board. Safe outside the provider — returns a null-object. */
export function useJobs(): JobsApi {
  return useContext(JobsContext) ?? NULL_API;
}

export function JobsProvider({ children }: { children: ReactNode }) {
  const { isAuthed } = useAuth();
  const { subscribe } = useRealtime();
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [counts, setCounts] = useState<JobCounts>(EMPTY_JOB_COUNTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const authedRef = useRef(isAuthed);
  authedRef.current = isAuthed;

  const refetch = useCallback(async () => {
    if (!authedRef.current) {
      setJobs([]);
      setCounts(EMPTY_JOB_COUNTS);
      setLoading(false);
      return;
    }
    try {
      const r = await fetchJobs();
      setJobs(r.jobs);
      setCounts(r.counts);
      setError(false);
    } catch (e) {
      // 404 = endpoint not built yet → an empty board, not a failure.
      if ((e as ApiError)?.status === 404) {
        setJobs([]);
        setCounts(EMPTY_JOB_COUNTS);
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

  // Live: a job event (or any inbound that may enqueue one) → debounced refetch.
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

  const activeCount = counts.queued + counts.processing;

  // Poll only while work is in flight — stop the instant the board drains.
  useEffect(() => {
    if (activeCount <= 0) return;
    const id = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(id);
  }, [activeCount, refetch]);

  const value = useMemo<JobsApi>(
    () => ({ jobs, counts, activeCount, loading, error, refetch }),
    [jobs, counts, activeCount, loading, error, refetch],
  );

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}
