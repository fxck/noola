import { relayPool, withTenant } from "@repo/db";
import { encryptSecret, decryptSecret, encryptionAvailable } from "./crypto.js";

// Self-serve channel credentials (0092) — the per-tenant replacement for the operator-env
// Telegram/WhatsApp binding. A tenant connects a channel from Settings → Channels; the creds
// land here (secret via the crypto.ts MODEL_KEY_SECRET seam, same as integrations) and the
// drivers resolve them per tenant with the legacy env pair kept as a dev fallback.
//
//   telegram: config {}            secret { botToken }
//   whatsapp: config { phoneId }   secret { token, verifyToken? }
//
// One connection per channel per tenant (save = replace). CRUD is tenant-scoped under
// FORCE-RLS; the pre-tenant inbound resolution (the Telegram poller iterating bots, WhatsApp
// phone_number_id → tenant) reads across tenants via relayPool — the slack.ts pattern.

export interface ChannelConnectionRow {
  id: string;
  channel: string;
  label: string;
  config: Record<string, unknown>;
  active: boolean;
  hasSecret: boolean;
  createdAt: string;
}

const SELECT = "id, channel, label, config, active, (secret_enc IS NOT NULL) AS has_secret, created_at";

function mapRow(r: Record<string, unknown>): ChannelConnectionRow {
  return {
    id: r.id as string,
    channel: r.channel as string,
    label: (r.label as string) ?? "",
    config: (r.config as Record<string, unknown>) ?? {},
    active: Boolean(r.active),
    hasSecret: Boolean(r.has_secret),
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export async function listChannelConnections(tenantId: string): Promise<ChannelConnectionRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${SELECT} FROM channel_connections ORDER BY channel, created_at DESC`);
    return r.rows.map(mapRow);
  });
}

export class ChannelSecretsUnavailableError extends Error {}

/** Save (replace) a tenant's connection for a channel. Secrets never leave this module in
 *  plaintext once stored — the row exposes only hasSecret. */
export async function saveChannelConnection(
  tenantId: string,
  input: { channel: "telegram" | "whatsapp"; label?: string; config?: Record<string, unknown>; secret: Record<string, string> },
): Promise<ChannelConnectionRow> {
  if (!encryptionAvailable()) {
    throw new ChannelSecretsUnavailableError("MODEL_KEY_SECRET is not set — cannot store channel credentials");
  }
  const secretEnc = encryptSecret(JSON.stringify(input.secret));
  const row = await withTenant(tenantId, async (c) => {
    // Replace semantics: one live connection per channel per tenant.
    await c.query("DELETE FROM channel_connections WHERE channel = $1", [input.channel]);
    const r = await c.query(
      `INSERT INTO channel_connections (tenant_id, channel, label, config, secret_enc)
       VALUES (current_tenant(), $1, $2, $3::jsonb, $4) RETURNING ${SELECT}`,
      [input.channel, input.label ?? "", JSON.stringify(input.config ?? {}), secretEnc],
    );
    return r.rows[0] as Record<string, unknown>;
  });
  bustConnectionCache();
  return mapRow(row);
}

export async function deleteChannelConnection(tenantId: string, id: string): Promise<boolean> {
  const gone = await withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM channel_connections WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
  bustConnectionCache();
  return gone;
}

// ---- pre-tenant reads (pollers + inbound resolution) ------------------------

export interface LiveChannelConnection {
  tenantId: string;
  id: string;
  channel: string;
  config: Record<string, unknown>;
  secret: Record<string, string>;
}

// The Telegram poller hits this every tick — cache the (tiny) full active set briefly so the
// steady-state poll costs no query. Saves/deletes bust it; other instances converge in ≤15s.
let cache: { at: number; rows: LiveChannelConnection[] } | null = null;
const CACHE_MS = 15_000;

export function bustConnectionCache(): void {
  cache = null;
}

export async function activeChannelConnections(channel: string): Promise<LiveChannelConnection[]> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const r = await relayPool.query(
      "SELECT tenant_id, id, channel, config, secret_enc FROM channel_connections WHERE active = true",
    );
    cache = {
      at: Date.now(),
      rows: r.rows.flatMap((row: Record<string, unknown>) => {
        const plain = row.secret_enc ? decryptSecret(row.secret_enc as string) : null;
        let secret: Record<string, string> = {};
        if (plain) {
          try { secret = JSON.parse(plain) as Record<string, string>; } catch { return []; }
        }
        return [{
          tenantId: row.tenant_id as string,
          id: row.id as string,
          channel: row.channel as string,
          config: (row.config as Record<string, unknown>) ?? {},
          secret,
        }];
      }),
    };
  }
  return cache.rows.filter((r) => r.channel === channel);
}

/** A single tenant's live connection for a channel (outbound send path), or null. */
export async function tenantChannelConnection(
  tenantId: string,
  channel: string,
): Promise<LiveChannelConnection | null> {
  const rows = await activeChannelConnections(channel);
  return rows.find((r) => r.tenantId === tenantId) ?? null;
}
