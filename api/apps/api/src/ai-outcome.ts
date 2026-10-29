/**
 * What an AI draft asks for. A hosted model may wrap a note for the team in `<internal>…</internal>`, may answer
 * `<no_reply/>` when the customer's message needs no answer, and may add `<handoff/>` to hand the conversation to a teammate.
 * Anything that is not exactly one of the allowed shapes is malformed, and a malformed draft is held for review, never sent.
 */
export type DraftOutcome =
  | { kind: "ok"; reply: string; note: string | null; noReply: boolean; handoff: boolean }
  | { kind: "malformed"; problem: string };

const INTERNAL_BLOCK = /<internal>([\s\S]*?)<\/internal>/g;
const NO_REPLY = /<no_reply\s*\/>/g;
const HANDOFF = /<handoff\s*\/>/g;
// Any leftover piece of a tag means the model wrote it wrong.
const TAG_FRAGMENT = /<\s*\/?\s*(internal|no_reply|handoff)\b|\b(internal|no_reply|handoff)\s*\/?\s*>/i;

/** True when the text holds any piece of an outcome tag. */
export function hasOutcomeTag(text: string): boolean {
  return TAG_FRAGMENT.test(text);
}

/** The text with the note block and the no-reply and handoff tags taken out, untrimmed so it still starts like the original. */
export function withoutOutcomeTags(text: string): string {
  return text.replace(INTERNAL_BLOCK, "").replace(NO_REPLY, "").replace(HANDOFF, "");
}

export function parseDraftOutcome(text: string): DraftOutcome {
  const notes = [...text.matchAll(INTERNAL_BLOCK)].map((m) => m[1].trim());
  if (notes.length > 1) return { kind: "malformed", problem: "more than one internal note" };
  if (notes.length === 1 && !notes[0]) return { kind: "malformed", problem: "empty internal note" };
  const noReplies = text.match(NO_REPLY)?.length ?? 0;
  if (noReplies > 1) return { kind: "malformed", problem: "more than one no_reply" };
  const handoffs = text.match(HANDOFF)?.length ?? 0;
  if (handoffs > 1) return { kind: "malformed", problem: "more than one handoff" };

  const rest = withoutOutcomeTags(text);
  if (TAG_FRAGMENT.test(rest)) return { kind: "malformed", problem: "a broken or nested tag" };
  // A note may contain neither tag, since nesting is how a note would leak into the reply.
  if (notes.some((n) => TAG_FRAGMENT.test(n))) return { kind: "malformed", problem: "a tag inside the internal note" };

  const reply = rest.trim();
  const noReply = noReplies === 1;
  const handoff = handoffs === 1;
  if (noReply && reply) return { kind: "malformed", problem: "no_reply together with a reply" };
  if (noReply && handoff) return { kind: "malformed", problem: "no_reply together with a handoff" };
  if (reply && !/[\p{L}\p{N}]/u.test(reply)) return { kind: "malformed", problem: "a reply without words" };
  if (!reply && !noReply && !handoff && !notes.length) return { kind: "malformed", problem: "an empty draft" };
  return { kind: "ok", reply, note: notes[0] ?? null, noReply, handoff };
}

/** The instruction a hosted model gets alongside the reply rules when it may use the tags above. */
export const DRAFT_OUTCOMES_SYSTEM = [
  "Besides replying, you can leave a note for the support team, which the customer never sees, " +
    "you can hand the conversation to a teammate, and you can decide that a message needs no reply.",
  "Your answer must take exactly one of these six forms:",
  "1. A reply to the customer.",
  "2. A reply, then <internal>a note for the team</internal>. Use this when you can answer but the team should know something, " +
    "for example that the customer reports a bug.",
  "3. A reply, then <handoff/>, optionally with <internal>a note for the team</internal>, when a teammate should take over after your reply, " +
    "for example because the customer keeps asking for a person or needs something only the team can do. " +
    "The reply is sent, then you stop answering this conversation and a teammate takes over.",
  "4. <no_reply/> on its own, when the customer's latest message needs no answer at all, for example a plain thank-you or a goodbye.",
  "5. <no_reply/> followed by <internal>a note for the team</internal>, when the message needs no answer " +
    "but the team should know something about it. The customer gets nothing and the team gets the note.",
  "6. <internal>a note for the team</internal> on its own, when a teammate should answer instead of you. " +
    "The customer gets no reply from you and a teammate takes over.",
  "If you cannot answer the question, use form 1, 2 or 3 with the reply the rules above ask for, not form 6.",
  "If your reply says that a teammate will take over, use form 3, so that you really stop answering.",
  "Everything outside the tags is sent to the customer exactly as you write it, so never add remarks about your own reply, " +
    "for example that you are not replying. To send the customer nothing, use form 4 or 5.",
  "Use each tag at most once, never use them in any other way, and never mention them to the customer.",
].join("\n");

/** Added when retrieval found nothing, so the model can still skip a thank-you or ask what the customer needs. */
export const NO_SOURCES_SYSTEM = [
  "You have no sources for this message, so state nothing about the product, its features, prices or policies.",
  "If the message needs no answer, such as a thank-you or a goodbye, use form 4.",
  "If you can't tell what the customer needs, ask one short question to find out.",
  "Otherwise say plainly that you don't have that information, in the customer's language, and hand off with form 3.",
].join("\n");
