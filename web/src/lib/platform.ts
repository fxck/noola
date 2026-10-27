// Shortcut labels in the visitor's own keyboard terms. The handlers accept both ⌘ and Ctrl everywhere.
const nav = typeof navigator === "undefined" ? null : navigator;
const platform = (nav as (Navigator & { userAgentData?: { platform?: string } }) | null)?.userAgentData?.platform ?? nav?.platform ?? "";

export const isMac = /mac|iphone|ipad|ipod/i.test(platform);

/** "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function shortcut(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

/** The send shortcut: "⌘↵" on a Mac, "Ctrl+Enter" elsewhere. */
export const SUBMIT_SHORTCUT = isMac ? "⌘↵" : "Ctrl+Enter";
