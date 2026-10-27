// Theme = the `.dark` class on <html> (index.css @custom-variant). Preference
// persists per operator; unset follows the OS and tracks its changes live.
const KEY = "noola.theme";
export type ThemePref = "light" | "dark" | "system";

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(pref: ThemePref): void {
  const dark = pref === "dark" || (pref === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* private mode — applies for this session only */
  }
  apply(pref);
}

export function isDarkNow(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** Boot hook: apply the stored/system theme before first paint and follow OS
 *  scheme changes while the preference is "system". */
export function initTheme(): void {
  apply(getThemePref());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getThemePref() === "system") apply("system");
  });
}
