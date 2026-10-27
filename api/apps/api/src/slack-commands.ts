// Slack Phase — on-demand slash commands (/ask + /draft), the Slack twin of discord-commands.ts.
// The DOMAIN layer, tested without a live Slack app: it resolves the workspace's tenant + the
// channel's ticket, runs retrieval, and (for /ask) delegates the safety gates + claim + throttle to
// the SAME channel-agnostic answerOnDemand core Discord uses. The routes in settings.ts own the Slack
// transport (signature verify, urlencoded parse, 3s ack, response_url delivery, Block Kit buttons).
// Kept in its own module so it can import both autoreply.ts and slack.ts without an import cycle.
import { withTenant } from "@repo/db";
import { ingestInbound } from "./ingest.js";
import { answerOnDemand } from "./autoreply.js";
import { suggestForQuery } from "./copilot.js";
import { resolveTenantByTeam, routeSlackOutbound } from "./slack.js";
import { emitDomainEvent } from "./automations.js";

/** Slack ticket external id: `${team_id}:${channel_id}` (matches the Slack ingest seam). */
const ext = (teamId: string, channelId: string): string => `${teamId}:${channelId}`;

/** The latest OPEN ticket for a Slack channel. Slack tickets key on the channel (not a thread like
 *  Discord), so /draft answers the channel's current conversation. Null when none is open. */
async function resolveChannelTicket(tenantId: string, external: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT id FROM tickets WHERE channel_type = 'slack' AND external_channel_id = $1 AND status <> 'closed' ORDER BY updated_at DESC LIMIT 1",
      [external],
    );
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
}

export interface SlackAskInput {
  teamId: string;
  channelId: string;
  userId: string | null;
  text: string;
  /** Slack's per-invocation trigger_id — a stable idempotency anchor for the synthetic question. */
  triggerId: string;
}
export interface SlackAskResult {
  status: "answered" | "held" | "not_connected" | "empty";
  text: string | null;
  /** Whether to render the answer in-channel (true) or ephemerally to the asker (false). */
  isPublic: boolean;
}

/**
 * Public /ask on Slack: answer a customer question from the KB in-channel. Ingests the question as an
 * inbound Slack message (skipAutoreply so the ambient engine can't double-answer), fires the
 * slack_slash automation trigger, then hands the answer decision to answerOnDemand (safety gates +
 * KB-only + on_demand claim + hourly cap — all shared with Discord). A held answer is ALWAYS private.
 */
export async function handleSlackAskCommand(input: SlackAskInput): Promise<SlackAskResult> {
  const tenantId = await resolveTenantByTeam(input.teamId);
  if (!tenantId) return { status: "not_connected", text: null, isPublic: false };
  const query = (input.text ?? "").trim();
  if (!query) return { status: "empty", text: null, isPublic: false };

  const external = ext(input.teamId, input.channelId);
  const ingested = await ingestInbound({
    tenantId, body: query, authorType: "customer",
    idempotencyKey: `slack-ask:${input.triggerId}`,
    channelType: "slack", externalChannelId: external,
    identity: { externalId: input.userId ?? null },
    skipAutoreply: true,
  });

  emitDomainEvent(tenantId, "slack_slash", { ticketId: ingested.ticketId });

  const res = await answerOnDemand({
    tenantId, ticketId: ingested.ticketId, messageId: ingested.messageId,
    query, invokedByExternalId: input.userId ?? null,
  });
  if (res.outcome === "answered" && res.text) return { status: "answered", text: res.text, isPublic: true };
  return { status: "held", text: heldNotice(res.reason), isPublic: false };
}

/** A user-facing notice for a held /ask, by reason. Never echoes the question or the guardrail tags. */
export function heldNotice(reason: string): string {
  if (reason.startsWith("guardrail")) return "I can't answer that one automatically — a teammate will follow up.";
  if (reason === "ondemand_rate_limited") return "The assistant is at its limit for now — please try again shortly.";
  if (reason === "ondemand_disabled") return "On-demand answers are turned off for this workspace.";
  if (reason === "kill") return "The assistant is paused right now — a teammate will follow up.";
  return "A teammate will follow up on this.";
}

export interface SlackDraftInput {
  teamId: string;
  channelId: string;
  text: string;
}
export interface SlackDraftResult {
  status: "drafted" | "no_ticket" | "not_connected" | "empty";
  text: string | null;
  ticketId: string | null;
}

/**
 * Staff /draft on Slack: a private, agent-audience draft the teammate reviews before Post. Resolves
 * the channel's open ticket and runs FULL retrieval. Ingests NOTHING (a staff question is not a
 * customer turn); only Post (slackPostDraft) ingests the answer as an agent reply.
 */
export async function handleSlackDraftCommand(input: SlackDraftInput): Promise<SlackDraftResult> {
  const tenantId = await resolveTenantByTeam(input.teamId);
  if (!tenantId) return { status: "not_connected", text: null, ticketId: null };
  const query = (input.text ?? "").trim();
  if (!query) return { status: "empty", text: null, ticketId: null };
  const ticketId = await resolveChannelTicket(tenantId, ext(input.teamId, input.channelId));
  if (!ticketId) return { status: "no_ticket", text: null, ticketId: null };
  const suggestion = await suggestForQuery(tenantId, query, { ticketId, audience: "agent" });
  return { status: "drafted", text: suggestion.draft, ticketId };
}

export interface SlackPostDraftInput {
  teamId: string;
  channelId: string;
  ticketId: string;
  text: string;
  /** Idempotency anchor (the draft token) so a double Post ingests + sends once. */
  postId: string;
}

/** Post a reviewed /draft: record it as an agent reply on the ticket, then dispatch to the channel
 *  via the Slack bot token. Idempotent on postId. */
export async function slackPostDraft(input: SlackPostDraftInput): Promise<{ delivered: boolean }> {
  const tenantId = await resolveTenantByTeam(input.teamId);
  if (!tenantId) return { delivered: false };
  const ingested = await ingestInbound({
    tenantId, body: input.text, authorType: "agent", ticketId: input.ticketId,
    idempotencyKey: `slack-postdraft:${input.postId}`,
    channelType: "slack", externalChannelId: ext(input.teamId, input.channelId),
  });
  if (ingested.replay) return { delivered: false };
  const r = await routeSlackOutbound(
    { tenantId, channelType: "slack", externalChannelId: ext(input.teamId, input.channelId) },
    input.text,
  );
  return { delivered: r.delivered };
}

// ── /draft → Post relay store (transport-side, process-local) ─────────────────
// The full draft text keyed by a short token, so the Block Kit "Post to channel" button can recover
// it (Slack button `value` is capped ~2000 and shouldn't carry the whole draft). Bounded (evict
// oldest past 500). Single-replica dev/stage — fine; a multi-replica prod would move this to a store.
const draftStore = new Map<string, { teamId: string; channelId: string; ticketId: string; text: string }>();

/** Stash a draft, returning its lookup token (used as the Block Kit button value). */
export function stashSlackDraft(v: { teamId: string; channelId: string; ticketId: string; text: string }): string {
  // A deterministic-enough token without Date.now()/Math.random(): ticket + a rolling counter.
  const token = `${v.ticketId}.${draftCounter++}`;
  draftStore.set(token, v);
  if (draftStore.size > 500) {
    const oldest = draftStore.keys().next().value;
    if (oldest) draftStore.delete(oldest);
  }
  return token;
}
let draftCounter = 0;
export function getSlackDraft(token: string): { teamId: string; channelId: string; ticketId: string; text: string } | undefined {
  return draftStore.get(token);
}
export function deleteSlackDraft(token: string): void {
  draftStore.delete(token);
}
