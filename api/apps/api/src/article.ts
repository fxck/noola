import { withTenant } from "@repo/db";
import { resolveModelDriver } from "./modelconfig.js";

// Ticket-to-article generation (closes the knowledge-loop): turn a resolved support conversation
// into a reusable KB article draft. The model returns {title, body}; the agent reviews + edits,
// then publishes through the normal KB create path. Degrades to an extractive draft (subject +
// the agent's answer) on the rule baseline so it always returns a usable starting point.

export interface ArticleDraft {
  title: string;
  body: string;
  model: string;
}

interface Msg { author_type: string; body: string }

const SYSTEM_PROMPT =
  "Turn this resolved support conversation into a concise knowledge-base help article. " +
  "Respond with ONLY a JSON object: {\"title\": \"...\", \"body\": \"...\"}. The title is a short, " +
  "searchable question or topic. The body is a clear, self-contained answer in Markdown (steps, " +
  "not a transcript) that would help the next customer with the same issue. No preamble, JSON only.";

/** Best-effort JSON extraction from a model completion (handles code fences / stray prose). */
function parseDraft(raw: string): { title: string; body: string } | null {
  const s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as { title?: unknown; body?: unknown };
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const body = typeof obj.body === "string" ? obj.body.trim() : "";
    if (!title && !body) return null;
    return { title: title.slice(0, 300), body: body.slice(0, 100000) };
  } catch {
    return null;
  }
}

function extractiveDraft(subject: string, msgs: Msg[]): { title: string; body: string } {
  const firstCustomer = msgs.find((m) => m.author_type === "customer");
  const lastAgent = [...msgs].reverse().find((m) => m.author_type === "agent");
  const title = (subject || firstCustomer?.body || "Untitled").replace(/\s+/g, " ").trim().slice(0, 300);
  const q = firstCustomer ? `**Question**\n\n${firstCustomer.body.trim()}\n\n` : "";
  const a = lastAgent ? `**Answer**\n\n${lastAgent.body.trim()}` : "_No answer captured in this conversation yet._";
  return { title, body: (q + a).slice(0, 100000) };
}

/** Draft a KB article from a ticket's thread. Returns null when the ticket has no messages. */
export async function draftArticleFromTicket(tenantId: string, ticketId: string): Promise<ArticleDraft | null> {
  const { subject, msgs } = await withTenant(tenantId, async (c) => {
    const t = await c.query("SELECT subject FROM tickets WHERE id = $1", [ticketId]);
    if (!t.rowCount) return { subject: "", msgs: [] as Msg[] };
    const m = await c.query(
      "SELECT author_type, body FROM messages WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 100",
      [ticketId],
    );
    return { subject: (t.rows[0].subject as string) ?? "", msgs: m.rows as Msg[] };
  });
  if (msgs.length === 0) return null;

  const transcript = msgs
    .map((m) => `${m.author_type === "customer" ? "Customer" : "Agent"}: ${m.body}`)
    .join("\n")
    .slice(0, 12000);

  const driver = await resolveModelDriver(tenantId);
  if (typeof driver.complete === "function") {
    try {
      const parsed = parseDraft(await driver.complete(SYSTEM_PROMPT, transcript));
      if (parsed) return { ...parsed, model: driver.name };
    } catch {
      /* fall through to extractive */
    }
  }
  return { ...extractiveDraft(subject, msgs), model: "extractive" };
}
