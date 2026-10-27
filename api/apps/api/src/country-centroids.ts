// Country centroids for the Customers → Map fallback. The map plots precise Latitude/Longitude when
// live IP-enrichment wrote them, but IMPORTED contacts (Intercom migration, CSV) carry only a Country
// (and City) name and no coordinates — so they'd never appear. When precise coords are absent we place
// the contact at their country's approximate centroid (with a deterministic per-contact jitter so a
// whole country's worth of people spread into a readable cluster instead of stacking on one pixel).
//
// Approximate by design — this answers "where are my customers, roughly" for imported data, not a
// precise pin. Keyed by the lowercased country NAME as stored in attributes.Country (Intercom's
// display name, e.g. "United States"), plus the common aliases an import might carry.

type LatLng = { lat: number; lng: number };

// name (lowercased) → centroid. Coordinates are standard approximate country centroids.
const CENTROIDS: Record<string, LatLng> = {
  "afghanistan": { lat: 33.94, lng: 67.71 },
  "albania": { lat: 41.15, lng: 20.17 },
  "algeria": { lat: 28.03, lng: 1.66 },
  "angola": { lat: -11.2, lng: 17.87 },
  "argentina": { lat: -38.42, lng: -63.62 },
  "armenia": { lat: 40.07, lng: 45.04 },
  "australia": { lat: -25.27, lng: 133.78 },
  "austria": { lat: 47.52, lng: 14.55 },
  "azerbaijan": { lat: 40.14, lng: 47.58 },
  "bahamas": { lat: 25.03, lng: -77.4 },
  "bahrain": { lat: 26.07, lng: 50.56 },
  "bangladesh": { lat: 23.68, lng: 90.36 },
  "belarus": { lat: 53.71, lng: 27.95 },
  "belgium": { lat: 50.5, lng: 4.47 },
  "bolivia": { lat: -16.29, lng: -63.59 },
  "bosnia and herzegovina": { lat: 43.92, lng: 17.68 },
  "botswana": { lat: -22.33, lng: 24.68 },
  "brazil": { lat: -14.24, lng: -51.93 },
  "bulgaria": { lat: 42.73, lng: 25.49 },
  "cambodia": { lat: 12.57, lng: 104.99 },
  "cameroon": { lat: 7.37, lng: 12.35 },
  "canada": { lat: 56.13, lng: -106.35 },
  "chile": { lat: -35.68, lng: -71.54 },
  "china": { lat: 35.86, lng: 104.2 },
  "colombia": { lat: 4.57, lng: -74.3 },
  "costa rica": { lat: 9.75, lng: -83.75 },
  "croatia": { lat: 45.1, lng: 15.2 },
  "cuba": { lat: 21.52, lng: -77.78 },
  "cyprus": { lat: 35.13, lng: 33.43 },
  "czechia": { lat: 49.82, lng: 15.47 },
  "czech republic": { lat: 49.82, lng: 15.47 },
  "denmark": { lat: 56.26, lng: 9.5 },
  "dominican republic": { lat: 18.74, lng: -70.16 },
  "ecuador": { lat: -1.83, lng: -78.18 },
  "egypt": { lat: 26.82, lng: 30.8 },
  "el salvador": { lat: 13.79, lng: -88.9 },
  "estonia": { lat: 58.6, lng: 25.01 },
  "ethiopia": { lat: 9.15, lng: 40.49 },
  "finland": { lat: 61.92, lng: 25.75 },
  "france": { lat: 46.6, lng: 1.89 },
  "georgia": { lat: 42.32, lng: 43.36 },
  "germany": { lat: 51.17, lng: 10.45 },
  "ghana": { lat: 7.95, lng: -1.02 },
  "greece": { lat: 39.07, lng: 21.82 },
  "guatemala": { lat: 15.78, lng: -90.23 },
  "honduras": { lat: 15.2, lng: -86.24 },
  "hong kong": { lat: 22.32, lng: 114.17 },
  "hungary": { lat: 47.16, lng: 19.5 },
  "iceland": { lat: 64.96, lng: -19.02 },
  "india": { lat: 20.59, lng: 78.96 },
  "indonesia": { lat: -0.79, lng: 113.92 },
  "iran": { lat: 32.43, lng: 53.69 },
  "iraq": { lat: 33.22, lng: 43.68 },
  "ireland": { lat: 53.41, lng: -8.24 },
  "israel": { lat: 31.05, lng: 34.85 },
  "italy": { lat: 41.87, lng: 12.57 },
  "jamaica": { lat: 18.11, lng: -77.3 },
  "japan": { lat: 36.2, lng: 138.25 },
  "jordan": { lat: 30.59, lng: 36.24 },
  "kazakhstan": { lat: 48.02, lng: 66.92 },
  "kenya": { lat: -0.02, lng: 37.91 },
  "kuwait": { lat: 29.31, lng: 47.48 },
  "latvia": { lat: 56.88, lng: 24.6 },
  "lebanon": { lat: 33.85, lng: 35.86 },
  "lithuania": { lat: 55.17, lng: 23.88 },
  "luxembourg": { lat: 49.82, lng: 6.13 },
  "malaysia": { lat: 4.21, lng: 101.98 },
  "malta": { lat: 35.94, lng: 14.38 },
  "mexico": { lat: 23.63, lng: -102.55 },
  "moldova": { lat: 47.41, lng: 28.37 },
  "morocco": { lat: 31.79, lng: -7.09 },
  "nepal": { lat: 28.39, lng: 84.12 },
  "netherlands": { lat: 52.13, lng: 5.29 },
  "new zealand": { lat: -40.9, lng: 174.89 },
  "nicaragua": { lat: 12.87, lng: -85.21 },
  "nigeria": { lat: 9.08, lng: 8.68 },
  "north macedonia": { lat: 41.61, lng: 21.75 },
  "norway": { lat: 60.47, lng: 8.47 },
  "oman": { lat: 21.51, lng: 55.92 },
  "pakistan": { lat: 30.38, lng: 69.35 },
  "panama": { lat: 8.54, lng: -80.78 },
  "paraguay": { lat: -23.44, lng: -58.44 },
  "peru": { lat: -9.19, lng: -75.02 },
  "philippines": { lat: 12.88, lng: 121.77 },
  "poland": { lat: 51.92, lng: 19.15 },
  "portugal": { lat: 39.4, lng: -8.22 },
  "qatar": { lat: 25.35, lng: 51.18 },
  "romania": { lat: 45.94, lng: 24.97 },
  "russia": { lat: 61.52, lng: 105.32 },
  "saudi arabia": { lat: 23.89, lng: 45.08 },
  "serbia": { lat: 44.02, lng: 21.01 },
  "singapore": { lat: 1.35, lng: 103.82 },
  "slovakia": { lat: 48.67, lng: 19.7 },
  "slovenia": { lat: 46.15, lng: 14.99 },
  "south africa": { lat: -30.56, lng: 22.94 },
  "south korea": { lat: 35.91, lng: 127.77 },
  "korea": { lat: 35.91, lng: 127.77 },
  "spain": { lat: 40.46, lng: -3.75 },
  "sri lanka": { lat: 7.87, lng: 80.77 },
  "sweden": { lat: 60.13, lng: 18.64 },
  "switzerland": { lat: 46.82, lng: 8.23 },
  "taiwan": { lat: 23.7, lng: 120.96 },
  "tanzania": { lat: -6.37, lng: 34.89 },
  "thailand": { lat: 15.87, lng: 100.99 },
  "tunisia": { lat: 33.89, lng: 9.54 },
  "turkey": { lat: 38.96, lng: 35.24 },
  "türkiye": { lat: 38.96, lng: 35.24 },
  "uganda": { lat: 1.37, lng: 32.29 },
  "ukraine": { lat: 48.38, lng: 31.17 },
  "united arab emirates": { lat: 23.42, lng: 53.85 },
  "united kingdom": { lat: 55.38, lng: -3.44 },
  "united states": { lat: 37.09, lng: -95.71 },
  "united states of america": { lat: 37.09, lng: -95.71 },
  "uruguay": { lat: -32.52, lng: -55.77 },
  "uzbekistan": { lat: 41.38, lng: 64.59 },
  "venezuela": { lat: 6.42, lng: -66.59 },
  "vietnam": { lat: 14.06, lng: 108.28 },
  "zambia": { lat: -13.13, lng: 27.85 },
  "zimbabwe": { lat: -19.02, lng: 29.15 },
};

// Common short forms / abbreviations an import might store instead of the full display name.
const ALIASES: Record<string, string> = {
  "us": "united states",
  "usa": "united states",
  "u.s.": "united states",
  "u.s.a.": "united states",
  "america": "united states",
  "uk": "united kingdom",
  "u.k.": "united kingdom",
  "great britain": "united kingdom",
  "britain": "united kingdom",
  "england": "united kingdom",
  "scotland": "united kingdom",
  "wales": "united kingdom",
  "uae": "united arab emirates",
  "u.a.e.": "united arab emirates",
  "south korea, republic of": "south korea",
  "republic of korea": "south korea",
  "russian federation": "russia",
  "viet nam": "vietnam",
};

/** Approximate centroid for a stored Country name, or null when unknown (the contact then isn't
 *  placed — same as before this fallback existed). Case/whitespace-insensitive; resolves aliases. */
export function countryCentroid(country: string | null | undefined): LatLng | null {
  if (!country) return null;
  const key = country.trim().toLowerCase();
  if (!key) return null;
  const canonical = ALIASES[key] ?? key;
  return CENTROIDS[canonical] ?? null;
}

/** Deterministic small offset (~±1.2°) from a country centroid, seeded by the contact id, so a whole
 *  country's imported contacts spread into a readable cluster instead of stacking on one point. Same
 *  contact → same jittered spot every load (stable pins). */
export function jitterFromId(base: LatLng, id: string): LatLng {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Two independent-ish angles from the hash → offset within ~±1.2° lat / ±1.6° lng.
  const a = (h >>> 0) / 0xffffffff;
  const b = ((Math.imul(h, 48271) >>> 0) % 1000) / 1000;
  return { lat: base.lat + (a - 0.5) * 2.4, lng: base.lng + (b - 0.5) * 3.2 };
}
