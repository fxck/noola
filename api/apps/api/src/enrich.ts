import type { FastifyRequest } from "fastify";
import { geoLookup } from "./geo.js";

// Live contact enrichment — the signals Intercom's Messenger derives per visit, computed from the
// data every widget request already carries: User-Agent (browser/OS), Accept-Language, the
// browser-reported timezone + referrer, and the request IP (geo). Written into contact attributes
// under Intercom's own display-name keys, so a live value overwrites the imported snapshot IN
// PLACE (Browser / OS / City / … merge onto the same column) rather than sprouting a duplicate.

/** Compact, dependency-free UA parse — covers the desktop/mobile browsers + OSes Intercom's list
 *  ever shows. Order matters: Edge/Opera masquerade as Chrome, so they're matched first. */
export function parseUserAgent(ua: string | undefined): { browser?: string; version?: string; os?: string } {
  if (!ua) return {};
  const out: { browser?: string; version?: string; os?: string } = {};
  let m: RegExpMatchArray | null;
  // ── OS ──
  if ((m = ua.match(/Windows NT ([\d.]+)/))) {
    out.os = ({ "10.0": "Windows 10", "6.3": "Windows 8.1", "6.2": "Windows 8", "6.1": "Windows 7" } as Record<string, string>)[m[1]] ?? "Windows";
  } else if ((m = ua.match(/Mac OS X ([\d_]+)/))) {
    out.os = `macOS ${m[1].replace(/_/g, ".")}`;
  } else if ((m = ua.match(/Android ([\d.]+)/))) {
    out.os = `Android ${m[1]}`;
  } else if (/(iPhone|iPad|iPod)/.test(ua) && (m = ua.match(/OS ([\d_]+)/))) {
    out.os = `iOS ${m[1].replace(/_/g, ".")}`;
  } else if (/Linux/.test(ua)) {
    out.os = "Linux";
  }
  // ── Browser ──
  if ((m = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/))) {
    out.browser = "Edge";
    out.version = m[1];
  } else if ((m = ua.match(/OPR\/([\d.]+)/)) || (m = ua.match(/Opera\/([\d.]+)/))) {
    out.browser = "Opera";
    out.version = m[1];
  } else if ((m = ua.match(/Firefox\/([\d.]+)/))) {
    out.browser = "Firefox";
    out.version = m[1];
  } else if ((m = ua.match(/Chrome\/([\d.]+)/))) {
    out.browser = "Chrome";
    out.version = m[1];
  } else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) {
    out.browser = "Safari";
    out.version = m[1];
  } else if (/Safari/.test(ua)) {
    out.browser = "Safari";
  }
  return out;
}

/** The visitor's IP behind Zerops' L7 balancer — first hop of X-Forwarded-For, else Fastify's ip. */
export function clientIp(req: FastifyRequest): string | null {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  const first = raw?.split(",")[0]?.trim();
  return first || req.ip || null;
}

/** The representative city baked into an IANA timezone id ("Asia/Calcutta" → "Calcutta",
 *  "America/Argentina/Buenos_Aires" → "Buenos Aires"). The browser reports this, so it's the visitor's
 *  own signal — unlike an IP that, behind the L7 balancer, is our datacenter. Null for non-zone ids. */
export function timezoneCity(tz: string | undefined): string | null {
  if (!tz || !tz.includes("/")) return null;
  const city = tz.split("/").pop()?.replace(/_/g, " ").trim();
  return city || null;
}

/** IANA continent prefix → DB-IP continent code, to cross-check the IP-geo against the visitor's own
 *  timezone. "America" straddles NA+SA so it matches either. Ocean/rare prefixes → null (no check). */
function timezoneContinentCode(tz: string | undefined): string | null {
  if (!tz) return null;
  const prefix = tz.split("/")[0];
  if (prefix === "America") return "AMER"; // NA or SA — matched leniently below
  const map: Record<string, string> = { Africa: "AF", Antarctica: "AN", Asia: "AS", Australia: "OC", Europe: "EU", Pacific: "OC" };
  return map[prefix] ?? null;
}

/** True when the IP-geo continent CONFLICTS with the visitor's timezone continent — the tell that the
 *  IP resolved to our datacenter (the L7 balancer masked the real client IP), not to the visitor. */
function geoConflictsWithTimezone(geoContinentCode: string | undefined, tz: string | undefined): boolean {
  const tzCC = timezoneContinentCode(tz);
  if (!geoContinentCode || !tzCC) return false; // can't cross-check → don't override
  if (tzCC === "AMER") return geoContinentCode !== "NA" && geoContinentCode !== "SA";
  return geoContinentCode !== tzCC;
}

function primaryLanguage(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const first = header.split(",")[0]?.split(";")[0]?.trim();
  return first || undefined;
}

export interface WidgetContext {
  timezone?: string;
  referrer?: string;
  language?: string;
}

/** Assemble the derived-attribute bag for one widget request. Keys are Intercom's display names so
 *  they overwrite the imported snapshot in place. Geo is best-effort (null when no db configured).
 *  Never throws — enrichment must never fail the identify/track it rides along with. */
export async function deriveContactContext(req: FastifyRequest, ctx: WidgetContext): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const uaHeader = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
    const ua = parseUserAgent(uaHeader);
    if (ua.browser) out["Browser"] = ua.browser;
    if (ua.version) out["Browser Version"] = ua.version;
    if (ua.os) out["OS"] = ua.os;

    const langHeader = typeof req.headers["accept-language"] === "string" ? req.headers["accept-language"] : undefined;
    const lang = ctx.language || primaryLanguage(langHeader);
    if (lang) out["Browser Language"] = lang.slice(0, 32);

    if (ctx.timezone) out["Timezone"] = ctx.timezone.slice(0, 64);
    if (ctx.referrer) out["Referral URL"] = ctx.referrer.slice(0, 2048);

    // Approximate location. IP-geo is only trustworthy when it AGREES with the visitor's own timezone:
    // behind Zerops' L7 balancer the request IP frequently resolves to our datacenter (e.g. Prague),
    // which would otherwise stamp every visitor as being here. So: if the IP-geo continent conflicts
    // with the browser timezone's continent, the IP is OURS not theirs — drop the bogus country/city and
    // fall back to the timezone's own city (the honest client signal). We still never record Region/
    // continent (subdivision geo is unreliable even when the country is right).
    const geo = await geoLookup(clientIp(req));
    if (geo && !geoConflictsWithTimezone(geo.continentCode, ctx.timezone)) {
      if (geo.country) out["Country"] = geo.country;
      if (geo.city) out["City"] = geo.city;
    } else {
      const tzCity = timezoneCity(ctx.timezone);
      if (tzCity) out["City"] = tzCity;
    }
  } catch {
    /* enrichment is best-effort */
  }
  return out;
}
