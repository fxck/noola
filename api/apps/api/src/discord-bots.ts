// Discord Phase 6 — per-tenant BYO bot registry (mig 0080 discord_bots). Outside RLS like
// discord_links, so all reads/writes go through the BYPASSRLS relay pool with explicit tenant_id
// scoping; the API layer supplies the tenant. Tokens are encrypted at rest with the MODEL_KEY_SECRET
// crypto seam (the same "v1:" blob integrations use). The gateway manager (discord-gateway.ts) reads
// listStartableTenantBots() to decide what to open — but only opens tenant bots when the prod gate is
// on, so a customer's live bot is never double-consumed from a dev/stage replica.
import { relayPool } from "@repo/db";
import { encryptSecret, decryptSecret, encryptionAvailable } from "./crypto.js";

export interface DiscordBotRow {
  id: string;
  tenant_id: string | null;
  label: string | null;
  application_id: string | null;
  bot_user_id: string | null;
  scope: string;
  enabled: boolean;
  disabled_reason: string | null;
  guild_count: number;
  verification_state: string;
  last_ready_at: string | null;
  created_at: string;
}

const PUBLIC_COLS =
  "id, tenant_id, label, application_id, bot_user_id, scope, enabled, disabled_reason, guild_count, verification_state, last_ready_at, created_at";

/** A tenant's registered BYO bots (token never returned). */
export async function listBots(tenantId: string): Promise<DiscordBotRow[]> {
  const r = await relayPool.query(
    `SELECT ${PUBLIC_COLS} FROM discord_bots WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
  );
  return r.rows as DiscordBotRow[];
}

/**
 * Register a tenant's own Discord bot: encrypt the token, and best-effort resolve its application +
 * bot-user id from Discord (marks the row 'verified' when the token authenticates, else 'unverified'
 * — a bad/offline token is still stored, just flagged). Refuses when encryption isn't configured.
 */
export async function registerBot(tenantId: string, input: { label?: string | null; token: string }): Promise<DiscordBotRow> {
  if (!encryptionAvailable()) throw new Error("MODEL_KEY_SECRET not set — cannot store a bot token");
  const token = input.token.trim();
  const enc = encryptSecret(token);

  let appId: string | null = null;
  let botUserId: string | null = null;
  let state = "unverified";
  try {
    const res = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
      headers: { authorization: `Bot ${token}` },
    });
    if (res.ok) {
      const j = (await res.json()) as { id?: string; bot?: { id?: string } };
      appId = j.id ?? null;
      botUserId = j.bot?.id ?? null;
      state = "verified";
    }
  } catch {
    /* offline / bad token — stored unverified, surfaced in the UI */
  }

  const r = await relayPool.query(
    `INSERT INTO discord_bots (tenant_id, label, token_enc, application_id, bot_user_id, scope, enabled, verification_state)
     VALUES ($1, $2, $3, $4, $5, 'tenant', true, $6)
     RETURNING ${PUBLIC_COLS}`,
    [tenantId, input.label ?? null, enc, appId, botUserId, state],
  );
  return r.rows[0] as DiscordBotRow;
}

/** Remove a tenant's bot (tenant-scoped). discord_links.bot_id FK is ON DELETE SET NULL. */
export async function deleteBot(tenantId: string, id: string): Promise<boolean> {
  const r = await relayPool.query("DELETE FROM discord_bots WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
  return (r.rowCount ?? 0) > 0;
}

export interface StartableBot {
  botId: string;
  token: string;
  tenantId: string | null;
  label: string | null;
}

/** Every enabled, non-quarantined tenant bot with a decryptable token — the manager's open-list when
 *  the prod multibot gate is on. A token that fails to decrypt (rotated MODEL_KEY_SECRET) is skipped. */
export async function listStartableTenantBots(): Promise<StartableBot[]> {
  const r = await relayPool.query(
    "SELECT id, tenant_id, label, token_enc FROM discord_bots WHERE scope = 'tenant' AND enabled = true AND disabled_reason IS NULL AND token_enc IS NOT NULL",
  );
  const out: StartableBot[] = [];
  for (const row of r.rows as { id: string; tenant_id: string | null; label: string | null; token_enc: string }[]) {
    const tok = decryptSecret(row.token_enc);
    if (tok) out.push({ botId: row.id, token: tok, tenantId: row.tenant_id, label: row.label });
  }
  return out;
}

/** How many tenant bots are registered + enabled (for the "dormant on dev/stage" boot log). */
export async function countStartableTenantBots(): Promise<number> {
  const r = await relayPool.query(
    "SELECT count(*)::int AS n FROM discord_bots WHERE scope = 'tenant' AND enabled = true AND disabled_reason IS NULL",
  );
  return r.rows[0].n as number;
}

/** Lifecycle observability — the manager stamps these as a bot connects / drops / is quarantined. */
export async function markBotReady(botId: string, guildCount: number): Promise<void> {
  await relayPool
    .query("UPDATE discord_bots SET last_ready_at = now(), guild_count = $2, verification_state = 'ready' WHERE id = $1", [botId, guildCount])
    .catch(() => {});
}
export async function markBotDisconnect(botId: string): Promise<void> {
  await relayPool.query("UPDATE discord_bots SET last_disconnect_at = now() WHERE id = $1", [botId]).catch(() => {});
}
export async function quarantineBot(botId: string, reason: string): Promise<void> {
  await relayPool.query("UPDATE discord_bots SET enabled = false, disabled_reason = $2 WHERE id = $1", [botId, reason]).catch(() => {});
}
