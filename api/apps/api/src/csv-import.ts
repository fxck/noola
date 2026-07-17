import type { ContactInputShape } from "./contacts.js";

// CSV → contacts import (0092). A small RFC-4180 parser (quoted fields, embedded commas/
// newlines, "" escapes) + a header mapper onto the idempotent upsert shape. Recognized
// headers (case/space/underscore-insensitive): email, name, external id / externalid / id,
// company; every OTHER header lands in attributes under its own name. Rows with neither an
// email nor an external id can't upsert — counted as skipped, never a hard error.

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

export function parseCsvContacts(
  text: string,
): { rows: ContactInputShape[]; skipped: number } | { error: string } {
  const grid = parseCsv(text);
  if (grid.length < 2) return { error: "need a header row plus at least one data row" };
  const headers = grid[0].map(normalizeHeader);
  if (!headers.some((h) => h === "email" || h === "externalid" || h === "id")) {
    return { error: "header row must include an 'email' or 'external_id' column" };
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
      } else if (h === "externalid" || h === "id") {
        contact.external_id = value.slice(0, 200);
      } else if (h === "company") {
        contact.company = value.slice(0, 200);
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
