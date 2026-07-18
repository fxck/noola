import type { ContactInputShape } from "./contacts.js";
import type { CompanyImportRow } from "./companies.js";

// CSV → contacts/companies import (0092, extended 0095-era Intercom migration). A small RFC-4180
// parser (quoted fields, embedded commas/newlines, "" escapes) + header mappers onto the
// idempotent upsert shapes. Recognized headers are matched case/space/underscore-insensitively;
// every OTHER column lands in attributes under its original name (nothing is dropped). Semantic
// columns Intercom exports (unsubscribed, last seen, avatar) map onto real contact columns; the
// free-text company name is later resolved to a company_id link by the import route.

export function parseCsv(text: string): string[][] {
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
    if (ch === ",") { pushField(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) pushRow();
  // Drop fully-empty trailing rows (a final newline is normal).
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, "");
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
): { rows: ContactInputShape[]; skipped: number } | { error: string } {
  const grid = parseCsv(text);
  if (grid.length < 2) return { error: "need a header row plus at least one data row" };
  const headers = grid[0].map(normalizeHeader);
  if (!headers.some((h) => h === "email" || h === "externalid" || h === "id" || h === "userid")) {
    return { error: "header row must include an 'email' or 'external_id' / 'user id' column" };
  }
  const rows: ContactInputShape[] = [];
  let skipped = 0;
  for (const cells of grid.slice(1)) {
    const contact: ContactInputShape = {};
    const attributes: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const value = (cells[c] ?? "").trim();
      if (!value) continue;
      const h = headers[c];
      if (h === "email") {
        if (EMAIL_RE.test(value)) contact.email = value.toLowerCase();
      } else if (h === "name" || h === "fullname") {
        contact.name = value.slice(0, 200);
      } else if (h === "externalid" || h === "id" || h === "userid") {
        // Intercom's "User ID" is the stable external identity — the upsert key + verification handle.
        contact.external_id = value.slice(0, 200);
      } else if (h === "company" || h === "companyname" || h === "companies") {
        contact.company = value.slice(0, 200);
      } else if (h === "avatar" || h === "avatarurl" || h === "avatarimageurl") {
        contact.avatar_url = value.slice(0, 2048);
      } else if (h === "unsubscribedfromemails" || h === "unsubscribed" || h === "emailunsubscribed") {
        const at = unsubscribedAt(value);
        if (at) contact.unsubscribed_at = at;
      } else if (h === "lastseen" || h === "lastseenat" || h === "lastrequestat" || h === "lastheardfrom") {
        const at = parseMaybeDate(value);
        if (at) contact.last_seen_at = at;
      } else {
        // Unknown columns become free-form attributes under the original-ish key.
        attributes[grid[0][c].trim().slice(0, 60) || h] = value.slice(0, 500);
      }
    }
    if (Object.keys(attributes).length) contact.attributes = attributes;
    if (!contact.email && !contact.external_id) { skipped++; continue; }
    rows.push(contact);
    if (rows.length >= 10_000) break; // hard row ceiling per import
  }
  return { rows, skipped };
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
    let domain: string | undefined;
    let plan: string | undefined;
    const attributes: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const value = (cells[c] ?? "").trim();
      if (!value) continue;
      const h = headers[c];
      if (h === "name" || h === "companyname" || h === "company") {
        if (!name) name = value.slice(0, 300);
      } else if (h === "domain" || h === "website" || h === "companywebsite" || h === "url" || h === "companyurl") {
        if (!domain) domain = value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").slice(0, 300);
      } else if (h === "plan" || h === "companyplan" || h === "planname") {
        plan = value.slice(0, 120);
      } else {
        // company id, size, seats, MRR, industry, created at, … → attributes (nothing dropped).
        attributes[grid[0][c].trim().slice(0, 60) || h] = value.slice(0, 500);
      }
    }
    if (!name) { skipped++; continue; } // a company with no name can't be keyed
    const row: CompanyImportRow = { name };
    if (domain) row.domain = domain;
    if (plan) row.plan = plan;
    if (Object.keys(attributes).length) row.attributes = attributes;
    rows.push(row);
    if (rows.length >= 10_000) break;
  }
  return { rows, skipped };
}
