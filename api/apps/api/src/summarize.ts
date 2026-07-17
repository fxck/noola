import { withTenant } from "@repo/db";
import { resolveModelDriver } from "./modelconfig.js";

// Thread auto-summarization: condense a ticket's conversation into an agent-facing wrap-up
// (issue · what's been tried · current status · suggested next step) for handoff / triage. Uses
// the tenant's hosted model when available, and degrades to a deterministic extractive summary on
// the rule baseline (air-gap-safe, no paid call) so the feature always returns something useful.

export interface TicketSummary {
  summary: string;
  model: string;
}

interface Msg { author_type: string; body: string }

const SYSTEM_PROMPT =
  "You are a support assistant. Summarize the conversation below for an agent taking it over. " +
  "Be concise (under 120 words), plain prose, no preamble or headers. Cover: the customer's issue, " +
  "what has already been tried or answered, the current status, and the suggested next step.";

/** Deterministic fallback when no hosted model is configured (rule baseline) or the model errors:
 *  compose a structural summary from the transcript so the feature is never empty. */
function extractiveSummary(msgs: Msg[]): string {
  const firstCustomer = msgs.find((m) => m.author_type === "customer");
  const agentReplies = msgs.filter((m) => m.author_type === "agent").length;
  const customerMsgs = msgs.filter((m) => m.author_type === "customer").length;
  const last = msgs[msgs.length - 1];
  const clip = (s: string, n = 220) => s.replace(/\s+/g, " ").trim().slice(0, n);
  const parts: string[] = [];
  if (firstCustomer) parts.push(`Issue: ${clip(firstCustomer.body)}`);
  parts.push(`${customerMsgs} customer message${customerMsgs === 1 ? "" : "s"}, ${agentReplies} agent repl${agentReplies === 1 ? "y" : "ies"}.`);
  if (last) parts.push(`Latest (${last.author_type === "customer" ? "customer" : "agent"}): ${clip(last.body)}`);
  return parts.join(" ");
}

/** Summarize a ticket's thread. Returns null when the ticket has no messages (not found / empty). */
export async function summarizeTicket(tenantId: string, ticketId: string): Promise<TicketSummary | null> {
  const msgs = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT author_type, body FROM messages WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 100",
      [ticketId],
    );
    return r.rows as Msg[];
  });
  if (msgs.length === 0) return null;

  const transcript = msgs
    .map((m) => `${m.author_type === "customer" ? "Customer" : "Agent"}: ${m.body}`)
    .join("\n")
    .slice(0, 12000);

  const driver = await resolveModelDriver(tenantId);
  if (typeof driver.complete === "function") {
    try {
      const out = await driver.complete(SYSTEM_PROMPT, transcript);
      const text = out.trim();
      if (text) return { summary: text, model: driver.name };
    } catch {
      /* hosted model failed → deterministic fallback below */
    }
  }
  return { summary: extractiveSummary(msgs), model: "extractive" };
}
