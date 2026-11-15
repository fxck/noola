import { withTenant } from "@repo/db";
import { resolveModelDriver } from "./modelconfig.js";
import { findSources } from "./copilot.js";
import { getDocsSearchSettings } from "./docs-search.js";
import { getTranslationSettings } from "./translate.js";
import { localeName } from "./locale.js";
import { transcriptOf, type ReviewTurn } from "./gap-review.js";

// A draft that closes a knowledge gap: a help article for support knowledge, or a change to a documentation page.
// The model writes it from the gap's conversations, the sources and the notes of the person who asks.

export interface GapDraft {
  /** The article title, or for a docs change the page and section it belongs on. */
  title: string;
  body: string;
  /** Points the conversations leave open, for the team to settle before publishing. */
  openQuestions: string[];
  model: string;
}

export interface GapDraftInput {
  /** The note for this draft. */
  notes?: string;
  /** The earlier rounds of this drafting, oldest first: what the team wrote and the open questions the model listed back. */
  rounds?: Array<{ notes: string; openQuestions: string[] }>;
  /** The draft to revise with the notes, when there is one. */
  previous?: { title: string; body: string };
}

// The newest conversations of the gap that the draft reads, each cut to its share of the characters.
const DRAFT_CONVERSATIONS = 5;
const CONVERSATION_CHARS = 6000;
const SOURCE_CHARS = 1500;
const DRAFT_MAX_TOKENS = 8000;
const DRAFT_TIMEOUT_MS = 120_000;

/** The system prompt for a draft. Exported for the test. */
export function draftPrompt(input: { company: string; product?: string; language: string; kind: string }): string {
  const docs = input.kind !== "support_knowledge";
  return [
    `You write for the support team of ${input.company}.${input.product?.trim() ? ` About the product: ${input.product.trim()}` : ""}`,
    docs
      ? "Customers asked a question that the documentation misses or gets wrong. Write the change for the documentation page."
      : "Customers asked a question that belongs in a help article. Write the article.",
    "",
    "- Use only facts that the team confirmed in the conversations or the notes, or that a source states. Never invent product facts, limits, steps or policies.",
    "- A customer's guess, a cause that nobody confirmed, or an internal note that speculates is not a fact.",
    "- When something the text needs is not confirmed, leave it out of the text and list it under openQuestions.",
    "- Write for any customer: no names, project or service ids, domains or other details of one account.",
    docs
      ? "- title: the page and the section the change belongs in, or the title of a new page. body: the text to add, in Markdown, ready to paste."
      : "- title: a short, searchable title. body: the article in Markdown, with steps where they help, not a transcript.",
    "- The notes come from the team, so what they state is confirmed. Never list it under openQuestions.",
    "- The drafting so far shows each note and the open questions you listed back. A later note often answers them.",
    "  Use those answers, and never ask an answered question again. When two notes disagree, the later one wins.",
    "- When there is an earlier draft, revise it with the notes instead of starting over.",
    `- Write in ${input.language}.`,
    "",
    'Reply with only JSON: {"title": "...", "body": "...", "openQuestions": ["..."]}.',
  ].join("\n");
}

/** The draft in a model reply, or null when the reply has no title and body. Exported for the test. */
export function parseDraft(raw: string): { title: string; body: string; openQuestions: string[] } | null {
  const s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 300) : "";
    const body = typeof o.body === "string" ? o.body.trim().slice(0, 100000) : "";
    if (!title || !body) return null;
    const openQuestions = Array.isArray(o.openQuestions)
      ? o.openQuestions.filter((q): q is string => typeof q === "string" && q.trim() !== "").map((q) => q.trim().slice(0, 500)).slice(0, 20)
      : [];
    return { title, body, openQuestions };
  } catch {
    return null;
  }
}

/** Draft the article or docs change that closes a gap. Returns null when the gap does not exist. Throws when the model fails. */
export async function draftForGap(tenantId: string, gapId: string, input: GapDraftInput = {}): Promise<GapDraft | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gapId)) return null;
  const gap = await withTenant(tenantId, async (c) => {
    const g = await c.query("SELECT id, question, kind, page_url FROM knowledge_gaps WHERE id = $1", [gapId]);
    if (!g.rowCount) return null;
    const qs = await c.query(
      `SELECT q.ticket_id, q.question, q.answer, q.suggestion, q.title, t.channel_type, t.subject
         FROM knowledge_gap_questions q JOIN tickets t ON t.tenant_id = q.tenant_id AND t.id = q.ticket_id
        WHERE q.gap_id = $1 ORDER BY q.created_at DESC LIMIT ${DRAFT_CONVERSATIONS}`,
      [gapId],
    );
    const turns = new Map<string, ReviewTurn[]>();
    for (const q of qs.rows) {
      const m = await c.query(
        `SELECT CASE WHEN author_type = 'customer' THEN 'customer' WHEN auto THEN 'ai' WHEN author_id IS NOT NULL THEN 'human' ELSE 'support' END AS who,
                body, created_at
           FROM messages WHERE ticket_id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT 'note', body, created_at FROM ticket_notes WHERE ticket_id = $1
         ORDER BY created_at LIMIT 200`,
        [q.ticket_id],
      );
      turns.set(q.ticket_id as string, m.rows.map((r) => ({ who: r.who as ReviewTurn["who"], body: (r.body as string) ?? "" })));
    }
    return { ...g.rows[0], conversations: qs.rows, turns } as {
      id: string; question: string; kind: string; page_url: string | null;
      conversations: Array<{ ticket_id: string; question: string; answer: string | null; suggestion: string | null; title: string | null; channel_type: string; subject: string }>;
      turns: Map<string, ReviewTurn[]>;
    };
  });
  if (!gap) return null;

  const driver = await resolveModelDriver(tenantId, { job: "general" });
  if (!driver.complete) throw new Error("the workspace has no hosted model");
  const [company, docs, translation, sources] = await Promise.all([
    withTenant(tenantId, async (c) => (await c.query("SELECT name FROM tenants WHERE id = current_tenant()")).rows[0]?.name as string | undefined),
    getDocsSearchSettings(tenantId),
    getTranslationSettings(tenantId),
    findSources(tenantId, gap.question, { limit: 12 }).catch(() => []),
  ]);
  const system = draftPrompt({ company: company || "the company", product: docs.product, language: localeName(translation.workspaceLocale), kind: gap.kind });

  const parts = [`<gap>\n${gap.question}\nKind: ${gap.kind}${gap.page_url ? `\nPage: ${gap.page_url}` : ""}\n</gap>`];
  gap.conversations.forEach((q, i) => {
    const transcript = transcriptOf(q.channel_type, q.subject ?? "", gap.turns.get(q.ticket_id) ?? []).slice(0, CONVERSATION_CHARS);
    const review = [`Question: ${q.question}`, q.answer ? `Team's answer: ${q.answer}` : "", q.suggestion ? `Suggestion: ${q.suggestion}` : ""].filter(Boolean).join("\n");
    parts.push(`<conversation ${i + 1}>\n${review}\n\n${transcript}\n</conversation ${i + 1}>`);
  });
  const found = sources.slice(0, 8).map((s) =>
    s.kind === "document"
      ? `[docs] ${s.item.filename ?? "Untitled page"}${s.item.source_key ? ` - ${s.item.source_key}` : ""}\n${s.item.text.slice(0, SOURCE_CHARS)}`
      : s.kind === "kb"
        ? `[article] ${s.item.title}\n${s.item.body.slice(0, SOURCE_CHARS)}`
        : "",
  ).filter(Boolean);
  parts.push(`<sources>\n${found.length ? found.join("\n\n") : "(search found nothing)"}\n</sources>`);
  const rounds = (input.rounds ?? []).map((r, i) => {
    const asked = r.openQuestions.map((q) => q.trim()).filter(Boolean);
    return `Round ${i + 1}\nTeam's notes: ${r.notes.trim() || "(none)"}\nYour open questions:${asked.length ? asked.map((q) => `\n- ${q}`).join("") : " (none)"}`;
  });
  if (rounds.length) parts.push(`<drafting so far>\n${rounds.join("\n\n")}\n</drafting so far>`);
  if (input.previous) parts.push(`<earlier draft>\n# ${input.previous.title}\n\n${input.previous.body}\n</earlier draft>`);
  if (input.notes?.trim()) parts.push(`<notes>\n${input.notes.trim()}\n</notes>`);

  const reply = await driver.complete(system, parts.join("\n\n"), { timeoutMs: DRAFT_TIMEOUT_MS, maxTokens: DRAFT_MAX_TOKENS, rejectTruncated: true });
  const draft = parseDraft(reply);
  if (!draft) throw new Error("no draft in the answer");
  return { ...draft, model: driver.name };
}
