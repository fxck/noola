// Platform service-type parsing, dependency-free so the account sync (public-accounts.ts) and the
// Zerops catalog import (zerops-catalog.ts) share one definition.

export interface ParsedServiceType {
  technology: string;
  version: string;
  os: string;
  mode: string;
}

const TYPE_RE = /^(?:(alpine|ubuntu)\/)?([a-z0-9][a-z0-9.-]*?)(?::([a-z]+))?(?:@([^\s]+))?$/;

/**
 * Split a platform service type into technology / version / os / mode:
 *   "ubuntu/php-nginx@8.4+1.22" → php-nginx, 8.4, ubuntu, ""      (the +webserver suffix is dropped)
 *   "postgresql:ha@16"          → postgresql, 16, "", ha
 *   "alpine@3.24"               → alpine, 3.24 (an OS-only base is its own technology)
 *   "object-storage"            → object-storage, ""
 * `aliases` maps a spelling variant to the catalog key (golang → go). An unparseable type keeps
 * the whole lowercased string as the technology, so nothing is ever dropped.
 */
export function parseServiceType(raw: string, aliases: Map<string, string> = new Map()): ParsedServiceType {
  const t = raw.trim().toLowerCase();
  const m = TYPE_RE.exec(t);
  if (!m) return { technology: aliases.get(t) ?? t, version: "", os: "", mode: "" };
  const [, os = "", name, mode = "", ver = ""] = m;
  const tech = aliases.get(name) ?? name;
  return { technology: tech, version: ver.split("+")[0], os, mode };
}
