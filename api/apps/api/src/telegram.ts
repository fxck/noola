import { ingestInbound, type IngestResult } from "./ingest.js";
import { mdToTelegramHtml, mdToPlain } from "./channels/format.js";
import { activeChannelConnections, tenantChannelConnection } from "./channel-connections.js";

// Wave 4 — Telegram channel; self-serve since 0092. A Bot API driver: outbound sends via
// sendMessage, inbound via a getUpdates long-poll. Each tenant connects its OWN bot from
// Settings → Channels (channel_connections, secret {botToken}); the legacy operator env pair
// (TELEGRAM_BOT_TOKEN + TELEGRAM_TENANT_ID) survives as a dev fallback bot. The poller
// iterates every live bot per tick; per-bot getUpdates offsets live in memory (restart
// re-serves unacked updates and the idempotency key dedupes).

type Log = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

const TELEGRAM_API = "https://api.telegram.org";

interface TgUpdate {
  update_id: number;
  message?: { text?: string; from?: { id?: number; first_name?: string; username?: string }; chat?: { id: number } };
}

/** True once the legacy env bot is configured. Per-tenant connections don't need it — this
 *  only gates the env-fallback path (and the honest env-status line on the Channels page). */
export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

interface TelegramBot {
  tenantId: string;
  token: string;
}

/** Every live bot to poll: each tenant's connected bot + the env fallback pair. Deduped by
 *  token (a token polls once — Telegram getUpdates is per-bot, not per-consumer). */
async function botsToPoll(): Promise<TelegramBot[]> {
  const bots: TelegramBot[] = [];
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envTenant = process.env.TELEGRAM_TENANT_ID;
  if (envToken && envTenant) bots.push({ tenantId: envTenant, token: envToken });
  const rows = await activeChannelConnections("telegram").catch(() => []);
  for (const r of rows) {
    const token = r.secret.botToken;
    if (token && !bots.some((b) => b.token === token)) bots.push({ tenantId: r.tenantId, token });
  }
  return bots;
}

/** Resolve the bot token that speaks for a tenant: its connected bot first, then the env
 *  fallback (when the env binding is this tenant or unbound). */
async function tokenForTenant(tenantId: string): Promise<string | null> {
  const conn = await tenantChannelConnection(tenantId, "telegram").catch(() => null);
  if (conn?.secret.botToken) return conn.secret.botToken;
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envTenant = process.env.TELEGRAM_TENANT_ID;
  if (envToken && (!envTenant || envTenant === tenantId)) return envToken;
  return null;
}

/** Send a text message to a chat as the TENANT's bot. Agents author markdown; Telegram renders
 *  none of it without a parse_mode, so the body goes out as HTML (channels/format.ts). If
 *  Telegram rejects the HTML (unbalanced tags from odd input), retry once as plain text — a
 *  slightly uglier message beats a dropped one. False when no bot or both attempts fail. */
export async function sendTelegram(tenantId: string, chatId: string, text: string): Promise<boolean> {
  const token = await tokenForTenant(tenantId);
  if (!token) return false;
  const base = `${TELEGRAM_API}/bot${token}`;
  const post = (payload: Record<string, unknown>) =>
    fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const res = await post({ chat_id: chatId, text: mdToTelegramHtml(text), parse_mode: "HTML" });
  if (res.ok) return true;
  const retry = await post({ chat_id: chatId, text: mdToPlain(text) });
  return retry.ok;
}

/** The outbound seam — matches the other route*Outbound drivers so the registry dispatches uniformly. */
export async function routeTelegramOutbound(
  routing: { tenantId: string; channelType?: string; externalChannelId?: string | null },
  body: string,
): Promise<{ delivered: boolean; reason?: string }> {
  if (routing.channelType !== "telegram" || !routing.externalChannelId) return { delivered: false, reason: "not-telegram" };
  try {
    const ok = await sendTelegram(routing.tenantId, routing.externalChannelId, body);
    return ok ? { delivered: true } : { delivered: false, reason: "telegram-send-failed" };
  } catch (e) {
    return { delivered: false, reason: (e as Error).message };
  }
}

/** Funnel one Telegram update through the shared inbound core (idempotent on update_id),
 *  onto the tenant whose bot received it. */
export async function handleTelegramUpdate(tenantId: string, update: TgUpdate): Promise<IngestResult | null> {
  const msg = update.message;
  if (!msg?.text || !msg.chat) return null;
  return ingestInbound({
    tenantId,
    body: msg.text,
    authorType: "customer",
    idempotencyKey: `telegram:${update.update_id}`,
    channelType: "telegram",
    externalChannelId: String(msg.chat.id),
    identity: { externalId: String(msg.from?.id ?? msg.chat.id), name: msg.from?.first_name ?? msg.from?.username ?? null },
    subject: msg.text.slice(0, 80),
  });
}

// Per-bot getUpdates offsets, keyed by token — in-memory only (see module header).
const offsets = new Map<string, number>();

/**
 * Poll every live bot for new updates and funnel each inbound message through ingest. A tick
 * with no bots is a cheap no-op (the connection set is cached). Best-effort per bot: one bot's
 * API hiccup logs and skips to the next; advancing its offset past each update acks it.
 */
export async function pollTelegram(log: Log): Promise<void> {
  const bots = await botsToPoll();
  for (const bot of bots) {
    const base = `${TELEGRAM_API}/bot${bot.token}`;
    const offset = offsets.get(bot.token) ?? 0;
    try {
      const res = await fetch(`${base}/getUpdates?timeout=0&offset=${offset}`);
      if (!res.ok) throw new Error(`telegram getUpdates ${res.status}`);
      const data = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
      for (const u of data.result ?? []) {
        offsets.set(bot.token, Math.max(offsets.get(bot.token) ?? 0, u.update_id + 1));
        try {
          await handleTelegramUpdate(bot.tenantId, u);
        } catch (err) {
          log.error({ err, update: u.update_id }, "telegram: inbound ingest failed");
        }
      }
    } catch (err) {
      log.warn({ err }, "telegram: getUpdates failed");
    }
  }
}
