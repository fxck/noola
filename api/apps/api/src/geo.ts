// IP → geo via the internal `geo` sidecar, which owns the mmdb (keeps the api artifact lean). The
// api calls it over the project's private network. Deliberately graceful: sidecar unreachable, no
// db baked, or a slow lookup → null, never throws. GEO_URL overrides the default internal host.

const GEO_URL = process.env.GEO_URL ?? "http://geo:3002";

export interface GeoResult {
  city?: string;
  region?: string;
  country?: string;
  continent?: string;
  continentCode?: string;
}

export async function geoLookup(ip: string | null): Promise<GeoResult | null> {
  if (!ip) return null;
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
