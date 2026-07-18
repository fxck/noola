import http from "node:http";
import { open } from "maxmind";

// geo — a tiny IP→location sidecar. Owns the (heavy) DB-IP City Lite mmdb so the api artifact stays
// lean; the api calls GET /lookup?ip= over the internal project network. Baked db path from
// GEOIP_DB_PATH. Degrades gracefully: no db → /lookup returns {} and /health stays 200 (the service
// is alive), so the api simply gets no geo rather than erroring.

const PORT = Number(process.env.PORT) || 3002;
const DB_PATH = process.env.GEOIP_DB_PATH || "/var/www/geo/geoip.mmdb";

let reader = null;
try {
  reader = await open(DB_PATH);
  console.log(`geo: loaded ${DB_PATH}`);
} catch (e) {
  console.error(`geo: no readable db at ${DB_PATH} — lookups will be empty (${e.message})`);
}

function lookup(ip) {
  if (!reader || !ip) return {};
  try {
    const r = reader.get(ip);
    if (!r) return {};
    const en = (o) => o?.names?.en;
    return {
      country: en(r.country),
      region: en(r.subdivisions?.[0]),
      city: en(r.city),
      continent: r.continent?.code, // e.g. "EU" — matches Intercom's "Continent code"
    };
  } catch {
    return {};
  }
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://geo");
    if (u.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, db: !!reader }));
      return;
    }
    if (u.pathname === "/lookup") {
      const out = lookup(u.searchParams.get("ip") || "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(PORT, "0.0.0.0", () => console.log(`geo listening on 0.0.0.0:${PORT}`));
