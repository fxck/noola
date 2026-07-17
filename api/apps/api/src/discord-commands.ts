// Discord Phase 5 — on-demand slash commands (/ask + /draft). The DOMAIN layer, tested without a
// live gateway: it resolves the tenant + thread-ticket, runs retrieval, and (for /ask) delegates the
// safety gates + claim + throttle to answerOnDemand. discord-gateway.ts is the thin transport that
// turns a discord.js interaction into these calls and renders the result. Kept in its own module so
// it can import both autoreply.ts and discord.ts without forming an import cycle through discord.ts.
import { relayPool, withTenant } from "@repo/db";
import { ingestInbound } from "./ingest.js";
import { answerOnDemand } from "./autoreply.js";
import { suggestForQuery } from "./copilot.js";
import { resolveTenant, routeOutbound, getSender, handleInboundMessage } from "./discord.js";
import { emitDomainEvent } from "./automations.js";

/** discord_links.ondemand_public — /ask answers in-channel (true) or ephemerally to the asker (false).
 *  discord_links is outside RLS (like resolveTenant), so this reads via relayPool. Default true. */
async function ondemandPublic(guildId: string): Promise<boolean> {
  const r = await relayPool.query("SELECT ondemand_public FROM discord_links WHERE guild_id = $1", [guildId]);
  return r.rowCount ? (r.rows[0].ondemand_public as boolean) : true;
}

/** The ticket for a Discord thread (thread = ticket, §5.7). Null when the thread has no ticket yet
 *  (e.g. /draft in a thread the bot never ingested). RLS-scoped read. */
async function resolveThreadTicket(tenantId: string, threadId: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT id FROM tickets WHERE channel_type = 'discord' AND external_thread_id = $1 ORDER BY created_at DESC LIMIT 1",
      [threadId],
    );
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
}

export interface AskCommandInput {
  guildId: string;
  /** The channel the command ran in — for a thread this IS the thread id. */
  channelId: string;
  parentId: string | null;
  threadKind: "text_thread" | "forum_post" | "channel";
  threadName: string | null;
  invokerId: string;
  invokerDisplayName: string | null;
  invokerAvatarUrl: string | null;
  invokerRoleIds: string[];
  query: string;
  /** The interaction id — a stable idempotency anchor for the synthetic question message. */
  interactionId: string;
}
export interface AskCommandResult {
  status: "answered" | "held" | "not_connected" | "empty";
  /** The answer to render (answered), a private held-notice (held), or null. */
  text: string | null;
  /** Whether to render the answer publicly in-channel (only ever true for an actual answer). */
  isPublic: boolean;
}

/**
 * Public /ask: answer a customer's question from the KB, in-channel. Ingests the question as an
 * inbound message (thread=ticket) with skipAutoreply so the ambient engine can't double-answer, then
 * hands the answer decision to answerOnDemand (safety gates + KB-only + on_demand claim + throttle).
 * A held answer (risky / capped / disabled / claimed) is ALWAYS returned privately — a guardrailed
 * question must never be answered in public.
 */
export async function handleAskCommand(input: AskCommandInput): Promise<AskCommandResult> {
  const tenantId = await resolveTenant(input.guildId);
  if (!tenantId) return { status: "not_connected", text: null, isPublic: false };
  const query = input.query.trim();
  if (!query) return { status: "empty", text: null, isPublic: false };

  const ingested = await handleInboundMessage({
    guildId: input.guildId,
    channelId: input.channelId,
    authorId: input.invokerId,
    content: query,
    discordMessageId: `ask:${input.interactionId}`,
    threadId: input.threadKind === "channel" ? null : input.channelId,
    parentId: input.parentId,
    threadKind: input.threadKind,
    authorDisplayName: input.invokerDisplayName,
    authorAvatarUrl: input.invokerAvatarUrl,
    threadName: input.threadName,
    roleIds: input.invokerRoleIds,
    isBotOrWebhook: false,
    skipAutoreply: true,
  });
  if (!ingested) return { status: "not_connected", text: null, isPublic: false }; // unbound/off/top-level

  // Fire the discord_slash automation trigger (fire-and-forget, post-ingest): the on-demand answer
  // below is independent, but this lets a tenant hang Studio logic (tag/notify/route) on an /ask. A
  // reply action would lose the turn's claim to answerOnDemand below, so it can't double-answer.
  emitDomainEvent(tenantId, "discord_slash", { ticketId: ingested.ticketId });

  const res = await answerOnDemand({
    tenantId, ticketId: ingested.ticketId, messageId: ingested.messageId,
    query, invokedByExternalId: input.invokerId,
  });
  if (res.outcome === "answered" && res.text) {
    const isPublic = await ondemandPublic(input.guildId);
    return { status: "answered", text: res.text, isPublic };
  }
  return { status: "held", text: heldNotice(res.reason), isPublic: false };
}

/** A user-facing notice for a held /ask, by reason. Never echoes the question or the guardrail tags. */
function heldNotice(reason: string): string {
  if (reason.startsWith("guardrail")) return "I can't answer that one automatically — a teammate will follow up.";
  if (reason === "ondemand_rate_limited") return "The assistant is at its limit for now — please try again shortly.";
  if (reason === "ondemand_disabled") return "On-demand answers are turned off for this server.";
  if (reason === "kill") return "The assistant is paused right now — a teammate will follow up.";
  return "A teammate will follow up on this.";
}

export interface DraftCommandInput {
  guildId: string;
  channelId: string;
  query: string;
}
export interface DraftCommandResult {
  status: "drafted" | "no_ticket" | "not_connected" | "empty";
  text: string | null;
  ticketId: string | null;
}

/**
 * Staff /draft: a private, agent-audience draft the teammate can review before Post. Resolves the
 * ticket by thread and runs FULL retrieval (audience 'agent'). Ingests NOTHING — a staff question is
 * not a customer turn (§5.3 #3, so it never mints a phantom contact or fires ambient autoreply);
 * only Post (postDraft) ingests the answer as an agent reply.
 */
export async function handleDraftCommand(input: DraftCommandInput): Promise<DraftCommandResult> {
  const tenantId = await resolveTenant(input.guildId);
  if (!tenantId) return { status: "not_connected", text: null, ticketId: null };
  const query = input.query.trim();
  if (!query) return { status: "empty", text: null, ticketId: null };
  const ticketId = await resolveThreadTicket(tenantId, input.channelId);
  if (!ticketId) return { status: "no_ticket", text: null, ticketId: null };
  const suggestion = await suggestForQuery(tenantId, query, { ticketId, audience: "agent" });
  return { status: "drafted", text: suggestion.draft, ticketId };
}

export interface PostDraftInput {
  guildId: string;
  /** The thread to post into (= the ticket's external channel). */
  channelId: string;
  ticketId: string;
  text: string;
  /** Idempotency anchor (the button interaction id) so a double-click posts once. */
  postId: string;
}

/** Post a reviewed /draft: record it as an agent reply on the ticket, then dispatch it to the thread.
 *  Idempotent on postId — a double Post ingests + sends once. */
export async function postDraft(input: PostDraftInput): Promise<{ delivered: boolean }> {
  const tenantId = await resolveTenant(input.guildId);
  if (!tenantId) return { delivered: false };
  const ingested = await ingestInbound({
    tenantId, body: input.text, authorType: "agent", ticketId: input.ticketId,
    idempotencyKey: `ondemand-post:${input.postId}`,
    channelType: "discord", externalChannelId: input.channelId,
  });
  // Replay (same postId already posted) ⇒ don't double-dispatch to Discord.
  if (ingested.replay) return { delivered: false };
  const r = await routeOutbound({ channelType: "discord", externalChannelId: input.channelId }, input.text, getSender());
  return { delivered: r.delivered };
}
