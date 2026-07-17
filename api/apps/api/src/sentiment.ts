import { withTenant } from "@repo/db";

// Per-ticket customer sentiment. A deterministic keyword-lexicon classifier runs on each inbound
// customer message and stamps the ticket — always-on, free, air-gap-safe (a hosted model is the
// documented upgrade). Feeds a rail badge + an analytics tile so agents can spot unhappy customers.

export type Sentiment = "positive" | "neutral" | "negative";

// Small, high-signal lexicons. Kept deliberately short — common support-tone words, not a full
// affective dictionary. Negative is weighted a touch higher (an angry customer needs surfacing
// even amid polite filler like "thanks").
const NEGATIVE = [
  "angry", "furious", "frustrat", "terrible", "awful", "horrible", "unacceptable", "worst",
  "useless", "broken", "refund", "cancel", "disappoint", "ridiculous", "scam", "hate", "annoy",
  "upset", "poor", "wrong", "fail", "stupid", "sucks", "complaint", "outrage", "never works",
];
const POSITIVE = [
  "thank", "thanks", "great", "awesome", "excellent", "perfect", "love", "appreciate", "wonderful",
  "fantastic", "helpful", "amazing", "glad", "happy", "brilliant", "resolved", "works now", "kudos",
];

/** Classify a blob of customer text into positive / neutral / negative via lexicon scoring. */
export function classifySentiment(text: string): Sentiment {
  const t = (text ?? "").toLowerCase();
  let score = 0;
  for (const w of NEGATIVE) if (t.includes(w)) score -= 1.3;
  for (const w of POSITIVE) if (t.includes(w)) score += 1;
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
