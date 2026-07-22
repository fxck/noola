// IP → geo via the internal `geo` sidecar, which owns the mmdb (keeps the api artifact lean). The
// api calls it over the project's private network. Deliberately graceful: sidecar unreachable, no
// db baked, or a slow lookup → null, never throws.
//
// GEO_URL is required, with no default. The sidecar's hostname differs per rung (`geo` in a
// production-shaped project, `geodev`/`geostage` where halves are paired), so no single literal is
// correct everywhere — it belongs in the rung's import.yaml. Set it empty on rungs that run no geo
// sidecar; that disables enrichment outright instead of paying an 800ms timeout per lookup against
// a host that does not resolve.
import { requireEnv } from "./env.js";

const GEO_URL = requireEnv("GEO_URL");

export interface GeoResult {
  city?: string;
  region?: string;
  country?: string;
  continent?: string;
  continentCode?: string;
}

export async function geoLookup(ip: string | null): Promise<GeoResult | null> {
  if (!ip || !GEO_URL) return null; // empty GEO_URL = no sidecar on this rung, skip the call
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 800); // enrichment must never stall the request
    const res = await fetch(`${GEO_URL}/lookup?ip=${encodeURIComponent(ip)}`, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const d = (await res.json()) as { country?: string; region?: string; city?: string; continent?: string };
    if (!d || (!d.country && !d.city && !d.region && !d.continent)) return null;
    // The sidecar returns `continent` as the code (e.g. "EU") — mapped to Intercom's "Continent code".
    return { city: d.city, region: d.region, country: d.country, continentCode: d.continent };
  } catch {
    return null;
  }
}
