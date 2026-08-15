import { withTenant } from "@repo/db";

// Per-ticket customer sentiment. A deterministic keyword-lexicon classifier runs on each inbound
// customer message and stamps the ticket — always-on, free, air-gap-safe (a hosted model is the
// documented upgrade). Feeds a rail badge + an analytics tile so agents can spot unhappy customers.

export type Sentiment = "positive" | "neutral" | "negative";

// Small, high-signal lexicons. Kept deliberately short — common support-tone words, not a full
// affective dictionary. Negative is weighted a touch higher (an angry customer needs surfacing
// even amid polite filler like "thanks").
//
// Matching is WHOLE-WORD (word-boundary), not substring. Entries ending in "*" match a word
// PREFIX/stem ("frustrat*" → frustrated / frustrating); every other entry matches only as a whole
// word. This is what stops the classic false-negatives: "fail" no longer fires on "failover" and
// "cancel" no longer fires on "cancellation" — incidental technical/pricing terms in an otherwise
// polite inquiry used to flip the whole ticket to negative on a single substring hit.
const NEGATIVE = [
  "angry", "furious", "frustrat*", "terrible", "awful", "horrible", "unacceptable", "worst",
  "useless", "broken", "refund", "cancel", "disappoint*", "ridiculous", "scam", "hate", "annoy*",
  "upset", "poor", "wrong", "fail", "stupid", "sucks", "complaint", "outrage*", "never works",
];
const POSITIVE = [
  "thank*", "great", "awesome", "excellent", "perfect", "love", "appreciat*", "wonderful",
  "fantastic", "helpful", "amazing", "glad", "happy", "brilliant", "resolved", "works now", "kudos",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a lexicon entry to a matcher: "stem*" → word-prefix match; otherwise whole-word/phrase.
 *  `\b` is ASCII-word-boundary, which is exactly what we want — an English term embedded inside a
 *  longer token (failover, cancellation) has a word char adjacent, so it does NOT match. */
function toMatcher(term: string): RegExp {
  const isStem = term.endsWith("*");
  const core = escapeRegExp(isStem ? term.slice(0, -1) : term);
  return new RegExp(isStem ? `\\b${core}` : `\\b${core}\\b`, "i");
}

const NEGATIVE_RE = NEGATIVE.map(toMatcher);
const POSITIVE_RE = POSITIVE.map(toMatcher);

/** Classify a blob of customer text into positive / neutral / negative via lexicon scoring. */
export function classifySentiment(text: string): Sentiment {
  const t = text ?? "";
  let score = 0;
  for (const re of NEGATIVE_RE) if (re.test(t)) score -= 1.3;
  for (const re of POSITIVE_RE) if (re.test(t)) score += 1;
  if (score <= -1) return "negative";
  if (score >= 1) return "positive";
  return "neutral";
}

/** Classify `text` and stamp the ticket's sentiment (best-effort; never throws into the caller). */
export async function updateTicketSentiment(tenantId: string, ticketId: string, text: string): Promise<void> {
  try {
    const sentiment = classifySentiment(text);
    await withTenant(tenantId, (c) =>
      c.query("UPDATE tickets SET sentiment = $1 WHERE id = $2", [sentiment, ticketId]),
    );
  } catch {
    /* sentiment is advisory — a failure must never affect ingest */
  }
}
