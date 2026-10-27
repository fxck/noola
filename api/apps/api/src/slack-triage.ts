// Slack triage layer — in-Slack ticket management without leaving Slack (Noola-style, minus Slack
// Connect). One action core (applySlackAction) reused by three surfaces: message-action / card
// buttons (block_actions), the /note command, and emoji reactions. Plus the live status card, a CSAT
// prompt on close, and channel→account binding. All ticket mutations REUSE the existing engine
// (assignTicket/setTicketStatus/snoozeTicket/addNote/recordCsat) so Slack is just another driver.
import { withTenant } from "@repo/db";
import { assignTicket, setTicketStatus, snoozeTicket } from "./tickets.js";
import { addNote } from "./notes.js";
import { recordCsat } from "./csat.js";
import { getReactionMap } from "./classification.js";
import {
  resolveTenantByTeam, postSlackBlocks, updateSlackMessage, resolveSlackUserEmail,
} from "./slack.js";

const ext = (teamId: string, channelId: string): string => `${teamId}:${channelId}`;

/** The channel's most recent ticket, ANY status — triage acts on the current conversation, and
 *  `reopen` must be able to find the ticket it just closed (an open-only filter would hide it). */
async function channelTicket(tenantId: string, external: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT id FROM tickets WHERE channel_type = 'slack' AND external_channel_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [external],
    );
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
}

/** Map a Slack actor to a Noola agent by shared email (users.info → users.email). Best-effort. */
async function resolveAgentByEmail(tenantId: string, teamId: string, slackUserId: string): Promise<string | null> {
  const email = await resolveSlackUserEmail(tenantId, teamId, slackUserId);
  if (!email) return null;
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT id FROM users WHERE tenant_id = current_tenant() AND lower(email) = lower($1) LIMIT 1", [email]);
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
}

function snoozeUntilIso(v?: string): string {
  const now = Date.now();
  const ms = v === "1h" ? 3_600_000 : v === "3d" ? 3 * 86_400_000 : v === "1w" ? 7 * 86_400_000 : 86_400_000;
  return new Date(now + ms).toISOString();
}
function normalizePriority(v?: string): "low" | "normal" | "high" | "urgent" {
  const p = (v ?? "").toLowerCase();
  return p === "low" || p === "high" || p === "urgent" ? p : "normal";
}
async function setPriority(tenantId: string, ticketId: string, p: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query("UPDATE tickets SET priority = $1, updated_at = now() WHERE id = $2", [p, ticketId]);
  });
}

export type SlackActionKind = "close" | "reopen" | "snooze" | "priority" | "note" | "assign_me" | "unassign";
export interface SlackActionInput {
  teamId: string;
  channelId: string;
  actorId: string;
  actorName?: string | null;
  kind: SlackActionKind;
  value?: string; // snooze duration, priority level, or the note body
}
export interface SlackActionResult {
  ok: boolean;
  ticketId: string | null;
  message: string;
}

/**
 * Apply a triage action to the channel's open ticket, reusing the core mutation engine, then refresh
 * the status card so Slack reflects the change immediately. Assignment maps the Slack actor to a
 * Noola agent by email (no config table). Returns a short human message for the ephemeral ack.
 */
export async function applySlackAction(input: SlackActionInput): Promise<SlackActionResult> {
  const tenantId = await resolveTenantByTeam(input.teamId);
  if (!tenantId) return { ok: false, ticketId: null, message: "This workspace isn't connected." };
  const ticketId = await channelTicket(tenantId, ext(input.teamId, input.channelId));
  if (!ticketId) return { ok: false, ticketId: null, message: "No open ticket in this channel." };

  let message: string;
  switch (input.kind) {
    case "close":
      await setTicketStatus(tenantId, ticketId, "closed");
      message = "Ticket closed.";
      break;
    case "reopen":
      await setTicketStatus(tenantId, ticketId, "open");
      message = "Ticket reopened.";
      break;
    case "snooze":
      await snoozeTicket(tenantId, ticketId, snoozeUntilIso(input.value));
      message = `Snoozed for ${input.value ?? "1d"}.`;
      break;
    case "priority": {
      const p = normalizePriority(input.value);
      await setPriority(tenantId, ticketId, p);
      message = `Priority set to ${p}.`;
      break;
    }
    case "note": {
      const body = (input.value ?? "").trim();
      if (!body) return { ok: false, ticketId, message: "Please include the note text." };
      await addNote(tenantId, ticketId, { authorName: input.actorName ?? "Slack", body });
      message = "Internal note added.";
      break;
    }
    case "assign_me": {
      const agentId = await resolveAgentByEmail(tenantId, input.teamId, input.actorId);
      if (!agentId) return { ok: false, ticketId, message: "Couldn't match you to a teammate — is your Slack email shared and registered here?" };
      await assignTicket(tenantId, ticketId, agentId);
      message = "Assigned to you.";
      break;
    }
    case "unassign":
      await assignTicket(tenantId, ticketId, null);
      message = "Unassigned.";
      break;
    default:
      return { ok: false, ticketId, message: "Unknown action." };
  }

  // Reflect the change on the in-channel card. Best-effort.
  await refreshSlackCard(tenantId, input.teamId, input.channelId, ticketId).catch(() => {});
  // CSAT-on-close is unified through the seeded `ticket.closed → survey` flow (channel-aware: it
  // posts the Block Kit star prompt for Slack tickets). Emit the domain event so a Slack close
  // behaves like any other close — no separate hardcoded CSAT path here.
  if (input.kind === "close") {
    void import("./automations.js")
      .then((m) => m.emitDomainEvent(tenantId, "ticket.closed", { ticketId }))
      .catch(() => {});
  }
  return { ok: true, ticketId, message };
}

// ── emoji-reaction actions ────────────────────────────────────────────────
// Reacting on any message in a bound channel triages that channel's ticket — the fastest possible
// in-Slack triage. The emoji→action map is now the tenant's `slack_reaction_map` config (0087,
// seeded with the built-in defaults); unknown reactions are ignored.
export async function handleSlackReaction(teamId: string, channelId: string, reaction: string, userId: string): Promise<void> {
  const tenantId = await resolveTenantByTeam(teamId);
  if (!tenantId) return;
  const map = await getReactionMap(tenantId);
  const kind = map[reaction];
  if (!kind) return;
  await applySlackAction({ teamId, channelId, actorId: userId, kind: kind as SlackActionKind });
}

// ── status card ───────────────────────────────────────────────────────────
interface TicketBrief {
  subject: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  snoozed_until: string | null;
}
async function loadTicketBrief(tenantId: string, ticketId: string): Promise<TicketBrief | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.subject, t.status, t.priority, t.snoozed_until, u.name AS assignee
         FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id AND u.tenant_id = t.tenant_id
        WHERE t.id = $1`,
      [ticketId],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return { subject: row.subject, status: row.status, priority: row.priority, assignee: row.assignee, snoozed_until: row.snoozed_until };
  });
}

function cardBlocks(t: TicketBrief): unknown[] {
  const badge = t.status === "closed" ? "✅ Closed" : t.snoozed_until ? "😴 Snoozed" : "🟢 Open";
  const fields = [
    `*Status:*\n${badge}`,
    `*Priority:*\n${t.priority}`,
    `*Assignee:*\n${t.assignee ?? "_Unassigned_"}`,
  ];
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${t.subject || "Support ticket"}*` } },
    { type: "section", fields: fields.map((f) => ({ type: "mrkdwn", text: f })) },
  ];
  // Action row (hidden once closed — reopen only).
  if (t.status === "closed") {
    blocks.push({ type: "actions", elements: [btn("Reopen", "triage_reopen")] });
  } else {
    blocks.push({
      type: "actions",
      elements: [
        btn("Assign to me", "triage_assign_me"),
        btn("Snooze 1d", "triage_snooze", "1d"),
        btn("High priority", "triage_priority", "high"),
        btn("Close", "triage_close", undefined, "primary"),
      ],
    });
  }
  return blocks;
}
function btn(text: string, action_id: string, value?: string, style?: string): unknown {
  return { type: "button", text: { type: "plain_text", text }, action_id, ...(value ? { value } : {}), ...(style ? { style } : {}) };
}

/** Post or edit-in-place the ticket's status card in its channel. */
export async function refreshSlackCard(tenantId: string, teamId: string, channelId: string, ticketId: string): Promise<void> {
  const t = await loadTicketBrief(tenantId, ticketId);
  if (!t) return;
  const blocks = cardBlocks(t);
  const text = `${t.subject || "Support ticket"} — ${t.status}`;
  const existing = await withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT message_ts FROM slack_ticket_cards WHERE ticket_id = $1", [ticketId]);
    return r.rowCount ? (r.rows[0].message_ts as string) : null;
  });
  if (existing) {
    await updateSlackMessage(tenantId, teamId, channelId, existing, blocks, text);
    return;
  }
  const { ok, ts } = await postSlackBlocks(tenantId, teamId, channelId, blocks, text);
  if (ok && ts) {
    await withTenant(tenantId, async (c) => {
      await c.query(
        `INSERT INTO slack_ticket_cards (tenant_id, ticket_id, channel, message_ts) VALUES (current_tenant(), $1, $2, $3)
         ON CONFLICT (tenant_id, ticket_id) DO UPDATE SET message_ts = EXCLUDED.message_ts, channel = EXCLUDED.channel, updated_at = now()`,
        [ticketId, channelId, ts],
      );
    });
  }
}

// ── CSAT in Slack ──────────────────────────────────────────────────────────
export async function postCsatPrompt(tenantId: string, teamId: string, channelId: string, ticketId: string): Promise<void> {
  const elements = [1, 2, 3, 4, 5].map((n) => btn(`${n}★`, "csat_rate", `${ticketId}:${n}`));
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "How did we do? Rate this conversation:" } },
    { type: "actions", elements },
  ];
  await postSlackBlocks(tenantId, teamId, channelId, blocks, "Rate this conversation");
}

/** Record a CSAT rating chosen from the Slack prompt (value = "<ticketId>:<rating>"). */
export async function recordSlackCsat(tenantId: string, ticketId: string, rating: number): Promise<boolean> {
  const r = await recordCsat(tenantId, ticketId, rating);
  return !!r;
}

// ── account binding (channel → company) ────────────────────────────────────
export async function setChannelAccount(tenantId: string, teamId: string, channel: string, companyId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO slack_channel_accounts (tenant_id, team_id, channel, company_id) VALUES (current_tenant(), $1, $2, $3)
       ON CONFLICT (tenant_id, team_id, channel) DO UPDATE SET company_id = EXCLUDED.company_id`,
      [teamId, channel, companyId],
    );
  });
}
export async function unsetChannelAccount(tenantId: string, teamId: string, channel: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM slack_channel_accounts WHERE team_id = $1 AND channel = $2", [teamId, channel]);
    return (r.rowCount ?? 0) > 0;
  });
}
export async function listChannelAccounts(tenantId: string): Promise<{ team_id: string; channel: string; company_id: string }[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT team_id, channel, company_id FROM slack_channel_accounts WHERE tenant_id = current_tenant() ORDER BY created_at ASC");
    return r.rows as { team_id: string; channel: string; company_id: string }[];
  });
}

/** On ingest of a Slack message, roll the conversation up to the channel's bound company: set the
 *  contact's company_id if a binding exists and the contact isn't already attributed. Best-effort. */
export async function applyChannelAccount(tenantId: string, teamId: string, channel: string, contactId: string | null): Promise<void> {
  if (!contactId) return;
  await withTenant(tenantId, async (c) => {
    const b = await c.query("SELECT company_id FROM slack_channel_accounts WHERE team_id = $1 AND channel = $2", [teamId, channel]);
    if (!b.rowCount) return;
    await c.query("UPDATE contacts SET company_id = $1, updated_at = now() WHERE id = $2 AND company_id IS NULL", [b.rows[0].company_id, contactId]);
  });
}
