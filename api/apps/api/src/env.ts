// Cross-service wiring is read through here so a forgotten wire fails at boot instead of
// degrading silently at runtime. The sidecar clients (geo, embedder) are deliberately
// fault-tolerant — they return null rather than throw — which means a wrong or missing URL
// looks exactly like "the sidecar had nothing for you" and can sit unnoticed in production.
// Requiring the var moves that failure to the rung that introduced it.
//
// An EMPTY value is allowed and meaningful: it explicitly disables the dependency, for rungs
// that run no such sidecar. So the three states are distinct — set = use it, empty = knowingly
// off, unset = someone forgot, crash now. (packages/db/src/migrate.ts has its own stricter
// requireEnv: DB credentials have no meaningful "off", so there an empty value is also fatal.)
export function requireEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined) {
    throw new Error(`missing env ${key} — wire it in the rung's import.yaml (empty string disables)`);
  }
  return v;
}
