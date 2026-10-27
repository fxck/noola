/**
 * What an AI draft asks for. A hosted model may wrap a note for the team in `<internal>…</internal>`,
 * and may answer `<no_reply/>` when the customer's message needs no answer.
 * Anything that is not exactly one of the allowed shapes is malformed, and a malformed draft is held for review, never sent.
 */
export type DraftOutcome =
  | { kind: "ok"; reply: string; note: string | null; noReply: boolean }
  | { kind: "malformed"; problem: string };

const INTERNAL_BLOCK = /<internal>([\s\S]*?)<\/internal>/g;
const NO_REPLY = /<no_reply\s*\/>/g;
// Any leftover piece of either tag means the model wrote it wrong.
const TAG_FRAGMENT = /<\s*\/?\s*(internal|no_reply)\b|\b(internal|no_reply)\s*\/?\s*>/i;

/** True when the text holds any piece of either tag. */
export function hasOutcomeTag(text: string): boolean {
  return TAG_FRAGMENT.test(text);
}

/** The text with the note block and the no-reply tag taken out, untrimmed so it still starts like the original. */
export function withoutOutcomeTags(text: string): string {
  return text.replace(INTERNAL_BLOCK, "").replace(NO_REPLY, "");
}

export function parseDraftOutcome(text: string): DraftOutcome {
  const notes = [...text.matchAll(INTERNAL_BLOCK)].map((m) => m[1].trim());
  if (notes.length > 1) return { kind: "malformed", problem: "more than one internal note" };
  if (notes.length === 1 && !notes[0]) return { kind: "malformed", problem: "empty internal note" };
  const noReplies = text.match(NO_REPLY)?.length ?? 0;
  if (noReplies > 1) return { kind: "malformed", problem: "more than one no_reply" };

  const rest = text.replace(INTERNAL_BLOCK, "").replace(NO_REPLY, "");
  if (TAG_FRAGMENT.test(rest)) return { kind: "malformed", problem: "a broken or nested tag" };
  // A note may contain neither tag, since nesting is how a note would leak into the reply.
  if (notes.some((n) => TAG_FRAGMENT.test(n))) return { kind: "malformed", problem: "a tag inside the internal note" };

  const reply = rest.trim();
  const noReply = noReplies === 1;
  if (noReply && reply) return { kind: "malformed", problem: "no_reply together with a reply" };
  if (reply && !/[\p{L}\p{N}]/u.test(reply)) return { kind: "malformed", problem: "a reply without words" };
  if (!reply && !noReply && !notes.length) return { kind: "malformed", problem: "an empty draft" };
  return { kind: "ok", reply, note: notes[0] ?? null, noReply };
}

/** The instruction a hosted model gets alongside the reply rules when it may use the tags above. */
export const DRAFT_OUTCOMES_SYSTEM =
  "You may also leave a note for the support team that the customer never sees. Put it in one " +
  "<internal>...</internal> block, either alone or after your reply. Use it for what the team should know or do, " +
  "for example that the customer reports a bug or that you could not find the answer. " +
  "If the customer's latest message needs no answer at all, for example a plain thank-you or a confirmation " +
  "that closes the topic, write <no_reply/> instead of a reply, optionally with an internal note. " +
  "If you cannot answer, still write the reply the rules above ask for, and add the note after it. " +
  "Leave only a note when you want a teammate to answer instead of you. " +
  "Never use these tags in any other way, and never mention them to the customer.";
