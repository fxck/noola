// Gap review of a closed conversation: the model lists its reusable questions, and the sources are searched for each.
// A second call decides whether the docs or the help articles miss the answer.

export type ConversationKind = "questions" | "account_issue" | "feedback" | "no_question";
export type GapKind = "answered" | "docs_missing" | "docs_unclear" | "support_knowledge" | "not_reusable";

export interface ReviewTurn {
  who: "customer" | "human" | "ai" | "support" | "note";
  body: string;
}

export interface FoundQuestion {
  question: string;
  search: string;
}

export interface QuestionList {
  conversation: ConversationKind;
  questions: FoundQuestion[];
}

export interface ReviewSource {
  kind: "document" | "kb";
  id: string;
  title: string;
  url: string | null;
  text: string;
}

export interface GapReview {
  question: string;
  kind: GapKind;
  answer: string | null;
  page: string | null;
  article: string | null;
  suggestion: string | null;
  title: string | null;
  collection: string | null;
}

export const TRANSCRIPT_MAX = 16000;
const SOURCE_TEXT_MAX = 700;
const MAX_QUESTIONS = 5;

const WHO: Record<ReviewTurn["who"], string> = {
  customer: "Customer",
  human: "Human agent",
  ai: "AI agent",
  support: "Support",
  note: "Internal note",
};

const CONVERSATION_KINDS: ConversationKind[] = ["questions", "account_issue", "feedback", "no_question"];
const GAP_KINDS: GapKind[] = ["answered", "docs_missing", "docs_unclear", "support_knowledge", "not_reusable"];

/** The conversation as the model reads it, cut at TRANSCRIPT_MAX characters. */
export function transcriptOf(channel: string, subject: string, turns: ReviewTurn[]): string {
  const lines = turns.filter((t) => t.body.trim()).map((t) => `[${WHO[t.who]}] ${t.body.trim()}`);
  const head = `Channel: ${channel}${subject.trim() ? `\nSubject: ${subject.trim()}` : ""}\n\n`;
  return (head + lines.join("\n\n")).slice(0, TRANSCRIPT_MAX);
}

function about(company: string, product?: string): string {
  return `You review closed support conversations of ${company}.${product?.trim() ? `\nAbout the product: ${product.trim()}` : ""}`;
}

/** The system prompt of the first call, which lists the reusable questions of a conversation. */
export function questionsPrompt(input: { company: string; product?: string; language: string }): string {
  return [
    about(input.company, input.product),
    "",
    "List the questions in the conversation that documentation or a help article could answer for other customers too.",
    "- Take only what the customer asked or clearly needed. A topic that the team mentioned in passing is not a question.",
    "- List each question once, even when the customer asked it several times.",
    "- Write each question in general terms, the way another customer could ask it. Leave out names, project and service ids, domains and other details of this account.",
    `- Write the questions in ${input.language}, whatever language the conversation uses.`,
    "- Keep a question behind a specific case when it is reusable. \"My backup failed\" can stand for \"Why can a database backup fail and how do I fix it?\".",
    "- Processes and policies count too, such as how to delete an account or how credits work.",
    "- Leave out greetings, thanks, and requests that only the team can act on for this one account, such as fixing an outage or refunding an invoice.",
    `- List at most ${MAX_QUESTIONS} questions. An empty list is a normal answer.`,
    "",
    "Also say what the conversation is mostly about:",
    "- questions: the customer asks how something works or how to do something.",
    "- account_issue: a problem with this customer's account, project, billing or an outage that the team had to handle.",
    "- feedback: a feature request, a complaint or other feedback.",
    "- no_question: nothing to answer, such as a greeting, a test or a closed loop.",
    "",
    'Reply with only JSON: {"conversation": "questions" | "account_issue" | "feedback" | "no_question", "questions": [{"question": "...", "search": "..."}]}.',
    '"search" is a short English search query for the documentation.',
  ].join("\n");
}

/** The system prompt of the second call, which decides what each question needs. */
export function reviewPrompt(input: { company: string; product?: string; language: string }): string {
  return [
    about(input.company, input.product),
    "",
    "For each question you get the conversation it came from and the documentation passages and help articles that search found for it.",
    "Decide what the question needs, from what the conversation shows and what the sources say:",
    "- answered: a source already answers it clearly, and the team's answer agrees with it. The customer could have found it.",
    "  When the team had to correct the source or give a workaround, it is not answered.",
    "- docs_unclear: a documentation page covers the topic but misses the detail that was needed, or says something that the team's answer contradicts.",
    "- docs_missing: no source covers it, and it is about how the product works, so it belongs in the documentation.",
    "  A bug whose cause the team never found is not a documentation gap. Use not_reusable unless a workaround for it is reusable.",
    "  A one-off platform bug that is already fixed is not_reusable too.",
    "- support_knowledge: the answer is about the team's processes, policies, billing, account operations or a workaround for a known bug, so it belongs in a help article.",
    "- not_reusable: on a closer look nothing in it helps other customers.",
    "",
    "For each question also give:",
    "- answer: what the team answered, in one to three sentences. Null when nobody answered it.",
    "- page: the URL of the documentation page to change, or of the closest related page. Null when no page relates.",
    "- article: the id of the help article that answers it or needs the change. Null when none does.",
    "- suggestion: for docs_unclear and docs_missing, what to add or change on the page, concretely, based on the team's answer.",
    "  For docs_missing, also say whether it belongs on that page or on a new page next to it, and give a new page its title.",
    "  For support_knowledge, what the article should say. Null for the other kinds.",
    "  Use only facts that the team confirmed in the conversation or that a source states.",
    "  A customer's guess, a cause that nobody confirmed, or an internal note that speculates (\"probably\", \"maybe\") is not a fact.",
    "  When a fact is missing, write it as an open question for the team, such as \"Confirm whether the limit applies to every plan.\"",
    "  Add no steps, limits or policies that the conversation does not state, and never turn one customer's case into a general rule.",
    "- title and collection: for support_knowledge, a title for the article and the collection it fits.",
    "  Collections group articles by topic, such as Billing or Accounts. Use a listed collection when its topic fits.",
    "  When only a catch-all such as FAQ fits, name a short new topic collection instead. Null for the other kinds.",
    `Write every text in ${input.language}. Base it only on the conversation and the sources, and never invent product facts.`,
    "",
    'Reply with only JSON: {"reviews": [{"question": "...", "kind": "...", "answer": "...", "page": "...", "article": "...", "suggestion": "...", "title": "...", "collection": "..."}]}, one review per question, in order.',
  ].join("\n");
}

function sourceText(s: ReviewSource): string {
  const label = s.kind === "kb" ? `[article ${s.id}] ${s.title}` : `[docs] ${s.title}${s.url ? ` - ${s.url}` : ""}`;
  return `${label}\n${s.text.trim().slice(0, SOURCE_TEXT_MAX)}`;
}

/** The user message of the second call. */
export function reviewInput(
  transcript: string,
  questions: Array<{ question: string; sources: ReviewSource[] }>,
  collections: string[],
): string {
  const parts = [`<conversation>\n${transcript}\n</conversation>`];
  questions.forEach((q, i) => {
    const found = q.sources.length ? q.sources.map(sourceText).join("\n\n") : "(search found nothing)";
    parts.push(`<question ${i + 1}>\n${q.question}\n\nSources:\n${found}\n</question ${i + 1}>`);
  });
  parts.push(`Collections: ${collections.length ? collections.join(", ") : "(none yet)"}`);
  return parts.join("\n\n");
}

function jsonObject(raw: string): Record<string, unknown> | null {
  const s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
// The model writes the page and the article, so only a web address and a real id are kept.
const articleId = (v: unknown): string | null => {
  const s = text(v, 100);
  return s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
};
const webAddress = (v: unknown): string | null => {
  const s = text(v, 1000);
  return s && /^https?:\/\/\S+$/i.test(s) ? s : null;
};

export function parseQuestions(raw: string): QuestionList | null {
  const o = jsonObject(raw);
  if (!o || !CONVERSATION_KINDS.includes(o.conversation as ConversationKind) || !Array.isArray(o.questions)) return null;
  const questions = o.questions.flatMap((q) => {
    const r = q as Record<string, unknown>;
    const question = text(r?.question, 500);
    return question ? [{ question, search: text(r.search, 300) ?? question }] : [];
  });
  return { conversation: o.conversation as ConversationKind, questions: questions.slice(0, MAX_QUESTIONS) };
}

/** The reviews in a reply, one per question. An entry without a question or a known kind is dropped. */
export function parseReviews(raw: string): GapReview[] | null {
  const o = jsonObject(raw);
  if (!o || !Array.isArray(o.reviews)) return null;
  const reviews: GapReview[] = [];
  for (const item of o.reviews) {
    const r = (item ?? {}) as Record<string, unknown>;
    const question = text(r.question, 500);
    if (!question || !GAP_KINDS.includes(r.kind as GapKind)) continue;
    reviews.push({
      question,
      kind: r.kind as GapKind,
      answer: text(r.answer, 1000),
      page: webAddress(r.page),
      article: articleId(r.article),
      suggestion: text(r.suggestion, 4000),
      title: text(r.title, 300),
      collection: text(r.collection, 100),
    });
  }
  return reviews;
}

export interface OpenGap {
  id: string;
  question: string;
}

/** The system prompt that decides whether a new gap repeats an open one. */
export function matchPrompt(): string {
  return [
    "You keep the list of knowledge gaps of a support team: questions that the documentation or the help articles do not answer well.",
    "Decide whether a new question asks the same thing as one of the listed gaps, so that one page change or one article would answer both.",
    "- A different product, service, setting or step makes a different gap, even when the words are close.",
    "- A broader and a narrower question are the same gap when the narrower one is fully part of the broader one.",
    'Reply with only JSON: {"match": "<id of the gap>"} or {"match": null}.',
  ].join("\n");
}

export function matchInput(question: string, gaps: OpenGap[]): string {
  return `<gaps>\n${gaps.map((g) => `${g.id}: ${g.question}`).join("\n")}\n</gaps>\n\n<new question>\n${question}\n</new question>`;
}

/** The id of the gap that the reply names, null when none matches, undefined when the reply makes no sense. */
export function parseMatch(raw: string, ids: Set<string>): string | null | undefined {
  const o = jsonObject(raw);
  if (!o || !("match" in o)) return undefined;
  if (o.match === null) return null;
  return typeof o.match === "string" && ids.has(o.match.trim()) ? o.match.trim() : undefined;
}
