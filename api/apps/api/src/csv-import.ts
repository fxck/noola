import type { ContactInputShape } from "./contacts.js";
import type { CompanyImportRow } from "./companies.js";

// CSV → contacts/companies import (0092, extended 0095-era Intercom migration). A small RFC-4180
// parser (quoted fields, embedded commas/newlines, "" escapes) + header mappers onto the
// idempotent upsert shapes. Recognized headers are matched case/space/underscore-insensitively;
// every OTHER column lands in attributes under its original name (nothing is dropped). Semantic
// columns Intercom exports (unsubscribed, last seen, avatar) map onto real contact columns; the
// free-text company name is later resolved to a company_id link by the import route.

/** The field delimiter, sniffed from the header line: comma, semicolon (the Czech/European Excel
 *  default) or tab — whichever occurs most outside quotes. Comma on a tie / nothing found. */
export function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
  return best;
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  text = text.replace(/^\uFEFF/, ""); // Excel's UTF-8 BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { pushField(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) pushRow();
  // Drop fully-empty trailing rows (a final newline is normal).
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function normalizeHeader(h: string): string {
  // Strip a trailing parenthetical (e.g. Intercom's "Last seen (CEST)" timezone tag) BEFORE
  // collapsing separators, so "Last seen (CEST)" → "lastseen" matches the semantic column.
  // Diacritics are folded too, so Czech headers match ("Jméno" → "jmeno", "E-mail" → "email").
  return h
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[\s_.:-]+/g, "");
}

// Header aliases (normalized): English exports (Intercom, HubSpot, Google Contacts, event tools) and
// Czech ones (Excel sheets from events).
const EMAIL_HEADERS = new Set(["email", "emailaddress", "emailadresa", "emailovaadresa", "mail", "primaryemail"]);
const ID_HEADERS = new Set(["externalid", "id", "userid"]);
const NAME_HEADERS = new Set(["name", "fullname", "celejmeno", "jmenoaprijmeni", "kontakt", "contactname"]);
const FIRST_HEADERS = new Set(["firstname", "givenname", "jmeno", "krestnijmeno"]);
const LAST_HEADERS = new Set(["lastname", "surname", "familyname", "prijmeni"]);
const COMPANY_HEADERS = new Set(["company", "companyname", "companies", "firma", "spolecnost", "organizace", "organization", "organisation"]);

/** A row the import couldn't take, with its spreadsheet row number (header = row 1). */
export interface CsvIssue {
  row: number;
  reason: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Intercom "Unsubscribed from Emails" is a boolean-ish string; other exports give a date. Truthy
// (true/yes/1) → unsubscribed as of now; a parseable date → that instant; anything else → not set.
const TRUTHY = new Set(["true", "yes", "y", "1", "unsubscribed"]);
function unsubscribedAt(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (TRUTHY.has(v)) return new Date().toISOString();
  return parseMaybeDate(value);
}

// A best-effort date parse (ISO, RFC, or a 10-/13-digit unix epoch as Intercom sometimes exports).
// Returns an ISO string or null — never throws, never a bogus 1970 from a non-date.
function parseMaybeDate(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^\d{10}$/.test(v)) return new Date(Number(v) * 1000).toISOString();       // unix seconds
  if (/^\d{13}$/.test(v)) return new Date(Number(v)).toISOString();              // unix millis
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseCsvContacts(
  text: string,
): { rows: ContactInputShape[]; withoutEmail: ContactInputShape[]; skipped: number; issues: CsvIssue[] } | { error: string } {
  const grid = parseCsv(text);
  if (grid.length < 2) return { error: "need a header row plus at least one data row" };
  const headers = grid[0].map(normalizeHeader);
  const has = (set: Set<string>) => headers.some((h) => set.has(h));
  if (!has(EMAIL_HEADERS) && !has(ID_HEADERS) && !has(NAME_HEADERS) && !has(FIRST_HEADERS) && !has(LAST_HEADERS)) {
    return { error: "header row needs an email, external id or name column (e.g. email, name, jméno, příjmení)" };
  }
  // Rows WITH an identity (email / external id) — idempotent upsert; rows with only a name — imported
  // as leads that can't be emailed (matched on re-import by name + company).
  const rows: ContactInputShape[] = [];
  const withoutEmail: ContactInputShape[] = [];
  const issues: CsvIssue[] = [];
  let skipped = 0;
  const skip = (row: number, reason: string) => {
    skipped++;
    if (issues.length < 100) issues.push({ row, reason });
  };
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const rowNo = r + 1; // spreadsheet numbering: the header is row 1
    const contact: ContactInputShape = {};
    const attributes: Record<string, unknown> = {};
    let first = "";
    let last = "";
    let badEmail: string | null = null;
    for (let c = 0; c < headers.length; c++) {
      const value = (cells[c] ?? "").trim();
      if (!value) continue;
      const h = headers[c];
      if (EMAIL_HEADERS.has(h)) {
        if (EMAIL_RE.test(value)) contact.email = value.toLowerCase();
        else badEmail = value;
      } else if (NAME_HEADERS.has(h)) {
        contact.name = value.slice(0, 200);
      } else if (FIRST_HEADERS.has(h)) {
        first = value;
      } else if (LAST_HEADERS.has(h)) {
        last = value;
      } else if (ID_HEADERS.has(h)) {
        // Intercom's "User ID" is the stable external identity — the upsert key + verification handle.
        contact.external_id = value.slice(0, 200);
      } else if (COMPANY_HEADERS.has(h)) {
        contact.company = value.slice(0, 200);
      } else if (h === "avatar" || h === "avatarurl" || h === "avatarimageurl") {
        contact.avatar_url = value.slice(0, 2048);
      } else if (h === "unsubscribedfromemails" || h === "unsubscribed" || h === "emailunsubscribed") {
        const at = unsubscribedAt(value);
        if (at) contact.unsubscribed_at = at;
      } else if (h === "lastseen" || h === "lastseenat" || h === "lastrequestat" || h === "lastheardfrom") {
        const at = parseMaybeDate(value);
        if (at) contact.last_seen_at = at;
      } else if (h === "signedup" || h === "signedupat" || h === "createdat" || h === "firstseen" || h === "firstseenat") {
        // "customer since": Intercom Signed up / First Seen becomes the real created_at (Signed up wins).
        const at = parseMaybeDate(value);
        const isSignup = h === "signedup" || h === "signedupat" || h === "createdat";
        if (at && (isSignup || !contact.created_at)) contact.created_at = at;
      } else {
        // Unknown columns become free-form attributes under the original-ish key.
        attributes[grid[0][c].trim().slice(0, 60) || h] = value.slice(0, 500);
      }
    }
    // Compose the display name from first/last name columns when no full-name column was present.
    if (!contact.name) {
      const composed = [first, last].filter(Boolean).join(" ");
      if (composed) contact.name = composed.slice(0, 200);
    }
    if (Object.keys(attributes).length) contact.attributes = attributes;

    if (badEmail !== null && !contact.external_id) {
      // A typo'd address would otherwise land as a separate email-less contact and duplicate the person
      // once fixed — better to report it and let the row be corrected.
      skip(rowNo, `invalid email “${badEmail.slice(0, 80)}”`);
      continue;
    }
    if (contact.email || contact.external_id) rows.push(contact);
    else if (contact.name) withoutEmail.push(contact);
    else if (cells.some((v) => v.trim())) skip(rowNo, "no email and no name");
    else continue; // a blank line — not worth reporting
    if (rows.length + withoutEmail.length >= 10_000) break; // hard row ceiling per import
  }
  return { rows, withoutEmail, skipped, issues };
}

export function parseCsvCompanies(
  text: string,
): { rows: CompanyImportRow[]; skipped: number } | { error: string } {
  const grid = parseCsv(text);
  if (grid.length < 2) return { error: "need a header row plus at least one data row" };
  const headers = grid[0].map(normalizeHeader);
  if (!headers.some((h) => h === "name" || h === "companyname" || h === "company")) {
    return { error: "header row must include a 'name' (company name) column" };
  }
  const rows: CompanyImportRow[] = [];
  let skipped = 0;
  for (const cells of grid.slice(1)) {
    let name = "";
    let externalId: string | undefined;
    let domain: string | undefined;
    let plan: string | undefined;
    let createdAt: string | undefined;
    const attributes: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const value = (cells[c] ?? "").trim();
      if (!value) continue;
      const h = headers[c];
      if (h === "name" || h === "companyname" || h === "company") {
        if (!name) name = value.slice(0, 300);
      } else if (h === "companyid" || h === "externalid" || h === "id") {
        // Intercom's "Company ID" is your external id for the account (the dedup handle).
        if (!externalId) externalId = value.slice(0, 200);
      } else if (h === "domain" || h === "website" || h === "companywebsite" || h === "url" || h === "companyurl") {
        if (!domain) domain = value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").slice(0, 300);
      } else if (h === "plan" || h === "companyplan" || h === "planname") {
        plan = value.slice(0, 120);
      } else if (h === "companycreatedat" || h === "createdat") {
        const at = parseMaybeDate(value);
        if (at) createdAt = at;
      } else {
        // size, seats, MRR, industry, last seen, … → attributes (nothing dropped).
        attributes[grid[0][c].trim().slice(0, 60) || h] = value.slice(0, 500);
      }
    }
    if (!name) { skipped++; continue; } // a company with no name can't be keyed
    const row: CompanyImportRow = { name };
    if (externalId) row.external_id = externalId;
    if (domain) row.domain = domain;
    if (plan) row.plan = plan;
    if (createdAt) row.created_at = createdAt;
    if (Object.keys(attributes).length) row.attributes = attributes;
    rows.push(row);
    if (rows.length >= 10_000) break;
  }
  return { rows, skipped };
}
