// Merge tags — the dynamic-content half of the block composer. Authors write
// {{name}}, {{firstName}}, {{email}}, {{company}}, or {{attr:plan}} anywhere in a text
// block, button label/url, or the subject, with an optional fallback after a pipe:
// {{firstName|there}}. Substitution happens PER RECIPIENT at send time, against the
// recipient's contact row. Two variants share one walk: `text` inserts raw values,
// `html` HTML-escapes them (values land inside rendered markup).

export interface MergeData {
  name?: string | null;
  email?: string | null;
  company?: string | null;
  attributes?: Record<string, unknown> | null;
}

const TAG = /\{\{\s*([a-zA-Z]+(?::[^}|]+?)?)\s*(?:\|([^}]*))?\}\}/g;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function valueFor(key: string, d: MergeData): string | null {
  const k = key.trim();
  if (k === "name") return d.name?.trim() || null;
  if (k === "firstName") {
    const first = d.name?.trim().split(/\s+/)[0];
    return first || null;
  }
  if (k === "email") return d.email?.trim() || null;
  if (k === "company") return d.company?.trim() || null;
  if (k.startsWith("attr:")) {
    const v = d.attributes?.[k.slice(5).trim()];
    return v === undefined || v === null || v === "" ? null : String(v);
  }
  return null; // unknown tag → fallback (or empty)
}

/** Substitute merge tags against one recipient. Unknown/empty values use the tag's
 *  fallback, else empty string — a template must never leak `{{...}}` to a customer. */
export function applyMergeTags(s: string, d: MergeData, opts?: { html?: boolean }): string {
  return s.replace(TAG, (_, key: string, fallback: string | undefined) => {
    const v = valueFor(key, d) ?? (fallback ?? "").trim();
    return opts?.html ? escapeHtml(v) : v;
  });
}

/** True when the string carries at least one merge tag — callers use it to decide whether
 *  a per-recipient re-render is needed at all. */
export function hasMergeTags(s: string): boolean {
  TAG.lastIndex = 0;
  return TAG.test(s);
}

/** The designer/preview stand-in recipient, so previews show real-looking content. */
export const SAMPLE_MERGE_DATA: MergeData = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  company: "Analytical Engines Ltd",
  attributes: { plan: "pro" },
};
