import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/auth/auth";

/** A member's own settings, mirrored from UserPreferences in @repo/contracts, which the web build can't import. */
export interface UserPreferences {
  /** Show a GIF or image that a message links to, instead of only the link. */
  linkPreviews: boolean;
}

const DEFAULTS: UserPreferences = { linkPreviews: true };

// One copy for the whole app, so every message bubble reads the same value without its own request.
let current: UserPreferences = DEFAULTS;
let loadedFor: string | null = null;
const listeners = new Set<() => void>();

function set(next: UserPreferences) {
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Preferences are per workspace, so a switch to another workspace or member loads them again. */
function load(key: string) {
  if (loadedFor === key) return;
  loadedFor = key;
  set(DEFAULTS);
  api<{ preferences: Partial<UserPreferences> }>("/me/preferences")
    .then((r) => {
      if (loadedFor === key) set({ ...DEFAULTS, ...r.preferences });
    })
    .catch(() => {
      if (loadedFor === key) loadedFor = null;
    });
}

export function usePreferences(): UserPreferences {
  const { user } = useAuth();
  const key = user ? `${user.tenantId}:${user.id}` : null;
  useEffect(() => {
    if (key) load(key);
  }, [key]);
  return useSyncExternalStore(subscribe, () => current);
}

/** Saves the given settings, showing them at once and putting the old values back if the save fails. */
export async function savePreferences(patch: Partial<UserPreferences>): Promise<void> {
  const before = current;
  set({ ...current, ...patch });
  try {
    const r = await api<{ preferences: Partial<UserPreferences> }>("/me/preferences", { method: "PATCH", body: JSON.stringify(patch) });
    set({ ...DEFAULTS, ...r.preferences });
  } catch (err) {
    set(before);
    throw err;
  }
}
