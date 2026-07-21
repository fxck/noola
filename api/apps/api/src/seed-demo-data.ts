// ── Rich "lived-in" demo data for the Acme tenant ────────────────────────────
// Builds a support workspace that looks like a busy team has run it for months:
// real-sounding companies, people with profiles, and a backlog of multi-channel
// tickets with human threads, a natural open/pending/solved mix, priorities,
// tags, assignments, internal notes, CSAT/NPS, macros, teams and activity —
// all backdated across ~5 months. Deterministic-ish structure, now()-relative
// time (so "freshness" tracks the deploy). Idempotent: purges its own output
// first (all Acme demo content), then rebuilds.
//
// Consumed by seed-demo.ts inside a withTenant(ACME) transaction.

import { SCENARIOS, type Scenario, type Turn } from "./seed-demo-scenarios.js";

export type Q = (q: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

const AGENTS = {
  ales: "a0000000-0000-0000-0000-000000000001",
  sam: "a0000000-0000-0000-0000-000000000002",
};
const AGENT_NAME: Record<string, string> = { [AGENTS.ales]: "Aleš", [AGENTS.sam]: "Sam" };

// ── tiny PRNG so a run is internally consistent (companies↔contacts↔tickets) ──
let _s = 0x9e3779b9;
const rnd = () => {
  _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5;
  return ((_s >>> 0) % 100000) / 100000;
};
const rint = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const chance = (p: number) => rnd() < p;
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const weighted = <T>(pairs: [T, number][]): T => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
};
const shuffle = <T>(xs: T[]): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ── companies ────────────────────────────────────────────────────────────────
type Co = { name: string; domain: string; plan: string; industry: string; size: number; location: string; mrr: number; ageMonths: number };
const COMPANIES: Co[] = [
  { name: "Northwind Logistics", domain: "northwind.io", plan: "Business", industry: "Logistics", size: 340, location: "Chicago, US", mrr: 2400, ageMonths: 14 },
  { name: "Lumen Health", domain: "lumenhealth.com", plan: "Enterprise", industry: "Healthcare", size: 1200, location: "Boston, US", mrr: 9800, ageMonths: 22 },
  { name: "Pixelforge Studios", domain: "pixelforge.dev", plan: "Growth", industry: "Gaming", size: 62, location: "Austin, US", mrr: 890, ageMonths: 9 },
  { name: "Meridian Bank", domain: "meridian.co", plan: "Enterprise", industry: "Fintech", size: 2600, location: "London, UK", mrr: 14500, ageMonths: 26 },
  { name: "Cedar & Bloom", domain: "cedarbloom.com", plan: "Starter", industry: "Retail", size: 18, location: "Portland, US", mrr: 190, ageMonths: 5 },
  { name: "Volt Mobility", domain: "voltmobility.io", plan: "Growth", industry: "Transportation", size: 140, location: "Berlin, DE", mrr: 1600, ageMonths: 11 },
  { name: "Kaya Foods", domain: "kayafoods.com", plan: "Business", industry: "Food & Beverage", size: 420, location: "Nairobi, KE", mrr: 2100, ageMonths: 13 },
  { name: "Sundara Textiles", domain: "sundara.in", plan: "Growth", industry: "Manufacturing", size: 95, location: "Mumbai, IN", mrr: 720, ageMonths: 8 },
  { name: "Northstar Analytics", domain: "northstar.ai", plan: "Business", industry: "Data & AI", size: 210, location: "Toronto, CA", mrr: 3300, ageMonths: 16 },
  { name: "Harbor Freight Co", domain: "harborfreight.co", plan: "Starter", industry: "Logistics", size: 24, location: "Rotterdam, NL", mrr: 150, ageMonths: 4 },
  { name: "Quokka Labs", domain: "quokka.dev", plan: "Growth", industry: "Software", size: 48, location: "Sydney, AU", mrr: 640, ageMonths: 7 },
  { name: "Grove Dental Group", domain: "grovedental.com", plan: "Business", industry: "Healthcare", size: 300, location: "Denver, US", mrr: 1900, ageMonths: 12 },
  { name: "Aster Legal", domain: "asterlegal.com", plan: "Business", industry: "Legal", size: 130, location: "New York, US", mrr: 2200, ageMonths: 15 },
  { name: "Bluepeak Travel", domain: "bluepeak.travel", plan: "Growth", industry: "Travel", size: 88, location: "Vancouver, CA", mrr: 980, ageMonths: 10 },
  { name: "Fennel & Co", domain: "fennel.co", plan: "Starter", industry: "Agency", size: 12, location: "Dublin, IE", mrr: 120, ageMonths: 3 },
  { name: "Orbital Robotics", domain: "orbital.tech", plan: "Enterprise", industry: "Robotics", size: 760, location: "Munich, DE", mrr: 7200, ageMonths: 20 },
  { name: "Tama Retail Group", domain: "tamaretail.jp", plan: "Enterprise", industry: "Retail", size: 3400, location: "Tokyo, JP", mrr: 11200, ageMonths: 24 },
  { name: "Pinewood Media", domain: "pinewood.media", plan: "Growth", industry: "Media", size: 66, location: "Los Angeles, US", mrr: 700, ageMonths: 6 },
  { name: "Silverline Insurance", domain: "silverline.com", plan: "Enterprise", industry: "Insurance", size: 1900, location: "Hartford, US", mrr: 8600, ageMonths: 21 },
  { name: "Cobalt Studios", domain: "cobalt.design", plan: "Starter", industry: "Design", size: 9, location: "Lisbon, PT", mrr: 90, ageMonths: 2 },
  { name: "Ravel Software", domain: "ravel.io", plan: "Growth", industry: "Software", size: 155, location: "Amsterdam, NL", mrr: 1750, ageMonths: 12 },
  { name: "Duna Energy", domain: "dunaenergy.com", plan: "Business", industry: "Energy", size: 540, location: "Madrid, ES", mrr: 3100, ageMonths: 17 },
  { name: "Maple & Finch", domain: "maplefinch.com", plan: "Starter", industry: "Retail", size: 21, location: "Montreal, CA", mrr: 180, ageMonths: 5 },
  { name: "Terra Agritech", domain: "terraag.io", plan: "Growth", industry: "Agritech", size: 74, location: "São Paulo, BR", mrr: 610, ageMonths: 7 },
  { name: "Vellum Publishing", domain: "vellum.pub", plan: "Business", industry: "Publishing", size: 240, location: "Edinburgh, UK", mrr: 1400, ageMonths: 11 },
  { name: "Nimbus Cloudworks", domain: "nimbuscloud.io", plan: "Enterprise", industry: "Cloud", size: 980, location: "Seattle, US", mrr: 9100, ageMonths: 19 },
  { name: "Halcyon Wellness", domain: "halcyon.health", plan: "Growth", industry: "Wellness", size: 58, location: "Copenhagen, DK", mrr: 560, ageMonths: 6 },
  { name: "Ironwood Construction", domain: "ironwood.build", plan: "Business", industry: "Construction", size: 410, location: "Calgary, CA", mrr: 2000, ageMonths: 13 },
];

const FIRST = ["Aisha", "Wei", "Diego", "Priya", "Marcus", "Yuki", "Fatima", "Liam", "Ananya", "Omar", "Sofia", "Kwame", "Elena", "Rahul", "Chloe", "Hiroshi", "Nadia", "Tomás", "Mei", "Samuel", "Ingrid", "Arjun", "Lucia", "Kenji", "Zara", "Noah", "Amara", "Viktor", "Leila", "Daniel", "Sana", "Mateo", "Hana", "Bjorn", "Rania", "Felix", "Camila", "Ravi", "Astrid", "Jamal", "Yara", "Oscar", "Divya", "Thomas", "Keiko", "Nathan", "Amina", "Pablo", "Freya", "Sanjay", "Grace", "Emil", "Layla", "Hugo", "Mira", "André"];
const LAST = ["Okafor", "Chen", "Ramirez", "Sharma", "Delgado", "Tanaka", "Haddad", "O'Brien", "Iyer", "Farah", "Rossi", "Mensah", "Petrov", "Kapoor", "Dubois", "Yamamoto", "Novak", "Silva", "Wu", "Andersen", "Larsson", "Nair", "Costa", "Sato", "Khan", "Schmidt", "Adeyemi", "Volkov", "Haidari", "Murphy", "Malik", "Fernandez", "Kim", "Eriksson", "Aziz", "Weber", "Torres", "Reddy", "Berg", "Osei", "Saleh", "Lindqvist", "Menon", "Fischer", "Nakamura", "Walsh", "Bello", "Morales", "Nyman", "Gupta", "Bauer", "Hassan", "Moreau", "Patel", "Johansson", "Diallo"];
const TITLES = ["Operations Manager", "Head of Finance", "Software Engineer", "IT Administrator", "Product Manager", "Data Analyst", "Marketing Lead", "Customer Success Manager", "CTO", "Founder", "Office Manager", "Billing Coordinator", "DevOps Engineer", "Support Lead", "Procurement Manager", "People Ops Manager", "Sales Director", "Solutions Architect"];

const MACROS: { name: string; body: string; shortcut: string }[] = [
  { name: "Password reset steps", shortcut: "#reset", body: "Happy to help you get back in. Head to Settings → Security → Reset password and you'll get a link within a couple of minutes (check spam if it's slow). If the link still doesn't arrive, let me know the exact email on the account and I'll trigger it manually from our side." },
  { name: "Invoice explanation", shortcut: "#invoice", body: "Thanks for flagging this. I've pulled up the invoice — the amount reflects a mid-cycle plan change, so you're seeing a prorated charge for the days on the new plan plus the standard renewal. I've attached a line-by-line breakdown; let me know if anything still looks off and I'll dig in." },
  { name: "API rate limits", shortcut: "#rate", body: "The 429s mean you're hitting the rate limit for your plan (currently 120 requests/minute on Growth). Best fixes: batch reads where you can, add exponential backoff on 429, and cache anything that doesn't change often. If your workload genuinely needs more headroom I can look at a higher tier for you." },
  { name: "SSO / SAML setup", shortcut: "#sso", body: "For SAML I'll need your IdP metadata URL (or the XML), and I'll send back our ACS URL and Entity ID to paste on your side. One gotcha we see a lot: the NameID has to be the user's email and the attribute mapping is case-sensitive. Once you've configured your side, tell me and we'll run a test login together." },
  { name: "Export timeout workaround", shortcut: "#export", body: "Large exports can time out in the browser when the workspace is big. Two options that reliably work: (1) narrow the date range and export in chunks, or (2) use the async export endpoint, which emails you a link when the file is ready instead of holding the request open. I'm also raising the batch limit on your account so the sync path has more room." },
  { name: "Refund confirmed", shortcut: "#refund", body: "Done — I've issued the refund to your original payment method. It usually lands in 5–10 business days depending on your bank. You'll get a separate credit-note email for your records. Sorry for the hassle, and thanks for your patience while we sorted it out." },
  { name: "Bug acknowledged", shortcut: "#bug", body: "Thanks for the detailed report — I've reproduced it on my side, so this is definitely on us, not your setup. I've logged it with engineering and I'll keep this ticket open and update you the moment there's a fix or a workaround. Really appreciate you taking the time to write it up clearly." },
  { name: "Feature request logged", shortcut: "#feature", body: "Great suggestion — I can see exactly why that would help your workflow. I've logged it on our product board and linked your account so you'll be notified if it ships. I can't promise a date, but this is the kind of feedback the team genuinely reads. Thank you." },
  { name: "Onboarding welcome", shortcut: "#welcome", body: "Welcome aboard! I'm your point of contact if anything comes up. A few things that help teams get value fast: connect your data source first, invite the rest of your team from Settings → Members, and start from a dashboard template rather than a blank one. Want me to set up a 20-minute walkthrough?" },
  { name: "Escalated to engineering", shortcut: "#escalate", body: "I've escalated this to our engineering on-call with the logs and timestamps you gave me — that context made it much faster to hand off. I'll stay on the ticket as your point of contact so you're not chasing multiple people. Expect an update from me within the next few hours." },
  { name: "Webhook debugging", shortcut: "#webhook", body: "For webhook failures the usual culprits are: the endpoint returning a non-2xx (we retry, then disable after repeated failures), a signature mismatch (verify against the raw body, not the parsed JSON), or a timeout (we expect a response within 5s). You can replay recent deliveries from Settings → Webhooks → Recent to test a fix without waiting for a real event." },
  { name: "Anything else?", shortcut: "#close", body: "Glad that sorted it! I'll go ahead and close this out, but just reply here any time and it'll reopen straight to me — no need to start over. Have a good one." },
];

type Team = { name: string; emoji: string; members: string[] };
const TEAMS: Team[] = [
  { name: "Frontline", emoji: "🎧", members: [AGENTS.ales, AGENTS.sam] },
  { name: "Billing", emoji: "💳", members: [AGENTS.ales] },
  { name: "Technical", emoji: "🛠️", members: [AGENTS.sam] },
];
const teamForTopic = (topic: string): string => {
  if (["billing", "account"].includes(topic)) return "Billing";
  if (["bug", "integration", "api", "performance", "outage", "data"].includes(topic)) return "Technical";
  return "Frontline";
};

const strip = (s: string) => s.normalize("NFD").replace(/[^a-zA-Z]/g, "").toLowerCase();
const DAY = 1440;

// ── engine ───────────────────────────────────────────────────────────────────
export async function seedRichDemo(c: Q): Promise<void> {
  _s = 0x9e3779b9; // reset PRNG for a stable structure each run

  // 1. PURGE all prior Acme demo content (RLS scopes every statement to Acme).
  await c(`DELETE FROM autoreply_queue WHERE tenant_id = current_tenant()`);
  for (const t of ["nps_responses", "csat_responses", "ticket_notes"]) {
    try { await c(`DELETE FROM ${t} WHERE tenant_id = current_tenant()`); } catch { /* table may predate */ }
  }
  await c(`DELETE FROM tickets WHERE tenant_id = current_tenant()`); // messages cascade
  for (const t of ["contact_events", "contact_identities"]) {
    try { await c(`DELETE FROM ${t} WHERE tenant_id = current_tenant()`); } catch { /* */ }
  }
  await c(`DELETE FROM contacts WHERE tenant_id = current_tenant()`);
  await c(`DELETE FROM companies WHERE tenant_id = current_tenant()`);
  await c(`DELETE FROM macros WHERE tenant_id = current_tenant()`);

  // 2. TEAMS
  const teamIds: Record<string, string> = {};
  for (const t of TEAMS) {
    const r = await c(
      `INSERT INTO teams (tenant_id, name, emoji) VALUES (current_tenant(), $1, $2)
       ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET emoji = EXCLUDED.emoji RETURNING id`,
      [t.name, t.emoji],
    );
    teamIds[t.name] = r.rows[0].id;
    for (const m of t.members) {
      try { await c(`INSERT INTO team_members (tenant_id, team_id, user_id) VALUES (current_tenant(), $1, $2) ON CONFLICT DO NOTHING`, [teamIds[t.name], m]); } catch { /* */ }
    }
  }

  // 3. MACROS
  for (const m of MACROS) {
    await c(`INSERT INTO macros (tenant_id, name, body, shortcut) VALUES (current_tenant(), $1, $2, $3)`, [m.name, m.body, m.shortcut]);
  }

  // 4. COMPANIES
  type CompanyRow = Co & { id: string; ageDays: number };
  const companies: CompanyRow[] = [];
  for (const co of COMPANIES) {
    const ageDays = co.ageMonths * 30 + rint(-8, 8);
    const attrs = { industry: co.industry, size: co.size, location: co.location, mrr: co.mrr, seed: "1" };
    const r = await c(
      `INSERT INTO companies (tenant_id, name, domain, plan, attributes, created_at, updated_at)
       VALUES (current_tenant(), $1, $2, $3, $4::jsonb, now() - ($5 || ' days')::interval, now() - ($6 || ' days')::interval)
       RETURNING id`,
      [co.name, co.domain, co.plan, JSON.stringify(attrs), ageDays, rint(0, 20)],
    );
    companies.push({ ...co, id: r.rows[0].id, ageDays });
  }

  // 5. CONTACTS — 2–6 per company + a handful of individuals (personal-email users).
  type ContactRow = { id: string; name: string; email: string; company?: CompanyRow };
  const contacts: ContactRow[] = [];
  const usedEmails = new Set<string>();
  const mkContact = async (first: string, last: string, domain: string, co: CompanyRow | undefined) => {
    let email = `${strip(first)}.${strip(last)}@${domain}`;
    if (usedEmails.has(email)) email = `${strip(first)}.${strip(last)}${rint(2, 99)}@${domain}`;
    usedEmails.add(email);
    const name = `${first} ${last}`;
    const title = pick(TITLES);
    const attrs: Record<string, unknown> = { title, seed: "1" };
    if (co) { attrs.location = co.location; attrs.plan = co.plan; }
    const joinDays = co ? rint(3, Math.max(6, co.ageDays - 10)) : rint(3, 240);
    const avatar = `https://i.pravatar.cc/120?u=${encodeURIComponent(email)}`;
    const r = await c(
      `INSERT INTO contacts (tenant_id, email, name, company, company_id, attributes, avatar_url, created_at, updated_at)
       VALUES (current_tenant(), $1, $2, $3, $4, $5::jsonb, $6, now() - ($7 || ' days')::interval, now() - ($8 || ' days')::interval)
       RETURNING id`,
      [email, name, co?.name ?? "", co?.id ?? null, JSON.stringify(attrs), avatar, joinDays, rint(0, Math.min(joinDays, 40))],
    );
    const cid = r.rows[0].id as string;
    try { await c(`INSERT INTO contact_identities (tenant_id, contact_id, channel_type, external_id) VALUES (current_tenant(), $1, 'email', $2) ON CONFLICT DO NOTHING`, [cid, email]); } catch { /* */ }
    const row: ContactRow = { id: cid, name, email, company: co };
    contacts.push(row);
    return row;
  };
  for (const co of companies) {
    const n = rint(2, 6);
    for (let i = 0; i < n; i++) await mkContact(pick(FIRST), pick(LAST), co.domain, co);
  }
  const personalDomains = ["gmail.com", "outlook.com", "proton.me", "icloud.com", "hey.com"];
  for (let i = 0; i < 14; i++) await mkContact(pick(FIRST), pick(LAST), pick(personalDomains), undefined);

  // Weighted contact pool: a minority are "frequent" customers (repeat tickets).
  const frequent = shuffle(contacts).slice(0, Math.floor(contacts.length * 0.18));
  const pickContact = (): ContactRow => (chance(0.42) && frequent.length ? pick(frequent) : pick(contacts));

  // 6. TICKETS from the scenario library. Unique scenarios once; reuse ones several times.
  const CHANNEL_DEFAULT: [string, number][] = [["email", 52], ["widget", 22], ["discord", 10], ["slack", 8], ["whatsapp", 5], ["telegram", 3]];
  const jobs: Scenario[] = [];
  for (const s of SCENARIOS) {
    jobs.push(s);
    if (s.reuse) for (let k = 0; k < rint(6, 11); k++) jobs.push(s);
  }
  const ordered = shuffle(jobs);

  let nOpen = 0, nPending = 0, nClosed = 0, nCsat = 0, msgCount = 0;
  let seq = 0;
  for (const s of ordered) {
    seq++;
    const contact = pickContact();
    const channel = s.channelPref ?? weighted(CHANNEL_DEFAULT);
    // status distribution: mostly solved history, then awaiting-us, then pending-on-customer
    const roll = rnd() * 100;
    const state: "closed" | "us" | "customer" = roll < 66 ? "closed" : roll < 86 ? "us" : "customer";
    const statusCol = state === "closed" ? "closed" : "open";

    // Slice the thread to fit the chosen end-state.
    let turns: Turn[] = [...s.turns];
    if (state === "us") {
      while (turns.length > 1 && turns[turns.length - 1].who === "a") turns.pop();
      if (turns[turns.length - 1].who !== "c") turns.push({ who: "c", body: "Following up on this — any update? Thanks." });
    } else if (state === "customer") {
      while (turns.length > 1 && turns[turns.length - 1].who === "c") turns.pop();
      if (turns[turns.length - 1].who !== "a") turns.push({ who: "a", body: "Thanks for the details — I'm looking into this now and will get back to you shortly." });
    } else {
      // closed: ensure it ends on an agent turn (resolution)
      if (turns[turns.length - 1].who !== "a") turns.push({ who: "a", body: pick([MACROS[0].body, MACROS[10].body, "All sorted on my end — I've applied the fix and confirmed it's working. Closing this out, but reply any time to reopen."]) });
    }

    const assignee = state === "closed" || state === "customer" || chance(0.72)
      ? weighted<string>([[AGENTS.ales, 55], [AGENTS.sam, 45]])
      : null; // some "needs reply" tickets sit unassigned
    const teamName = chance(0.45) ? teamForTopic(s.topic) : null;
    const teamId = teamName ? teamIds[teamName] : null;
    const priority = s.priority;
    const whoseTurn = state === "closed" ? null : state === "us" ? "us" : "customer";

    // timing — solved tickets carry the months-deep history; open tickets are recent so the
    // queue reads as a busy-but-healthy desk. A brand-new unanswered ticket stays inside its
    // 60-min first-response window; a mid-thread one inside the 1-day resolution window; only a
    // minority drift over, so there's a realistic breached few, not an all-red wall.
    const hasAgent = turns.some((t) => t.who === "a");
    let createdMin: number;
    if (state === "closed") {
      createdMin = Math.floor(150 * Math.pow(rnd(), 1.6)) * DAY + rint(30, DAY - 1);
    } else if (!hasAgent) {
      createdMin = rint(4, 55);                      // just arrived — inside first-response SLA
    } else if (state === "us") {
      createdMin = rint(30, Math.floor(1.4 * DAY));  // mid-thread, awaiting our follow-up
    } else {
      createdMin = rint(60, Math.floor(1.5 * DAY));  // pending on the customer
    }
    let cursor = createdMin; // minutes ago at ticket creation
    const msgTimes: number[] = [];
    for (let i = 0; i < turns.length; i++) {
      if (i === 0) { msgTimes.push(cursor); continue; }
      const gap = turns[i].who === "a"
        ? weighted<number>([[rint(6, 55), 55], [rint(60, 240), 30], [rint(300, 1600), 15]]) // agent response time
        : weighted<number>([[rint(20, 180), 40], [rint(180, 1400), 35], [rint(1440, 5000), 25]]); // customer reply
      cursor = Math.max(2, cursor - gap);
      msgTimes.push(cursor);
    }
    const lastMin = msgTimes[msgTimes.length - 1];
    const closedMin = state === "closed" ? Math.max(1, lastMin - rint(1, 25)) : null;
    const updatedMin = closedMin ?? lastMin;
    const sentiment = s.sentiment;

    const tRow = await c(
      `INSERT INTO tickets (tenant_id, subject, status, status_category, channel_type, contact_id, assignee_id, team_id, priority, tags, whose_turn, topic, sentiment, created_at, updated_at, closed_at)
       VALUES (current_tenant(), $1, $2, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11,
               now() - ($12 || ' minutes')::interval, now() - ($13 || ' minutes')::interval,
               ${closedMin === null ? "NULL" : `now() - ($14 || ' minutes')::interval`})
       RETURNING id`,
      closedMin === null
        ? [s.subject, statusCol, channel, contact.id, assignee, teamId, priority, s.tags, whoseTurn, s.topic, sentiment, createdMin, updatedMin]
        : [s.subject, statusCol, channel, contact.id, assignee, teamId, priority, s.tags, whoseTurn, s.topic, sentiment, createdMin, updatedMin, closedMin],
    );
    const ticketId = tRow.rows[0].id as string;
    if (state === "closed") nClosed++; else if (state === "us") nOpen++; else nPending++;

    // messages
    const msgAgent = assignee ?? AGENTS.ales;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const at = t.who === "a";
      await c(
        `INSERT INTO messages (tenant_id, ticket_id, author_type, author_kind, author_id, author_contact_id, author_external_name, body, channel_type, idempotency_key, created_at)
         VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now() - ($10 || ' minutes')::interval)`,
        [ticketId, at ? "agent" : "customer", at ? "agent" : "customer", at ? msgAgent : null, at ? null : contact.id, at ? null : contact.name, t.body, channel, `seed-${seq}-${i}`, msgTimes[i]],
      );
      msgCount++;
    }

    // internal note
    const noteText = s.note ?? (chance(0.22) ? pick(["Verified on staging — reproduces. Looping engineering.", "Customer is on the Growth plan, seat-limited. Flagging for CS as an upsell.", "Second time this account has hit this — worth a KB article.", "Confirmed refund eligibility per policy. Approved.", "High-value account (Enterprise). Prioritise.", "Left a voicemail as well; they prefer async."]) : null);
    if (noteText) {
      const author = assignee ?? AGENTS.ales;
      await c(
        `INSERT INTO ticket_notes (tenant_id, ticket_id, author_id, author_name, body, created_at)
         VALUES (current_tenant(), $1, $2, $3, $4, now() - ($5 || ' minutes')::interval)`,
        [ticketId, author, AGENT_NAME[author] ?? "Aleš", noteText, Math.max(1, lastMin + rint(1, 20))],
      );
    }

    // CSAT on ~62% of closed; NPS occasionally.
    if (state === "closed" && chance(0.62)) {
      const rating = weighted<number>([[5, 46], [4, 30], [3, 12], [2, 7], [1, 5]]);
      const comment = rating >= 4
        ? pick(["Fast and clear, thank you!", "Exactly what I needed.", "Really helpful, sorted in minutes.", "Great support as always.", null, null])
        : rating === 3 ? pick(["Got there in the end.", "OK, took a couple of back-and-forths.", null])
        : pick(["Took too long to resolve.", "Had to explain the problem twice.", "Not really fixed, just a workaround."]);
      await c(
        `INSERT INTO csat_responses (tenant_id, ticket_id, rating, comment, created_at)
         VALUES (current_tenant(), $1, $2, $3, now() - ($4 || ' minutes')::interval)`,
        [ticketId, rating, comment, Math.max(1, (closedMin ?? lastMin) - rint(1, 8))],
      );
      nCsat++;
      if (chance(0.28)) {
        const score = rating >= 4 ? rint(8, 10) : rating === 3 ? rint(6, 8) : rint(2, 6);
        await c(`INSERT INTO nps_responses (tenant_id, ticket_id, score, comment, created_at) VALUES (current_tenant(), $1, $2, $3, now() - ($4 || ' minutes')::interval)`,
          [ticketId, score, null, Math.max(1, (closedMin ?? lastMin) - rint(1, 6))]);
      }
    }
  }

  // 7. contact_events — a little activity history on the frequent contacts.
  const EVENTS = ["logged_in", "viewed_dashboard", "ran_report", "exported_csv", "invited_teammate", "connected_integration", "upgraded_plan", "opened_ticket"];
  for (const ct of frequent) {
    const n = rint(3, 9);
    for (let i = 0; i < n; i++) {
      try {
        await c(`INSERT INTO contact_events (tenant_id, contact_id, name, metadata, created_at) VALUES (current_tenant(), $1, $2, $3::jsonb, now() - ($4 || ' minutes')::interval)`,
          [ct.id, pick(EVENTS), JSON.stringify({ seed: true }), rint(30, 120 * DAY)]);
      } catch { /* */ }
    }
  }

  console.log(`  rich seed: ${companies.length} companies, ${contacts.length} contacts, ${ordered.length} tickets (${nClosed} solved / ${nOpen} awaiting-us / ${nPending} pending), ${msgCount} messages, ${nCsat} CSAT, ${MACROS.length} macros, ${TEAMS.length} teams`);
}
