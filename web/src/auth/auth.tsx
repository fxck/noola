import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setToken, getToken } from "@/lib/api";

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
  /** API-relative avatar path (e.g. "/avatar/<uuid>.jpg"), or null when none set. */
  avatarUrl?: string | null;
}

export interface AuthState {
  user: User | null;
  loading: boolean;
  isAuthed: boolean;
  login: (email: string, password: string) => Promise<string | null>;
  loginTotp: (challenge: string, code: string) => Promise<void>;
  signup: (input: { email: string; password: string; name: string; orgName: string }) => Promise<void>;
  /** Adopt a session returned by a public join flow (invite accept / link redeem) — the server
   *  already minted the token + user, so this just stores them and flips to authed. */
  applySession: (token: string, user: User) => void;
  /** Re-fetch /auth/me and update the cached user — e.g. after an avatar or name change,
   *  so the header reflects it immediately. No-op when signed out. */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Hydrate the session from a stored token on first load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) {
        setLoading(false);
        return;
      }
      try {
        const { user } = await api<{ user: User }>("/auth/me");
        if (!cancelled) setUser(user);
      } catch {
        setToken(null); // stale/expired token
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Returns null on a completed sign-in; a 2FA challenge string when the account is
   *  TOTP-enrolled (the caller shows the code step and finishes via loginTotp). */
  async function login(email: string, password: string): Promise<string | null> {
    const res = await api<{ token?: string; user?: User; twoFactorRequired?: boolean; challenge?: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (res.twoFactorRequired && res.challenge) return res.challenge;
    setToken(res.token as string);
    setUser(res.user as User);
    return null;
  }

  async function loginTotp(challenge: string, code: string): Promise<void> {
    const { token, user } = await api<{ token: string; user: User }>("/auth/login/2fa", {
      method: "POST",
      body: JSON.stringify({ challenge, code }),
    });
    setToken(token);
    setUser(user);
  }

  async function signup(input: { email: string; password: string; name: string; orgName: string }): Promise<void> {
    const { token, user } = await api<{ token: string; user: User }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setToken(token);
    setUser(user);
  }

  function applySession(token: string, user: User): void {
    setToken(token);
    setUser(user);
  }

  async function refresh(): Promise<void> {
    if (!getToken()) return;
    const { user } = await api<{ user: User }>("/auth/me");
    setUser(user);
  }

  async function logout(): Promise<void> {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* best-effort; clear locally regardless */
    }
    setToken(null);
    setUser(null);
    // Hard-navigate to the login screen: clearing user state alone leaves the router on the
    // (now unauthenticated) dashboard with a stale realtime socket ("Reconnect"). A full document
    // load lands on /login and wipes every in-memory subscription/socket in one shot.
    window.location.assign("/login");
  }

  return (
    <AuthContext.Provider value={{ user, loading, isAuthed: !!user, login, loginTotp, signup, applySession, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
