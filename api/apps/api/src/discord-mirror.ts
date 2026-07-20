import { relayPool, withTenant } from "@repo/db";
import { addNote } from "./notes.js";
import { ingestInbound } from "./ingest.js";
import { getChannelDriver } from "./channels/registry.js";
import { translateOutboundReply, stampOutboundTranslation } from "./translate.js";
import { getMirrorTransport, setDiscordTransportForTests, type MirrorTransport } from "./discord-gateway.js";
import { assignTicket, setTicketStatus, snoozeTicket } from "./tickets.js";
import { canonicalEmojiName, getReactionMap } from "./classification.js";
import { resolveTeammate } from "./discord-classify.js";

// Discord forum ops-mirror (PILOT-AND-DISCORD-PLAN Part 1). A ticket from ANY origin channel
// (email/widget/…) can be selectively mirrored as ONE forum post in a Discord forum channel; the
// team triages/answers from Discord, the customer never sees Discord. The post is a two-way mirror
// of the ticket's REAL timeline:
//  - inbound: every customer message (and console agent reply) appends into the post; forum tags
//    track status/priority; close archives the post.
//  - outbound: a responder's message in the post lands as an INTERNAL NOTE on the ticket by
//    default; a 📤 reaction promotes it to a REPLY — dispatched through the existing channel
//    registry to the ticket's ORIGIN channel. Nothing auto-sends (reply-vs-note duality, locked).
//
// Selection is NATIVE (not Studio-dependent): per-binding filter evaluated on ticket.created (with
// one delayed re-check so seeded autotag/routing effects are visible) + a manual "Push to Discord".
// Echo-guard: our own posts arrive as bot messages, which the gateway swallows for mirror threads;
// promotion ingests with origin:'discord_mirror' so the relay hook skips re-posting it.

export const PROMOTE_EMOJI = "📤";
const PROMOTED_EMOJI = "✅";
const TRIAGED_EMOJI = "🆗";

export interface MirrorFilter {
  priorities?: string[];
  tags?: string[];
  topics?: string[];
  teamIds?: string[];
  channels?: string[];
}

export interface MirrorBinding {
  id: string;
  tenant_id: string;
  guild_id: string;
  forum_channel_id: string;
  enabled: boolean;
  responder_role_id: string | null;
  attribution_mode: "team" | "collaborator";
  attribution_name: string | null;
  filter: MirrorFilter;
}

// Test seam: delegates to the gateway-level override so the mirror engine AND the VIP
// thread-per-message path (discord.ts) share one injected mock.
export function setMirrorTransportForTests(t: MirrorTransport | null): void {
  setDiscordTransportForTests(t);
}
function transport(): MirrorTransport | null {
  return getMirrorTransport();
}

/** The Noola display name for a resolved teammate seat — so a mirrored note/reply is attributed to
 *  the real Noola user, not just the Discord display handle. */
async function teammateName(tenantId: string, userId: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT name FROM users WHERE id = $1 LIMIT 1", [userId]);
    return r.rowCount ? (r.rows[0].name as string) : null;
  });
}

function asFilter(v: unknown): MirrorFilter {
  if (v && typeof v === "object") return v as MirrorFilter;
  if (typeof v === "string") {
    try { return JSON.parse(v) as MirrorFilter; } catch { return {}; }
  }
  return {};
}

function rowToBinding(r: Record<string, unknown>): MirrorBinding {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    guild_id: r.guild_id as string,
    forum_channel_id: r.forum_channel_id as string,
    enabled: r.enabled as boolean,
    responder_role_id: (r.responder_role_id as string | null) ?? null,
    attribution_mode: (r.attribution_mode as "team" | "collaborator") ?? "team",
    attribution_name: (r.attribution_name as string | null) ?? null,
    filter: asFilter(r.filter),
  };
}

/** The tenant's mirror bindings (relay-scoped table; tenant filter in the query). */
export async function listMirrorBindings(tenantId: string): Promise<MirrorBinding[]> {
  const r = await relayPool.query(
    "SELECT * FROM discord_mirror_bindings WHERE tenant_id = $1 ORDER BY created_at ASC",
    [tenantId],
  );
  return r.rows.map(rowToBinding);
}

/** Full-replace the tenant's bindings (Settings save model, same as classification config).
 *  Deleting a binding cascades its ticket_mirror rows — the Discord posts stay, they just stop
 *  being wired (acceptable: unbinding a forum IS "stop mirroring there"). */
export async function replaceMirrorBindings(
  tenantId: string,
  bindings: Array<{
    guildId: string; forumChannelId: string; enabled: boolean;
    responderRoleId?: string | null; attributionMode?: "team" | "collaborator";
    attributionName?: string | null; filter?: MirrorFilter;
  }>,
): Promise<MirrorBinding[]> {
  const keep: string[] = [];
  for (const b of bindings) {
    const r = await relayPool.query(
      `INSERT INTO discord_mirror_bindings
         (tenant_id, guild_id, forum_channel_id, enabled, responder_role_id, attribution_mode, attribution_name, filter)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (tenant_id, forum_channel_id) DO UPDATE SET
         guild_id = EXCLUDED.guild_id, enabled = EXCLUDED.enabled,
         responder_role_id = EXCLUDED.responder_role_id, attribution_mode = EXCLUDED.attribution_mode,
         attribution_name = EXCLUDED.attribution_name, filter = EXCLUDED.filter
       RETURNING id`,
      [tenantId, b.guildId, b.forumChannelId, b.enabled, b.responderRoleId ?? null,
       b.attributionMode ?? "team", b.attributionName ?? null, JSON.stringify(b.filter ?? {})],
    );
    keep.push(r.rows[0].id as string);
  }
  await relayPool.query(
    `DELETE FROM discord_mirror_bindings WHERE tenant_id = $1 AND NOT (id = ANY($2::uuid[]))`,
    [tenantId, keep],
  );
  return listMirrorBindings(tenantId);
}

interface TicketBrief {
  id: string;
  subject: string;
  status: string;
  priority: string;
  tags: string[];
  topic: string | null;
  team_id: string | null;
  channel_type: string;
  contact_name: string | null;
  contact_email: string | null;
}

async function loadTicketBrief(tenantId: string, ticketId: string): Promise<TicketBrief | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.id, t.subject, t.status, t.priority, t.tags, t.topic, t.team_id, t.channel_type,
              ct.name AS contact_name, ct.email AS contact_email
         FROM tickets t
         LEFT JOIN contacts ct ON ct.tenant_id = t.tenant_id AND ct.id = t.contact_id
        WHERE t.id = $1`,
      [ticketId],
    );
    return r.rowCount ? (r.rows[0] as TicketBrief) : null;
  });
}

/** Does the ticket match a binding's filter? Empty/absent facets match everything; a listed facet
 *  requires membership (tags: ANY overlap). Discord-origin tickets never auto-mirror — the team is
 *  already in Discord for those. */
export function matchesMirrorFilter(t: TicketBrief, f: MirrorFilter): boolean {
  if (t.channel_type === "discord") return false;
  if (f.channels?.length && !f.channels.includes(t.channel_type)) return false;
  if (f.priorities?.length && !f.priorities.includes(t.priority)) return false;
  if (f.topics?.length && !(t.topic && f.topics.includes(t.topic))) return false;
  if (f.teamIds?.length && !(t.team_id && f.teamIds.includes(t.team_id))) return false;
  if (f.tags?.length && !f.tags.some((tag) => t.tags.includes(tag))) return false;
  return true;
}

/** Forum tag names for a ticket's current state: status + priority (a stable, small set that stays
 *  under Discord's 20-tags-per-forum cap). */
function mirrorTagNames(t: { status: string; priority: string }): string[] {
  return [t.status, t.priority];
}

function webBase(): string {
  const w = process.env.WEB_BASE_URL;
  return w ? w.replace(/\/+$/, "") : "";
}

function postTitle(t: TicketBrief): string {
  return `${t.subject || "Support ticket"}`.slice(0, 96);
}

function postHeader(t: TicketBrief, latestBody: string | null): string {
  const who = t.contact_name || t.contact_email || "Unknown contact";
  const lines = [
    `**${t.subject || "Support ticket"}**`,
    `From **${who}** · via ${t.channel_type} · priority **${t.priority}**`,
  ];
  if (latestBody) lines.push("", quote(latestBody));
  const base = webBase();
  if (base) lines.push("", `Console: ${base}/tickets/${t.id}`);
  lines.push("", `_Messages here are internal notes. React ${PROMOTE_EMOJI} on a message to send it to the customer; ✅ closes, 🔄 reopens, 👀 assigns to you, 💤 snoozes._`);
  return lines.join("\n");
}

function quote(body: string): string {
  return body.slice(0, 1500).split("\n").map((l) => `> ${l}`).join("\n");
}

export interface MirrorRef {
  tenant_id: string;
  ticket_id: string;
  binding_id: string | null;
  guild_id: string;
  forum_channel_id: string;
  post_thread_id: string;
}

/** The mirror row for a ticket (null when not mirrored / still pending). */
export async function getTicketMirror(tenantId: string, ticketId: string): Promise<MirrorRef | null> {
  const r = await relayPool.query(
    "SELECT * FROM ticket_mirror WHERE tenant_id = $1 AND ticket_id = $2 AND post_thread_id NOT LIKE 'pending:%'",
    [tenantId, ticketId],
  );
  return r.rowCount ? (r.rows[0] as MirrorRef) : null;
}

/** Reverse lookup: is this Discord thread a mirror post? Runs pre-tenant (relay), gateway hot path. */
export async function mirrorByThread(postThreadId: string): Promise<MirrorRef | null> {
  const r = await relayPool.query("SELECT * FROM ticket_mirror WHERE post_thread_id = $1", [postThreadId]);
  return r.rowCount ? (r.rows[0] as MirrorRef) : null;
}

async function loadBinding(bindingId: string): Promise<MirrorBinding | null> {
  const r = await relayPool.query("SELECT * FROM discord_mirror_bindings WHERE id = $1", [bindingId]);
  return r.rowCount ? rowToBinding(r.rows[0]) : null;
}

/**
 * Create the forum post for a ticket under a binding. Idempotent: the pending-claim INSERT is the
 * race guard (first caller proceeds, everyone else sees the row); transport failure rolls the claim
 * back so a later retry can succeed. Returns the mirror row, or null (already mirrored / no
 * transport / Discord refused).
 */
export async function mirrorTicket(tenantId: string, ticketId: string, binding: MirrorBinding): Promise<MirrorRef | null> {
  const tp = transport();
  if (!tp) return null;
  const t = await loadTicketBrief(tenantId, ticketId);
  if (!t) return null;

  const claim = await relayPool.query(
    `INSERT INTO ticket_mirror (tenant_id, ticket_id, binding_id, guild_id, forum_channel_id, post_thread_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, ticket_id) DO NOTHING RETURNING ticket_id`,
    [tenantId, ticketId, binding.id, binding.guild_id, binding.forum_channel_id, `pending:${ticketId}`],
  );
  if (!claim.rowCount) return getTicketMirror(tenantId, ticketId);

  // Latest customer message seeds the post body (best-effort).
  const latest = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT body FROM messages WHERE ticket_id = $1 AND author_type = 'customer' AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [ticketId],
    );
    return r.rowCount ? (r.rows[0].body as string) : null;
  });

  const created = await tp
    .createForumPost(binding.forum_channel_id, postTitle(t), postHeader(t, latest), mirrorTagNames(t))
    .catch(() => null);
  if (!created) {
    await relayPool.query("DELETE FROM ticket_mirror WHERE tenant_id = $1 AND ticket_id = $2 AND post_thread_id LIKE 'pending:%'", [tenantId, ticketId]);
    return null;
  }
  await relayPool.query(
    "UPDATE ticket_mirror SET post_thread_id = $3 WHERE tenant_id = $1 AND ticket_id = $2",
    [tenantId, ticketId, created.threadId],
  );
  return getTicketMirror(tenantId, ticketId);
}

/**
 * Native auto-mirror evaluation — called from the domain-event seam on ticket.created /
 * priority_changed / tagged / assigned. Already-mirrored tickets just re-sync their forum tags.
 * On ticket.created the seeded autotag/routing/topic automations may not have landed yet, so a
 * no-match schedules ONE delayed re-check (5s) before giving up; manual push always remains.
 */
export async function evaluateAutoMirror(tenantId: string, ticketId: string, opts?: { recheck?: boolean }): Promise<void> {
  const existing = await getTicketMirror(tenantId, ticketId);
  if (existing) {
    await syncMirrorState(tenantId, ticketId).catch(() => {});
    return;
  }
  const bindings = (await listMirrorBindings(tenantId)).filter((b) => b.enabled);
  if (!bindings.length) return;
  const t = await loadTicketBrief(tenantId, ticketId);
  if (!t || t.channel_type === "discord") return;
  const match = bindings.find((b) => matchesMirrorFilter(t, b.filter));
  if (match) {
    await mirrorTicket(tenantId, ticketId, match);
    return;
  }
  if (opts?.recheck) {
    setTimeout(() => { void evaluateAutoMirror(tenantId, ticketId).catch(() => {}); }, 5000);
  }
}

/**
 * Backfill: mirror the EXISTING open inbox into the enabled bindings — "mirror every convo"
 * means the inbox as it stands, not just tickets created after the binding was saved. Same
 * selection as evaluateAutoMirror (first enabled binding whose filter matches; discord-origin
 * never mirrors); already-mirrored tickets are skipped, so it's idempotent and safe to re-run.
 * Sequential + capped (Discord forum-post creation is rate-limited). Fired on binding save.
 */
const BACKFILL_CAP = 100;
export async function backfillMirrors(tenantId: string): Promise<{ mirrored: number; scanned: number }> {
  const bindings = (await listMirrorBindings(tenantId)).filter((b) => b.enabled);
  if (!bindings.length || !transport()) return { mirrored: 0, scanned: 0 };
  const rows = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.id FROM tickets t
        WHERE t.status = 'open' AND t.channel_type IS DISTINCT FROM 'discord'
          AND NOT EXISTS (SELECT 1 FROM ticket_mirror m WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id)
        ORDER BY t.updated_at DESC LIMIT $1`,
      [BACKFILL_CAP],
    );
    return r.rows as Array<{ id: string }>;
  });
  let mirrored = 0;
  for (const { id } of rows) {
    const t = await loadTicketBrief(tenantId, id);
    if (!t) continue;
    const match = bindings.find((b) => matchesMirrorFilter(t, b.filter));
    if (!match) continue;
    const m = await mirrorTicket(tenantId, id, match).catch(() => null);
    if (m) mirrored++;
  }
  return { mirrored, scanned: rows.length };
}

/** Why isn't this ticket mirrored (yet)? — the context-rail state read. `auto` = an enabled
 *  binding's filter matches, so it will mirror on its own (backfill/next event); a manual push
 *  is only meaningful when a binding exists but the filter does NOT match. */
export async function mirrorEligibility(
  tenantId: string,
  ticketId: string,
): Promise<{ hasBinding: boolean; discordOrigin: boolean; auto: boolean }> {
  const bindings = (await listMirrorBindings(tenantId)).filter((b) => b.enabled);
  if (!bindings.length) return { hasBinding: false, discordOrigin: false, auto: false };
  const t = await loadTicketBrief(tenantId, ticketId);
  if (!t) return { hasBinding: true, discordOrigin: false, auto: false };
  if (t.channel_type === "discord") return { hasBinding: true, discordOrigin: true, auto: false };
  return { hasBinding: true, discordOrigin: false, auto: bindings.some((b) => matchesMirrorFilter(t, b.filter)) };
}

/** Manual "Push to Discord": mirror regardless of filter, using the given binding or the first
 *  enabled one. Returns the mirror (existing or new) or null with a reason. */
export async function pushTicketToDiscord(
  tenantId: string,
  ticketId: string,
  bindingId?: string | null,
): Promise<{ mirror: MirrorRef | null; reason?: string }> {
  const existing = await getTicketMirror(tenantId, ticketId);
  if (existing) return { mirror: existing };
  const bindings = (await listMirrorBindings(tenantId)).filter((b) => b.enabled);
  const binding = bindingId ? bindings.find((b) => b.id === bindingId) : bindings[0];
  if (!binding) return { mirror: null, reason: "no_binding" };
  if (!transport()) return { mirror: null, reason: "discord_offline" };
  const mirror = await mirrorTicket(tenantId, ticketId, binding);
  return mirror ? { mirror } : { mirror: null, reason: "create_failed" };
}

/** Deep link to the forum post (Discord's canonical URL shape). */
export function mirrorUrl(m: MirrorRef): string {
  return `https://discord.com/channels/${m.guild_id}/${m.post_thread_id}`;
}

// ── D2: ticket timeline → forum post ──────────────────────────────────────────

/**
 * Relay a fresh ticket message into its mirror post (ingest post-commit hook). Customer messages
 * and console agent replies both mirror — the post IS the timeline. Discord-origin tickets and
 * promotion-minted messages (origin 'discord_mirror') never reach here. Re-reads the message row
 * for the author name so the hook stays a fire-and-forget (tenantId, ids) call.
 */
export async function relayTicketMessage(tenantId: string, ticketId: string, messageId: string): Promise<void> {
  const mirror = await getTicketMirror(tenantId, ticketId);
  if (!mirror) return;
  const tp = transport();
  if (!tp) return;
  const row = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT m.body, m.author_type, COALESCE(m.auto, false) AS auto,
              COALESCE((SELECT u.name FROM users u WHERE u.tenant_id = m.tenant_id AND u.id = m.author_id),
                       m.author_external_name,
                       (SELECT ct.name FROM contacts ct WHERE ct.tenant_id = m.tenant_id AND ct.id = m.author_contact_id)) AS author_name
         FROM messages m WHERE m.id = $1 AND m.ticket_id = $2`,
      [messageId, ticketId],
    );
    return r.rowCount ? r.rows[0] as { body: string; author_type: string; auto: boolean; author_name: string | null } : null;
  });
  if (!row) return;
  const isCustomer = row.author_type === "customer";
  const name = row.author_name || (isCustomer ? "Customer" : row.auto ? "AI assistant" : "Agent");
  const label = isCustomer ? `💬 **${name}:**` : `↩️ **${name}** _(reply sent to customer)_:`;
  await tp.postToThread(mirror.post_thread_id, `${label}\n${row.body.slice(0, 1800)}`).catch(() => {});
  await syncMirrorState(tenantId, ticketId).catch(() => {});
}

/** Re-apply forum tags from the ticket's current status/priority; archive on closed, unarchive
 *  otherwise (D4 lifecycle). Cheap + idempotent, so callers can fire it after any change. */
export async function syncMirrorState(tenantId: string, ticketId: string): Promise<void> {
  const mirror = await getTicketMirror(tenantId, ticketId);
  if (!mirror) return;
  const tp = transport();
  if (!tp) return;
  const t = await loadTicketBrief(tenantId, ticketId);
  if (!t) return;
  await tp.applyTags(mirror.post_thread_id, mirrorTagNames(t)).catch(() => {});
  await tp.setArchived(mirror.post_thread_id, t.status === "closed").catch(() => {});
}

/**
 * Fired on `ticket.closed` (via the domain-event seam). Makes a close VISIBLE in Discord instead of a
 * silent archive:
 *  - MIRRORED ticket: post a "✅ Resolved" notice into the forum post, then re-sync tags/archive.
 *  - Discord-ORIGIN (intake) ticket closed IN NOOLA: reflect the close onto the origin thread (post a
 *    notice + archive it). A later customer message reopens it via the ingest upsert.
 * Skipped for the origin thread when the close came FROM Discord (source='discord') — the thread is
 * already archived/locked there and re-posting would echo. Best-effort throughout.
 */
export async function onTicketClosed(
  tenantId: string,
  ticketId: string,
  opts: { source?: string | null; agentName?: string | null } = {},
): Promise<void> {
  const mirror = await getTicketMirror(tenantId, ticketId);
  if (mirror) {
    const tp = transport();
    if (tp) {
      const by = opts.agentName ? ` by ${opts.agentName}` : "";
      await tp.postToThread(mirror.post_thread_id, `✅ **Resolved**${by} — closed in Noola.`).catch(() => {});
    }
    await syncMirrorState(tenantId, ticketId).catch(() => {});
    return;
  }
  if (opts.source === "discord") return; // closed from the origin thread itself — nothing to push back
  await archiveIntakeThreadOnClose(tenantId, ticketId, opts.agentName ?? null);
}

/** Reflect a Noola-side close of a Discord-origin (intake) ticket back onto its origin thread:
 *  a "resolved" notice + archive. A customer reply reopens the thread's ticket (ingest upsert). */
async function archiveIntakeThreadOnClose(tenantId: string, ticketId: string, agentName: string | null): Promise<void> {
  const t = await withTenant(tenantId, (c) =>
    c.query(
      "SELECT external_thread_id FROM tickets WHERE id = $1 AND channel_type = 'discord' AND external_thread_id IS NOT NULL",
      [ticketId],
    ),
  );
  if (!t.rowCount) return;
  const threadId = t.rows[0].external_thread_id as string;
  const tp = transport();
  if (!tp) return;
  const by = agentName ? ` by ${agentName}` : "";
  await tp.postToThread(threadId, `✅ Marked resolved${by}. Reply here if you still need help.`).catch(() => {});
  await tp.setArchived(threadId, true).catch(() => {});
}

// ── D3: forum post → ticket (note by default, 📤 promotes to reply) ───────────

export interface MirrorPostMessage {
  guildId: string;
  threadId: string | null;
  discordMessageId: string;
  authorId: string;
  authorDisplayName: string | null;
  content: string;
  roleIds: string[];
  isBotOrWebhook: boolean;
}

/**
 * Gateway seam: a MessageCreate that lands in a mirror post thread is handled HERE and never
 * reaches the customer-channel ingest (a mirror forum must not double as a customer channel).
 * Returns {handled:false} for non-mirror threads so the gateway falls through to the normal path.
 * A human message → internal note on the ticket + a ticket_mirror_messages row (the promotion
 * ledger). Bot/webhook messages (our own relays) are swallowed — the echo-guard.
 */
export async function handleMirrorPostMessage(m: MirrorPostMessage): Promise<{ handled: boolean; noteId?: string }> {
  if (!m.threadId) return { handled: false };
  const mirror = await mirrorByThread(m.threadId);
  if (!mirror) return { handled: false };
  if (m.isBotOrWebhook) return { handled: true }; // our relays / other bots: never notes, never ingest
  const body = (m.content ?? "").trim();
  if (!body) return { handled: true };

  const binding = mirror.binding_id ? await loadBinding(mirror.binding_id) : null;
  // Resolve the Discord author to a Noola seat ONCE — reused to attribute the note AND gate promotion.
  const agentId = await resolveTeammate(mirror.tenant_id, m.authorId);
  // SECURITY: an UNSET responder role must NOT mean "the whole server is staff" — otherwise any
  // server member's message could later be promoted to the customer or triage the ticket. Require the
  // configured responder role OR an explicit teammate mark (agent_channel_identities).
  const isResponder = binding?.responder_role_id
    ? m.roleIds.includes(binding.responder_role_id) || Boolean(agentId)
    : Boolean(agentId);

  // Attribute the note to the resolved Noola user: author_id links it to their seat, and the name is
  // their real Noola name — not just the Discord display handle (fixes "it's not aware it's me").
  const seatName = agentId ? await teammateName(mirror.tenant_id, agentId) : null;
  const name = seatName || m.authorDisplayName || "Discord teammate";
  const note = await addNote(mirror.tenant_id, mirror.ticket_id, {
    authorId: agentId ?? null,
    authorName: `${name} (Discord)`,
    body,
  }).catch(() => null);

  await relayPool.query(
    `INSERT INTO ticket_mirror_messages
       (discord_message_id, tenant_id, ticket_id, post_thread_id, author_discord_id, author_display_name, is_responder, body, note_id, author_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (discord_message_id) DO NOTHING`,
    [m.discordMessageId, mirror.tenant_id, mirror.ticket_id, m.threadId, m.authorId, m.authorDisplayName, isResponder, body, note?.id ?? null, agentId ?? null],
  );
  return { handled: true, noteId: note?.id };
}

export interface MirrorReaction {
  guildId: string;
  threadId: string;
  discordMessageId: string;
  reactorId: string;
  emoji: string;
  reactorRoleIds?: string[];
}

/**
 * A reaction in a mirror post is a TRIAGE surface (the Slack-reaction-triage model, shared map):
 *  - 📤 (reserved) promotes a responder's message to a customer reply — exactly once
 *    (promoted_at claim), riding the EXISTING pipeline: ingestInbound(agent, origin
 *    'discord_mirror') → translate → channel-registry dispatch to the ticket's origin channel.
 *    Attribution: 'team' signs with the binding's attribution_name; 'collaborator' with the
 *    Discord display name.
 *  - any other mapped emoji (tenant's reaction-triage map, shared with Slack) applies its action
 *    to the underlying ticket: close / reopen / assign-to-me / snooze / unassign. Thread-scoped —
 *    reacting anywhere in the post (including the bot's starter message) triages the ticket.
 * Role-gate for both: the REACTOR must hold the responder role when one is set, OR be an
 * explicitly marked teammate (agent_channel_identities) — reacting is the action, so the gate
 * sits on the reactor. Unknown emoji are ignored.
 */
export async function handleMirrorReaction(
  r: MirrorReaction,
): Promise<{ promoted: boolean; action?: string; reason?: string }> {
  const mirror = await mirrorByThread(r.threadId);
  if (!mirror) return { promoted: false, reason: "not_mirror" };
  const binding = mirror.binding_id ? await loadBinding(mirror.binding_id) : null;

  // Marked teammates pass the gate regardless of Discord roles; resolved once, reused by assign-me.
  const agentId = await resolveTeammate(mirror.tenant_id, r.reactorId);
  if (binding?.responder_role_id && !agentId) {
    const roles = r.reactorRoleIds ?? (await transport()?.memberRoleIds(r.guildId, r.reactorId).catch(() => [])) ?? [];
    if (!roles.includes(binding.responder_role_id)) return { promoted: false, reason: "not_responder" };
  }

  if (canonicalEmojiName(r.emoji) !== "outbox_tray") {
    return applyMirrorTriage(mirror, r, agentId);
  }

  // Atomic promote claim — WHERE promoted_at IS NULL makes the double-react / two-reactors race safe.
  const claim = await relayPool.query(
    `UPDATE ticket_mirror_messages SET promoted_at = now()
      WHERE discord_message_id = $1 AND is_responder AND promoted_at IS NULL
      RETURNING tenant_id, ticket_id, body, author_display_name, author_discord_id, author_user_id`,
    [r.discordMessageId],
  );
  if (!claim.rowCount) return { promoted: false, reason: "not_promotable" };
  const row = claim.rows[0] as {
    tenant_id: string; ticket_id: string; body: string;
    author_display_name: string | null; author_discord_id: string | null; author_user_id: string | null;
  };

  // Attribute by the AUTHOR of the promoted message (not the reactor): a marked teammate → their Noola
  // seat + real name + authorKind 'agent'; a genuinely seat-less responder stays 'community'. Falls
  // back to the stored author_user_id, then a fresh resolve, then the reactor's seat.
  const seatId =
    row.author_user_id ??
    (row.author_discord_id ? await resolveTeammate(row.tenant_id, row.author_discord_id) : null) ??
    agentId;
  const seatName = seatId ? await teammateName(row.tenant_id, seatId) : null;
  const attribution =
    binding?.attribution_mode === "collaborator"
      ? seatName ?? row.author_display_name
      : binding?.attribution_name ?? seatName ?? null;

  const result = await ingestInbound({
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    body: row.body,
    authorType: "agent",
    authorKind: seatId ? "agent" : "community",
    authorId: seatId ?? null,
    authorExternalName: attribution ?? row.author_display_name ?? "Support",
    origin: "discord_mirror",
    idempotencyKey: `discord-mirror-promote:${r.discordMessageId}`,
  });

  const { dispatchBody, meta } = await translateOutboundReply(row.tenant_id, result.ticketId, row.body);
  if (meta) void stampOutboundTranslation(row.tenant_id, result.messageId, meta);

  const driver = getChannelDriver(result.channelType);
  const out = driver?.dispatch
    ? await driver.dispatch(
        { tenantId: row.tenant_id, channelType: result.channelType, externalChannelId: result.externalChannelId, subject: result.subject, ticketId: result.ticketId },
        dispatchBody,
        { agentName: attribution },
      ).catch(() => ({ delivered: false as const, reason: "dispatch_error" }))
    : { delivered: false as const, reason: "no-driver" };

  await relayPool.query(
    "UPDATE ticket_mirror_messages SET promoted_message_id = $2 WHERE discord_message_id = $1",
    [r.discordMessageId, result.messageId],
  );
  await transport()?.react(r.threadId, r.discordMessageId, PROMOTED_EMOJI).catch(() => {});
  return { promoted: true, reason: out.delivered ? undefined : out.reason };
}

/** Default snooze horizon for a reaction (no duration channel on an emoji): 1 day. */
function snoozeUntil(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}

/**
 * Apply a mapped triage action to the mirrored ticket. Gate already passed in the caller. The
 * mutation rides the same core engine as Slack triage (setTicketStatus/snoozeTicket/assignTicket);
 * close emits ticket.closed so seeded automations (CSAT survey, …) behave like any other close.
 * Confirms with a 🆗 react + forum tag/archive re-sync. Idempotent — re-reacting re-applies the
 * same state.
 */
async function applyMirrorTriage(
  mirror: MirrorRef,
  r: MirrorReaction,
  agentId: string | null,
): Promise<{ promoted: boolean; action?: string; reason?: string }> {
  const map = await getReactionMap(mirror.tenant_id);
  const action = map[canonicalEmojiName(r.emoji)];
  if (!action) return { promoted: false, reason: "unmapped_emoji" };
  const { tenant_id: tenantId, ticket_id: ticketId } = mirror;

  switch (action) {
    case "close":
      await setTicketStatus(tenantId, ticketId, "closed");
      // CSAT-on-close stays unified through the seeded `ticket.closed → survey` flow (same as Slack).
      void import("./automations.js")
        .then((m) => m.emitDomainEvent(tenantId, "ticket.closed", { ticketId }))
        .catch(() => {});
      break;
    case "reopen":
      await setTicketStatus(tenantId, ticketId, "open");
      break;
    case "snooze":
      await snoozeTicket(tenantId, ticketId, snoozeUntil());
      break;
    case "assign_me":
      if (!agentId) {
        await transport()
          ?.postToThread(
            mirror.post_thread_id,
            "⚠️ Couldn't match your Discord account to a teammate — add your Discord ID in Settings → Members, then react again.",
          )
          .catch(() => {});
        return { promoted: false, action, reason: "no_seat" };
      }
      await assignTicket(tenantId, ticketId, agentId);
      break;
    case "unassign":
      await assignTicket(tenantId, ticketId, null);
      break;
    default:
      // 'note'/'priority' need a value an emoji can't carry — Slack-only kinds, ignored here.
      return { promoted: false, action, reason: "unsupported_action" };
  }

  await syncMirrorState(tenantId, ticketId).catch(() => {});
  await transport()?.react(mirror.post_thread_id, r.discordMessageId, TRIAGED_EMOJI).catch(() => {});
  return { promoted: false, action };
}
