// IP → geo (city / region / country / continent). Deliberately graceful: with no GEOIP_DB_PATH
// configured, no readable mmdb, or no `maxmind` reader installed, every lookup returns null and
// never throws — geo is an enrichment nicety, never a request-path dependency. The db is a
// standard MaxMind mmdb (GeoLite2-City or the licence-free DB-IP City Lite, same format).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let readerPromise: Promise<any | null> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getReader(): Promise<any | null> {
  const path = process.env.GEOIP_DB_PATH;
  if (!path) return null;
  if (!readerPromise) {
    readerPromise = (async () => {
      try {
        // Specifier cast to string so tsc doesn't require `maxmind` to be resolvable at
        // typecheck — it's installed by the build's `bun install` and only imported here when a
        // db path is actually configured (geo stays dormant, and dep-free, otherwise).
        const spec = "maxmind";
        const [maxmind, fs] = await Promise.all([import(spec), import("node:fs/promises")]);
        await fs.access(path);
        return await maxmind.open(path);
      } catch {
        return null; // missing dep / missing file / unreadable db — geo simply stays off
      }
    })();
  }
  return readerPromise;
}

export interface GeoResult {
  city?: string;
  region?: string;
  country?: string;
  continent?: string;
  continentCode?: string;
}

export async function geoLookup(ip: string | null): Promise<GeoResult | null> {
  if (!ip) return null;
  const reader = await getReader();
  if (!reader) return null;
  try {
    const r = reader.get(ip);
    if (!r) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enName = (o: any): string | undefined => o?.names?.en;
    return {
      city: enName(r.city),
      region: enName(r.subdivisions?.[0]),
      country: enName(r.country),
      continent: enName(r.continent),
      continentCode: r.continent?.code,
    };
  } catch {
    return null;
  }
}
