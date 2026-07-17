import { relayPool, withTenant } from "@repo/db";

/**
 * Discord author classification (Phase 2). Turns a raw MESSAGE_CREATE author into a Noola
 * identity so the AI answers only real seekers, teammates map to their seat, external mods stand
 * the AI down as first-class *message-level* identities (no Noola seat, no phantom contact), and
 * ignore-role noise is dropped.
 *
 * Precedence (§5.10): explicit-mark > role-inference > channel-default.
 *  - explicit-mark:   a registered teammate (agent_channel_identities) → 'agent' + resolved seat.
 *  - role-inference:  team_role_ids → 'agent'; responder_role_ids → 'community'; ignore_role_ids → drop.
 *  - channel-default: discord_links.default_author_kind (default 'customer' = a seeker).
 *
 * `authorType` is the binary column downstream code keys on: a teammate AND a community responder are
 * both `authorType:'agent'` (an answer, not a question — whose_turn flips to 'customer', the ambient
 * AI stands down), disambiguated by the additive `author_kind` ('agent' vs 'community'). Only a
 * 'customer' classification resolves a contact; 'agent'/'community' never mint a phantom contact
 * (refuted-claim #2) — the community responder is denormalized into messages.author_external_* only.
 */
export interface DiscordAuthorClassification {
  /** 'drop' → ignore this author entirely (no ticket, no message). */
  action: "ingest" | "drop";
  authorType: "customer" | "agent";
  authorKind: "customer" | "agent" | "community";
  /** Noola user id for a resolved teammate (author_type 'agent', author_kind 'agent'); else null. */
  authorId: string | null;
}

interface GuildRoleConfig {
  teamRoleIds: string[];
  responderRoleIds: string[];
  ignoreRoleIds: string[];
  defaultAuthorKind: string;
}

/** jsonb columns come back as a parsed array (node-postgres) or, defensively, a JSON string. */
function asIdArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Read the guild's classification config (outside RLS, like the rest of discord_links). */
async function loadGuildRoleConfig(guildId: string): Promise<GuildRoleConfig | null> {
  const r = await relayPool.query(
    `SELECT team_role_ids, responder_role_ids, ignore_role_ids, default_author_kind
       FROM discord_links WHERE guild_id = $1`,
    [guildId],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  return {
    teamRoleIds: asIdArray(row.team_role_ids),
    responderRoleIds: asIdArray(row.responder_role_ids),
    ignoreRoleIds: asIdArray(row.ignore_role_ids),
    defaultAuthorKind: (row.default_author_kind as string) ?? "customer",
  };
}

/** The explicit team mark: a Discord user id registered as a teammate → their Noola user id.
 *  Exported for the ops-mirror (reaction triage "assign to me" + responder gates). */
export async function resolveTeammate(tenantId: string, discordUserId: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT user_id FROM agent_channel_identities
         WHERE channel_type = 'discord' AND lower(external_id) = lower($1) LIMIT 1`,
      [discordUserId],
    );
    return r.rowCount ? (r.rows[0].user_id as string) : null;
  });
}

/** Resolve the guild default_author_kind → a classification (the lowest-precedence tier). */
function defaultClassification(kind: string): DiscordAuthorClassification {
  if (kind === "community") return { action: "ingest", authorType: "agent", authorKind: "community", authorId: null };
  if (kind === "agent") return { action: "ingest", authorType: "agent", authorKind: "agent", authorId: null };
  return { action: "ingest", authorType: "customer", authorKind: "customer", authorId: null };
}

export async function classifyDiscordAuthor(input: {
  tenantId: string;
  guildId: string;
  authorId: string;
  roleIds: string[];
}): Promise<DiscordAuthorClassification> {
  // (1) Explicit mark — a registered teammate outranks any role/default (they might also carry a
  //     community role, or have emailed in as a contact; the mark is the source of truth).
  const teammate = await resolveTeammate(input.tenantId, input.authorId);
  if (teammate) return { action: "ingest", authorType: "agent", authorKind: "agent", authorId: teammate };

  const cfg = await loadGuildRoleConfig(input.guildId);
  if (!cfg) return defaultClassification("customer");

  // (2) Role inference — team > community > ignore (a genuine teammate/responder is never silently
  //     dropped by also holding an ignore role). A team-role member with no registered seat is still
  //     an agent (AI stands down) but has no resolvable Noola user id.
  const roles = new Set(input.roleIds);
  if (cfg.teamRoleIds.some((id) => roles.has(id)))
    return { action: "ingest", authorType: "agent", authorKind: "agent", authorId: null };
  if (cfg.responderRoleIds.some((id) => roles.has(id)))
    return { action: "ingest", authorType: "agent", authorKind: "community", authorId: null };
  if (cfg.ignoreRoleIds.some((id) => roles.has(id)))
    return { action: "drop", authorType: "agent", authorKind: "agent", authorId: null };

  // (3) Channel default.
  return defaultClassification(cfg.defaultAuthorKind);
}

/**
 * Console/command seam (§9) — set a guild's role→classification mapping. Runs on relayPool because
 * discord_links is deliberately outside RLS (tenant is scoped by the guild_id + a tenant guard so a
 * caller can only touch their own link).
 */
export async function setDiscordClassification(
  guildId: string,
  tenantId: string,
  cfg: { teamRoleIds?: string[]; responderRoleIds?: string[]; ignoreRoleIds?: string[]; defaultAuthorKind?: string },
): Promise<boolean> {
  const r = await relayPool.query(
    `UPDATE discord_links
        SET team_role_ids      = COALESCE($3::jsonb, team_role_ids),
            responder_role_ids = COALESCE($4::jsonb, responder_role_ids),
            ignore_role_ids    = COALESCE($5::jsonb, ignore_role_ids),
            default_author_kind = COALESCE($6, default_author_kind)
      WHERE guild_id = $1 AND tenant_id = $2`,
    [
      guildId,
      tenantId,
      cfg.teamRoleIds ? JSON.stringify(cfg.teamRoleIds) : null,
      cfg.responderRoleIds ? JSON.stringify(cfg.responderRoleIds) : null,
      cfg.ignoreRoleIds ? JSON.stringify(cfg.ignoreRoleIds) : null,
      cfg.defaultAuthorKind ?? null,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Console/command seam (§9) — mark a Discord user as a teammate (maps their Discord id → a Noola
 * user seat). Idempotent on the (tenant, channel, external id) unique index. RLS-scoped (app_user).
 */
export async function upsertAgentChannelIdentity(
  tenantId: string,
  userId: string,
  externalId: string,
  channelType = "discord",
): Promise<void> {
  await withTenant(tenantId, async (c) => {
    // One identity per (user, channel): replacing a member's Discord id drops the old row first,
    // and the unique handle index means claiming another member's id steals it (last write wins).
    await c.query(
      "DELETE FROM agent_channel_identities WHERE user_id = $1 AND channel_type = $2",
      [userId, channelType],
    );
    await c.query(
      `INSERT INTO agent_channel_identities (tenant_id, user_id, channel_type, external_id)
         VALUES (current_tenant(), $1, $2, $3)
       ON CONFLICT (tenant_id, channel_type, lower(external_id))
       DO UPDATE SET user_id = EXCLUDED.user_id`,
      [userId, channelType, externalId],
    );
  });
}

/** Unmark a teammate's channel identity (Settings → Members "clear Discord ID"). */
export async function removeAgentChannelIdentity(
  tenantId: string,
  userId: string,
  channelType = "discord",
): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      "DELETE FROM agent_channel_identities WHERE user_id = $1 AND channel_type = $2",
      [userId, channelType],
    );
  });
}

/** The tenant's user→external-id marks for one channel (Settings → Members roster merge). */
export async function listAgentChannelIdentities(
  tenantId: string,
  channelType = "discord",
): Promise<Array<{ userId: string; externalId: string }>> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT user_id, external_id FROM agent_channel_identities WHERE channel_type = $1",
      [channelType],
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      userId: x.user_id as string,
      externalId: x.external_id as string,
    }));
  });
}
