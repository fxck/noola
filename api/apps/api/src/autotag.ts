import { resolveModelDriver } from "./modelconfig.js";

// AI auto-tagging (the hosted-model half). The deterministic keyword→tag mapping that used to live
// here as frozen TS (KEYWORD_TAGS / RISK_TO_TAG) is now a per-tenant config table (tag_rules,
// mig 0084) projected into managed `ticket.created` automations by seedflows.projectAutotag — so
// tagging is transparent in Studio + tenant-editable + forkable. This module keeps only the model
// classifier, exposed as the `ai_tag` engine action; DEFAULT_TAG_RULES below seeds a new tenant's
// tag_rules with the built-in vocabulary.

// The suggested vocabulary the hosted model is steered toward. The model may return a close
// variant; we clamp length + count.
const VOCAB = [
  "billing", "bug", "how-to", "feature-request", "account", "refund", "cancellation",
  "security", "complaint", "integration", "outage", "shipping", "sales",
];

const SYSTEM_PROMPT =
  "You label incoming customer-support tickets. Given the subject and message, respond with ONLY a " +
  "JSON array of 1-3 short lowercase topic tags (single words or hyphenated), e.g. " +
  '["billing","refund"]. Prefer these when they fit: ' +
  VOCAB.join(", ") +
  ". No prose, JSON array only.";

function parseTags(raw: string): string[] {
  const s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1)) as unknown[];
    return arr
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
      .filter((t) => t.length >= 2 && t.length <= 24)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** Hosted-model tag suggestion — the AI half only. Returns the model's tags, or `[]` when the
 *  tenant has no generative driver (rule baseline / air-gap) or the call fails. NO deterministic
 *  fallback: the keyword tag rules (projected managed automations) own the always-on baseline, so
 *  a fallback here would just duplicate them. Backs the `ai_tag` engine action. */
export async function suggestTagsAI(tenantId: string, subject: string, body: string): Promise<string[]> {
  const driver = await resolveModelDriver(tenantId);
  if (!driver.complete) return [];
  try {
    const raw = await driver.complete(
      SYSTEM_PROMPT,
      `Subject: ${subject || "(none)"}\n\nMessage:\n${(body ?? "").slice(0, 2000)}`,
    );
    return parseTags(raw);
  } catch {
    return [];
  }
}

// ── Default tag rules — the seed a new tenant's tag_rules is installed with ────────────────────
// Ported from the old KEYWORD_TAGS + RISK_TO_TAG maps: each entry's keywords are matched (substring,
// case-insensitive) against the ticket subject OR body by the projected automation. `contains_any`
// substring matching is intentionally simpler than the old \b-anchored regexes — it's what a tenant
// sees and edits in the settings form.
export interface DefaultTagRule {
  tag: string;
  keywords: string[];
}
export const DEFAULT_TAG_RULES: DefaultTagRule[] = [
  { tag: "billing", keywords: ["invoice", "billing", "charged", "charge", "payment", "subscription", "receipt"] },
  { tag: "refund", keywords: ["refund", "money back", "reimburse", "chargeback"] },
  { tag: "cancellation", keywords: ["cancel", "unsubscribe", "close my account", "close account", "terminate"] },
  { tag: "bug", keywords: ["bug", "error", "broken", "crash", "not working", "doesn't work", "doesnt work", "glitch", "500", "404"] },
  { tag: "how-to", keywords: ["how do", "how can", "how to", "where do", "is it possible", "tutorial", "guide"] },
  { tag: "feature-request", keywords: ["feature request", "would be great", "would be nice", "please add", "suggestion", "could you add"] },
  { tag: "account", keywords: ["login", "log in", "sign in", "password", "reset", "locked out", "2fa", "access"] },
  { tag: "integration", keywords: ["integrat", "webhook", "api", "zapier", "slack", "connect to"] },
  { tag: "shipping", keywords: ["shipping", "delivery", "tracking", "order status", "order number", "package"] },
  { tag: "security", keywords: ["hacked", "breach", "phishing", "vulnerability", "exploit", "leaked", "compromised", "unauthorized"] },
  { tag: "complaint", keywords: ["complaint", "angry", "terrible", "worst", "unacceptable", "escalate", "lawyer", "furious", "disappointed"] },
];
