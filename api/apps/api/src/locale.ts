import { withTenant, relayPool } from "@repo/db";

// Wave 4: conversational reach — language detection. A deterministic, always-on classifier that
// names the primary language of a conversation (ISO 639-1). Free, air-gap-safe, no model call:
// non-Latin scripts are decided by Unicode range; Latin-script languages by stopword frequency.
// A hosted model is the documented upgrade behind detectLanguage — the call site never changes.
//
// The detected locale is stamped once on the ticket (stable per conversation) and powers both the
// per-agent auto-translation decision and the ticket-volume-by-language analytics breakdown.

// ISO-639-1 → English display name, for the "translated from X" badge + the analytics legend.
// Only the languages this detector can actually name are listed; anything else stays null/unknown.
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  cs: "Czech",
  sk: "Slovak",
  pl: "Polish",
  hu: "Hungarian",
  ru: "Russian",
  uk: "Ukrainian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  he: "Hebrew",
  el: "Greek",
};

/** Human-readable language name for an ISO code, falling back to the code itself (upper-cased)
 *  and to "Unknown" for null — safe to call with anything the UI hands over. */
export function localeName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

// ── Script-based detection (high confidence) ─────────────────────────────────
// A single character in one of these ranges is decisive — no Latin-script language uses them, so
// one hit ends the classification. Ordered most-specific first (kana before Han: Japanese text
// mixes both, and the presence of kana disambiguates it from Chinese).
const SCRIPT_RULES: Array<[string, RegExp]> = [
  ["ja", /[぀-ゟ゠-ヿ]/], // Hiragana / Katakana
  ["ko", /[가-힯ᄀ-ᇿ]/], // Hangul
  ["zh", /[一-鿿]/], // Han (after kana check → Chinese)
  ["ru", /[Ѐ-ӿ]/], // Cyrillic (ru/uk disambiguated below)
  ["ar", /[؀-ۿ]/], // Arabic
  ["he", /[֐-׿]/], // Hebrew
  ["el", /[Ͱ-Ͽ]/], // Greek
];

// Ukrainian-only Cyrillic letters — distinguishes uk from ru without a full model.
const UK_LETTERS = /[іїєґ]/i;

// ── Stopword-based detection (Latin scripts) ─────────────────────────────────
// Short, high-frequency function words per language. These are the words that carry the language
// signal regardless of topic; matching is whole-word so "as" (en) doesn't fire on "casa" (es).
const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "is", "are", "you", "to", "of", "for", "with", "this", "that", "have", "not", "your", "please", "can", "how", "it", "we", "my"],
  es: ["el", "la", "los", "las", "que", "de", "y", "es", "un", "una", "por", "para", "con", "no", "se", "su", "como", "hola", "gracias", "pero"],
  fr: ["le", "la", "les", "de", "et", "un", "une", "que", "pour", "pas", "vous", "je", "est", "avec", "bonjour", "merci", "mais", "ce", "sur", "nous"],
  de: ["der", "die", "das", "und", "ist", "ich", "nicht", "ein", "eine", "sie", "mit", "für", "auf", "wie", "hallo", "danke", "aber", "auch", "haben", "mein"],
  pt: ["o", "está", "os", "as", "de", "que", "e", "um", "uma", "para", "com", "não", "por", "se", "como", "olá", "obrigado", "mas", "meu", "você"],
  it: ["il", "la", "di", "che", "e", "un", "una", "per", "non", "con", "come", "sono", "ciao", "grazie", "ma", "questo", "mio", "sono", "anche", "molto"],
  nl: ["de", "het", "een", "en", "is", "van", "ik", "niet", "je", "dat", "met", "voor", "hoe", "hallo", "bedankt", "maar", "mijn", "ook", "wij", "kan"],
  cs: ["je", "se", "na", "že", "jsem", "není", "jak", "ale", "pro", "jsou", "když", "nebo", "prosím", "děkuji", "dobrý", "mám", "můj", "už", "také", "bych"],
  sk: ["je", "sa", "na", "že", "som", "nie", "ako", "ale", "pre", "sú", "keď", "alebo", "prosím", "ďakujem", "dobrý", "mám", "môj", "už", "tiež", "by"],
  pl: ["mogę", "w", "nie", "się", "na", "że", "jest", "jak", "ale", "dla", "czy", "jestem", "proszę", "dziękuję", "mam", "mój", "moje", "też", "bardzo", "dzień"],
  hu: ["szeretnék", "az", "és", "hogy", "nem", "tudok", "egy", "van", "meg", "de", "ez", "csak", "már", "kérem", "köszönöm", "szia", "vagy", "nincs", "jó", "napot"],
};

const WORD_RE = /[\p{L}]+/gu;

/**
 * Name the primary language of `text` as an ISO-639-1 code, or null when there isn't enough signal
 * to be honest about it (too short, or no language scores above the floor). Deterministic: script
 * ranges decide non-Latin text outright; Latin text is scored by stopword frequency, normalised by
 * word count so a long English message doesn't out-score a short Spanish one purely on length.
 */
export function detectLanguage(text: string | null | undefined): string | null {
  const raw = (text ?? "").trim();
  if (raw.length < 3) return null;

  // Script pass — one decisive character ends it.
  for (const [lang, re] of SCRIPT_RULES) {
    if (re.test(raw)) {
      if (lang === "ru" && UK_LETTERS.test(raw)) return "uk";
      return lang;
    }
  }

  // Stopword pass over lower-cased word tokens.
  const words = raw.toLowerCase().match(WORD_RE);
  if (!words || words.length === 0) return null;
  const total = words.length;
  const set = new Set(words);

  let best: string | null = null;
  let bestScore = 0;
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    let hits = 0;
    for (const w of stops) if (set.has(w)) hits += 1;
    // Normalise by message length so short and long messages compete fairly; a single hit in a
    // three-word message is strong, one hit in a fifty-word message is weak.
    const score = hits / Math.sqrt(total);
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }

  // Confidence floor: at least one stopword hit AND a normalised score that clears the noise. Below
  // it we return null rather than guess — an unstamped ticket is honest; a wrong locale is not.
  if (best && bestScore >= 0.4) return best;
  return null;
}

/** Raise this when the detector names languages differently, so the startup re-detection revisits every ticket. */
export const LOCALE_DETECTOR_VERSION = 2;

/**
 * Detect and stamp the ticket's locale from a customer message — but only once. The migration keeps
 * locale stable per conversation (it reflects the customer's language, set by their first message),
 * so this is a fill-if-null update. Best-effort: a detection/DB failure must never affect ingest.
 * Returns the effective locale (existing or newly set), or null when still undetermined.
 */
export async function updateTicketLocale(
  tenantId: string,
  ticketId: string,
  text: string,
): Promise<string | null> {
  const detected = detectLanguage(text);
  if (!detected) return null;
  try {
    const r = await withTenant(tenantId, (c) =>
      c.query(
        "UPDATE tickets SET locale = $1, locale_version = $3 WHERE id = $2 AND locale IS NULL RETURNING locale",
        [detected, ticketId, LOCALE_DETECTOR_VERSION],
      ),
    );
    // If the row already had a locale, RETURNING is empty — read it back so callers get the truth.
    if (r.rowCount) return detected;
    const cur = await withTenant(tenantId, (c) =>
      c.query("SELECT locale FROM tickets WHERE id = $1", [ticketId]),
    );
    return (cur.rows[0]?.locale as string | null) ?? null;
  } catch {
    return null;
  }
}

type ReLog = { info?: (o: unknown, m?: string) => void; warn?: (o: unknown, m?: string) => void };

/**
 * Re-detects the language of every ticket that an older detector named, from its first customer messages.
 * A ticket whose messages name no language gets none, so nothing translates its replies into a wrong one.
 */
export async function redetectTicketLocales(log?: ReLog): Promise<number> {
  let after = "00000000-0000-0000-0000-000000000000";
  let changed = 0;
  for (;;) {
    // The relay role reads across workspaces but can't write tickets, so each workspace's batch is written under its own tenant.
    const r = await relayPool.query<{ tenant_id: string; id: string; locale: string | null; bodies: string[] | null }>(
      `SELECT t.tenant_id, t.id, t.locale,
              (SELECT array_agg(f.body ORDER BY f.created_at)
                 FROM (SELECT m.body, m.created_at FROM messages m
                        WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id
                          AND m.author_type = 'customer' AND m.deleted_at IS NULL
                        ORDER BY m.created_at LIMIT 5) f) AS bodies
         FROM tickets t
        WHERE (t.locale_version IS NULL OR t.locale_version < $1) AND t.id > $2
        ORDER BY t.id LIMIT 500`,
      [LOCALE_DETECTOR_VERSION, after],
    );
    if (r.rows.length === 0) break;
    after = r.rows[r.rows.length - 1].id;
    const byTenant = new Map<string, { ids: string[]; locales: (string | null)[] }>();
    for (const row of r.rows) {
      const locale = (row.bodies ?? []).map((b) => detectLanguage(b)).find((l) => l !== null) ?? null;
      if (locale !== row.locale) changed++;
      const batch = byTenant.get(row.tenant_id) ?? { ids: [], locales: [] };
      batch.ids.push(row.id);
      batch.locales.push(locale);
      byTenant.set(row.tenant_id, batch);
    }
    for (const [tenantId, batch] of byTenant) {
      await withTenant(tenantId, (c) =>
        c.query(
          // A ticket that ingest or another api instance has updated since the read keeps its newer language.
          `UPDATE tickets SET locale = v.locale, locale_version = $3
             FROM unnest($1::uuid[], $2::text[]) AS v(id, locale)
            WHERE tickets.id = v.id AND (tickets.locale_version IS NULL OR tickets.locale_version < $3)`,
          [batch.ids, batch.locales, LOCALE_DETECTOR_VERSION],
        ),
      );
    }
  }
  if (changed) log?.info?.({ changed }, "ticket languages re-detected");
  return changed;
}
