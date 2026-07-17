import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// Global "nerd mode" — an instrument-panel layer over the whole app. Off by
// default; persisted in localStorage so a curious agent keeps it on. When on,
// NerdStats surfaces (retrieval math, tokens, latency, trace ids, autoreply
// decisions, the RT HUD) become visible; a couple of always-on signals (the RT
// status pill, the "Auto" badge) show regardless.

const NERD_KEY = "noola.nerd";

interface NerdApi {
  nerd: boolean;
  setNerd: (on: boolean) => void;
  toggle: () => void;
}

const NerdContext = createContext<NerdApi | null>(null);

export function useNerdMode(): NerdApi {
  return useContext(NerdContext) ?? { nerd: false, setNerd: () => {}, toggle: () => {} };
}

export function NerdModeProvider({ children }: { children: ReactNode }) {
  const [nerd, setNerdState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(NERD_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(NERD_KEY, nerd ? "1" : "0");
    } catch {
      /* private mode / storage disabled — in-memory is fine */
    }
  }, [nerd]);

  const setNerd = useCallback((on: boolean) => setNerdState(on), []);
  const toggle = useCallback(() => setNerdState((v) => !v), []);

  const value = useMemo<NerdApi>(() => ({ nerd, setNerd, toggle }), [nerd, setNerd, toggle]);
  return <NerdContext.Provider value={value}>{children}</NerdContext.Provider>;
}
