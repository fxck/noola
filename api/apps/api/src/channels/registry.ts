import { relayPool, withTenant } from "@repo/db";
import { routeOutbound } from "../discord.js";
import { getDiscordSender } from "../discord-gateway.js";
import { routeEmailOutbound, type MailAttachment } from "../email.js";
import { routeSlackOutbound } from "../slack.js";
import { routeTelegramOutbound, telegramConfigured } from "../telegram.js";
import { routeWhatsAppOutbound, whatsappConfigured } from "../whatsapp.js";

// Wave 4: conversational reach — the outbound channel registry. Discord, email and Slack each grew
// their own `route*Outbound` seam (each tested in isolation); this module formalizes them into one
// declarative catalog so (a) the Channels page can render connected-vs-available honestly, and (b)
// new channels — Telegram lands here as a creds-gated stub — plug in as one descriptor instead of a
// scattered fourth code path. The per-driver dispatch adapters wrap the existing functions verbatim,
// so routing behaviour is unchanged; the registry is the single place that KNOWS the channel set.

export interface OutboundContext {
  tenantId: string;
  channelType: string;
  externalChannelId: string | null;
  subject: string;
  /** The conversation this reply belongs to — email uses it for the per-ticket reply-to token +
   *  threading headers (P4). Absent for non-conversation sends (broadcasts). */
  ticketId?: string | null;
}

export type DispatchResult = { delivered: boolean; reason?: string };

/** Extra outbound payload beyond the text body. Only channels that support it (email) act on it;
 *  others ignore the argument entirely. */
export interface DispatchOptions {
  attachments?: MailAttachment[];
  /** Email: carbon-copy recipients (reply-all). Channels without cc semantics ignore it. */
  cc?: string[];
  /** The replying agent's display name — email renders it as a quiet signature line. */
  agentName?: string | null;
  /** Email: the persisted agent message id — embeds a read-receipt pixel (/public/seen/:id) in the
   *  reply HTML so an email open stamps seen_at. Best-effort; ignored by non-email channels. */
  seenMessageId?: string | null;
  /** Discord channel-post broadcast (Phase 4): ping exactly this role (allowedMentions-gated). */
  mentionRoleId?: string | null;
  /** Discord channel-post broadcast (Phase 4): render as an embed titled by ctx.subject. */
  asEmbed?: boolean;
}

export interface ChannelDriver {
  /** Stable channel id — matches tickets.channel_type for the inbound-capable channels. */
  id: string;
  label: string;
  /** Which directions this channel supports today. */
  direction: "inbound" | "outbound" | "both";
  /** "live" = wired end-to-end; "stub" = descriptor + creds gate present, delivery not yet built. */
  status: "live" | "stub";
  /** One-line description for the Channels page. */
  blurb: string;
  /** Count of this tenant's active connections/bindings — 0 means "available, not connected". */
  connections(tenantId: string): Promise<number>;
  /** True when the platform-level prerequisite (a bot token, an API app…) is present. A channel can
   *  be `available` but require credentials the operator hasn't supplied — surfaced honestly, never
   *  faked as connected. */
  credentialed(): boolean;
  /** Deliver an agent reply outbound. Absent for inbound-only channels and unbuilt stubs. `opts`
   *  carries attachments for channels that support them (email); others may ignore it. */
  dispatch?(ctx: OutboundContext, body: string, opts?: DispatchOptions): Promise<DispatchResult>;
}

const discord: ChannelDriver = {
  id: "discord",
  label: "Discord",
  direction: "both",
  status: "live",
  blurb: "Bot relays guild channel messages into tickets and posts agent replies back.",
  credentialed: () => Boolean(process.env.DISCORD_BOT_TOKEN),
  connections: (tenantId) =>
    relayPool
      .query("SELECT count(*)::int AS n FROM discord_links WHERE tenant_id = $1", [tenantId])
      .then((r) => r.rows[0].n as number),
  dispatch: (ctx, body, opts) =>
    routeOutbound(
      { channelType: ctx.channelType, externalChannelId: ctx.externalChannelId },
      body,
      getDiscordSender(),
      // A channel-post broadcast carries the role-mention + embed intent; a plain ticket reply
      // passes none and posts unadorned. ctx.subject titles the embed.
      opts?.mentionRoleId || opts?.asEmbed
        ? { mentionRoleId: opts.mentionRoleId, asEmbed: opts.asEmbed, title: ctx.subject }
        : undefined,
    ),
};

const email: ChannelDriver = {
  id: "email",
  label: "Email",
  direction: "both",
  status: "live",
  blurb: "Inbound addresses route to tickets; replies send as threaded email (Mailpit in dev).",
  // Honest status: without SMTP_HOST outbound silently no-ops — don't show "Available" (audit).
  credentialed: () => Boolean(process.env.SMTP_HOST),
  connections: (tenantId) =>
    relayPool
      .query("SELECT count(*)::int AS n FROM email_routes WHERE tenant_id = $1", [tenantId])
      .then((r) => r.rows[0].n as number),
  dispatch: (ctx, body, opts) =>
    routeEmailOutbound(
      { tenantId: ctx.tenantId, externalChannelId: ctx.externalChannelId, ticketId: ctx.ticketId ?? null },
      ctx.subject,
      body,
      opts?.attachments,
      { agentName: opts?.agentName ?? null, ...(opts?.cc?.length ? { cc: opts.cc } : {}), ...(opts?.seenMessageId ? { seenMessageId: opts.seenMessageId } : {}) },
    ),
};

const slack: ChannelDriver = {
  id: "slack",
  label: "Slack",
  direction: "both",
  status: "live",
  blurb: "Events API pulls messages in; replies post back to the originating Slack channel.",
  credentialed: () => true, // per-connection bot tokens live in slack_connections, resolved at send
  connections: (tenantId) =>
    withTenant(tenantId, (c) => c.query("SELECT count(*)::int AS n FROM slack_connections WHERE active")).then(
      (r) => r.rows[0].n as number,
    ),
  dispatch: (ctx, body) =>
    routeSlackOutbound({ tenantId: ctx.tenantId, channelType: ctx.channelType, externalChannelId: ctx.externalChannelId }, body),
};

// Telegram — a real Bot API driver (telegram.ts), self-serve since 0092: each tenant connects
// its own bot from Settings → Channels (channel_connections); the env pair remains a dev
// fallback. `credentialed` is true unconditionally — there is no platform-level prerequisite
// anymore, the per-tenant connection IS the gate (connections() reports it honestly).
const telegram: ChannelDriver = {
  id: "telegram",
  label: "Telegram",
  direction: "both",
  status: "live",
  blurb: "Bot API channel — connect your bot token in Settings → Channels for inbound polling and replies.",
  credentialed: () => true,
  connections: async (tenantId) => {
    const rows = await relayPool.query(
      "SELECT count(*)::int AS n FROM channel_connections WHERE tenant_id = $1 AND channel = 'telegram' AND active = true",
      [tenantId],
    );
    const envBound = telegramConfigured() && process.env.TELEGRAM_TENANT_ID === tenantId ? 1 : 0;
    return (rows.rows[0].n as number) + envBound;
  },
  dispatch: (ctx, body) => routeTelegramOutbound({ tenantId: ctx.tenantId, channelType: ctx.channelType, externalChannelId: ctx.externalChannelId }, body),
};

// WhatsApp — a Meta Cloud API driver (whatsapp.ts), self-serve since 0092: each tenant connects
// its own number (config.phoneId + secret token) from Settings → Channels; inbound resolves the
// tenant by phone_number_id. Env triple remains a dev fallback.
const whatsapp: ChannelDriver = {
  id: "whatsapp",
  label: "WhatsApp",
  direction: "both",
  status: "live",
  blurb: "Cloud API channel — connect your access token + phone number ID in Settings → Channels, webhook at /whatsapp/webhook.",
  credentialed: () => true,
  connections: async (tenantId) => {
    const rows = await relayPool.query(
      "SELECT count(*)::int AS n FROM channel_connections WHERE tenant_id = $1 AND channel = 'whatsapp' AND active = true",
      [tenantId],
    );
    const envBound = whatsappConfigured() && process.env.WHATSAPP_TENANT_ID === tenantId ? 1 : 0;
    return (rows.rows[0].n as number) + envBound;
  },
  dispatch: (ctx, body) => routeWhatsAppOutbound({ tenantId: ctx.tenantId, channelType: ctx.channelType, externalChannelId: ctx.externalChannelId }, body),
};

/** The channel drivers, in display order. Inbound-only surfaces (widget, webhooks) aren't drivers —
 *  they're counted separately by the Channels page from channelsOverview. */
export const CHANNEL_DRIVERS: ChannelDriver[] = [discord, email, slack, telegram, whatsapp];

export function getChannelDriver(id: string): ChannelDriver | undefined {
  return CHANNEL_DRIVERS.find((d) => d.id === id);
}

export interface ChannelStatus {
  id: string;
  label: string;
  direction: ChannelDriver["direction"];
  status: ChannelDriver["status"];
  blurb: string;
  connections: number;
  connected: boolean;
  credentialed: boolean;
}

/** The Channels page payload: each driver's live connected-vs-available state, honestly gated. */
export async function channelCatalog(tenantId: string): Promise<ChannelStatus[]> {
  return Promise.all(
    CHANNEL_DRIVERS.map(async (d) => {
      const connections = await d.connections(tenantId).catch(() => 0);
      return {
        id: d.id,
        label: d.label,
        direction: d.direction,
        status: d.status,
        blurb: d.blurb,
        connections,
        connected: connections > 0,
        credentialed: d.credentialed(),
      };
    }),
  );
}
