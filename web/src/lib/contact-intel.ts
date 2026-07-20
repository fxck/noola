import type { Contact } from "@/lib/contacts";

// Contact intelligence — turn the raw attribute firehose (the ~60-field Intercom + Zerops export)
// into the few things a support/CS person needs in two seconds: who, are they valuable, are they
// happy, what do they need. This is the page DOING the synthesis instead of dumping an alphabetical
// list. Every lookup is case-insensitive and tolerant of missing/garbage values — real imported data
// is partial and inconsistent. Field names track the real export (services_count, "Monthly Spend",
// "Web sessions", "Signed up (CEST)", "Conversation Rating", is_team, …).

function lc(attrs: Record<string, string> | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) m.set(k.toLowerCase(), String(v));
  return m;
}
function pick(m: Map<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = m.get(k.toLowerCase());
    if (v != null && v.trim()) return v.trim();
  }
  return "";
}
/** Parse the first number out of a value like "$1,200", "41", "0.0" — null when there's none. */
function pickNum(m: Map<string, string>, ...keys: string[]): number | null {
  const raw = pick(m, ...keys);
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function pickDate(m: Map<string, string>, ...keys: string[]): Date | null {
  const raw = pick(m, ...keys);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
function pickBool(m: Map<string, string>, ...keys: string[]): boolean {
  return /^(true|yes|1)$/i.test(pick(m, ...keys));
}

const DAY = 86_400_000;
/** "3y", "7mo", "12d", "today" — a compact span from now. */
function since(d: Date | null): string {
  if (!d) return "";
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY));
  if (days >= 365) return `${Math.floor(days / 365)}y`;
  if (days >= 60) return `${Math.floor(days / 30)}mo`;
  if (days >= 1) return `${days}d`;
  return "today";
}
function money(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `$${n.toLocaleString()}`;
}

export type Tone = "default" | "opportunity" | "risk" | "success" | "info";

export interface StatTile {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: Tone;
}
export interface Verdict {
  text: string;
  tone: Tone;
}
export interface ContactIntel {
  verdict: Verdict | null;
  tiles: StatTile[];
  localTime: string | null; // from the self-reported timezone — the one honest "where/when"
  timezone: string;
  /** Lowercased attribute keys the hero already SURFACED (fed a rendered tile / the plan pin). The
   *  rail suppresses these so "Monthly Spend: $0" isn't printed twice — once as a tile, once in the
   *  flat dump. Only keys behind a *rendered* tile are added, so a value is never silently dropped. */
  consumed: Set<string>;
}

/** The single most useful "where/when" fact — their local clock, from the browser-reported timezone. */
export function localTimeFor(timezone: string): string | null {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date());
  } catch {
    return null; // an imported/garbage tz string — don't fake it
  }
}

export function contactIntel(c: Contact): ContactIntel {
  const m = lc(c.attributes);

  const spend = pickNum(m, "Monthly Spend", "monthly_spend", "MRR");
  const plan = pick(m, "Plan Name", "Plan", "plan");
  const services = pickNum(m, "services_count", "services_num", "currentServiceCount", "totalStackCount");
  const projects = pickNum(m, "projects_count", "projects_num", "currentProjectCount");
  const sessions = pickNum(m, "Web sessions", "web_sessions");
  const rating = pick(m, "Conversation Rating");
  const isTeam = pickBool(m, "is_team");
  const signedUp = pickDate(m, "Signed up (CEST)", "Signed up", "First Seen (CEST)", "First Seen") ?? new Date(c.created_at);
  const lastSeen = c.last_seen_at ? new Date(c.last_seen_at) : pickDate(m, "Last seen (CEST)", "Last seen");
  const timezone = pick(m, "Timezone");

  const activeNow = !!c.online || (!!lastSeen && Date.now() - lastSeen.getTime() < 15 * 60_000);
  const staleDays = lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / DAY) : null;
  const heavyUse = (services ?? 0) >= 8 || (projects ?? 0) >= 3 || (sessions ?? 0) >= 40 || isTeam;

  // ── the verdict: the page says the story out loud ──────────────────────────
  let verdict: Verdict | null = null;
  const foot = services != null ? `${services} services` : projects != null ? `${projects} projects` : "high usage";
  if (heavyUse && spend != null && spend === 0) {
    verdict = {
      text: `Power user on the free plan — ${foot}, $0 MRR${activeNow ? ", active now" : ""}. Expansion opportunity.`,
      tone: "opportunity",
    };
  } else if (spend != null && spend > 0 && staleDays != null && staleDays >= 30) {
    verdict = { text: `Paying ${money(spend)}/mo but quiet for ${since(lastSeen)} — churn risk.`, tone: "risk" };
  } else if (/negativ|bad|1|2\b/i.test(rating) && rating) {
    verdict = { text: `Recent conversation rated poorly — needs a careful touch.`, tone: "risk" };
  } else if (heavyUse && spend != null && spend > 0) {
    verdict = { text: `Healthy paying account — ${foot} on ${money(spend)}/mo${activeNow ? ", active now" : ""}.`, tone: "success" };
  } else if (activeNow) {
    verdict = { text: `Active right now.`, tone: "info" };
  }

  // A key the hero surfaces is marked consumed so the rail won't repeat it in the flat dump. Every
  // alias of a rendered field is added — only one exists in real data, and they mean the same thing.
  const consumed = new Set<string>();
  const consume = (...keys: string[]) => keys.forEach((k) => consumed.add(k.toLowerCase()));

  // ── stat tiles: only the ones with real data, tone-coded ───────────────────
  const tiles: StatTile[] = [];
  if (spend != null) {
    tiles.push({
      label: "Monthly spend",
      value: spend === 0 ? "$0" : money(spend),
      sub: plan || (spend === 0 ? "free plan" : undefined),
      tone: spend === 0 && heavyUse ? "opportunity" : spend > 0 ? "success" : "default",
    });
    consume("Monthly Spend", "monthly_spend", "MRR");
    if (plan) consume("Plan Name", "Plan", "plan");
  } else if (plan) {
    tiles.push({ label: "Plan", value: plan, tone: "default" });
    consume("Plan Name", "Plan", "plan");
  }
  if (services != null || projects != null) {
    tiles.push({
      label: "Footprint",
      value: services != null ? String(services) : String(projects),
      unit: services != null ? (services === 1 ? "service" : "services") : projects === 1 ? "project" : "projects",
      sub: services != null && projects != null ? `${projects} project${projects === 1 ? "" : "s"}` : isTeam ? "team account" : undefined,
      tone: heavyUse ? "info" : "default",
    });
    consume("services_count", "services_num", "currentServiceCount", "totalStackCount");
    consume("projects_count", "projects_num", "currentProjectCount");
    if (isTeam) consume("is_team");
  }
  if (sessions != null) {
    tiles.push({ label: "Web sessions", value: sessions.toLocaleString(), tone: sessions >= 40 ? "info" : "default" });
    consume("Web sessions", "web_sessions");
  }
  tiles.push({ label: "Customer for", value: since(signedUp) || "—", sub: "since signup", tone: "default" });
  consume("Signed up (CEST)", "Signed up", "First Seen (CEST)", "First Seen");
  if (lastSeen) {
    tiles.push({
      label: "Last seen",
      value: activeNow ? "now" : since(lastSeen),
      tone: activeNow ? "success" : staleDays != null && staleDays >= 30 ? "risk" : "default",
    });
    consume("Last seen (CEST)", "Last seen");
  }

  return { verdict, tiles: tiles.slice(0, 5), localTime: localTimeFor(timezone), timezone, consumed };
}
