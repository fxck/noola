// Build markers for the nerd surfaces (HUD + login easter-egg). `__BUILD_TIME__`
// is injected at build time (see vite.config.ts `define`); the short hash is
// derived from it so every build gets a stable, glanceable "commit"-looking id.

/** ISO build timestamp (UTC), injected at build time. */
export const BUILD_TIME: string = __BUILD_TIME__;

/** Vite mode: "development" | "production" | … */
export const BUILD_MODE: string = import.meta.env.MODE;

/** A short fnv-1a hash of the build time — a fake-but-stable "commit"-ish id. */
export const BUILD_HASH: string = (() => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < BUILD_TIME.length; i++) {
    h ^= BUILD_TIME.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 7);
})();

/** An explicit build tag from the env if provided, else the derived hash. */
export const BUILD_ID: string =
  (import.meta.env.VITE_BUILD as string | undefined) ||
  (import.meta.env.VITE_COMMIT as string | undefined) ||
  BUILD_HASH;
