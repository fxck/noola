import { ingestInbound } from "./ingest.js";
import { mdToWhatsApp } from "./channels/format.js";
import { activeChannelConnections, tenantChannelConnection } from "./channel-connections.js";

// Wave 4 — WhatsApp channel (Meta Cloud API); self-serve since 0092. Outbound sends via the
// Graph messages endpoint; inbound arrives on a public webhook (POST) with Meta's GET verify
// handshake. Each tenant connects its OWN number from Settings → Channels (channel_connections,
// config {phoneId} + secret {token, verifyToken}); inbound resolves the tenant by the payload's
// metadata.phone_number_id. The legacy operator env triple (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID /
// WHATSAPP_TENANT_ID + WHATSAPP_VERIFY_TOKEN) survives as a dev fallback.

const GRAPH_API = "https://graph.facebook.com/v20.0";

/** True once the legacy env send credentials are configured (env-fallback gate only). */
export function whatsappConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

interface WaCreds {
  token: string;
  phoneId: string;
}

/** Resolve the Cloud API credentials that speak for a tenant: its connection first, then the
 *  env fallback (when the env binding is this tenant or unbound). */
async function credsForTenant(tenantId: string): Promise<WaCreds | null> {
  const conn = await tenantChannelConnection(tenantId, "whatsapp").catch(() => null);
  const phoneId = conn ? String(conn.config.phoneId ?? "") : "";
  if (conn?.secret.token && phoneId) return { token: conn.secret.token, phoneId };
  const envTenant = process.env.WHATSAPP_TENANT_ID;
  if (whatsappConfigured() && (!envTenant || envTenant === tenantId)) {
    return { token: process.env.WHATSAPP_TOKEN as string, phoneId: process.env.WHATSAPP_PHONE_ID as string };
  }
  return null;
}

/** Send a text message to a WhatsApp number (E.164, no +) as the TENANT's number. Agents author
 *  markdown; WhatsApp bolds with single *asterisks* and has no link markup — adapt at the wire
 *  (channels/format.ts). False when no creds or rejected. */
export async function sendWhatsApp(tenantId: string, to: string, text: string): Promise<boolean> {
  const creds = await credsForTenant(tenantId);
  if (!creds) return false;
  const res = await fetch(`${GRAPH_API}/${creds.phoneId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: mdToWhatsApp(text) } }),
  });
  return res.ok;
}

/** The outbound seam — matches the other route*Outbound drivers so the registry dispatches uniformly. */
export async function routeWhatsAppOutbound(
  routing: { tenantId: string; channelType?: string; externalChannelId?: string | null },
  body: string,
): Promise<{ delivered: boolean; reason?: string }> {
  if (routing.channelType !== "whatsapp" || !routing.externalChannelId) return { delivered: false, reason: "not-whatsapp" };
  try {
    const ok = await sendWhatsApp(routing.tenantId, routing.externalChannelId, body);
    return ok ? { delivered: true } : { delivered: false, reason: "whatsapp-send-failed" };
  } catch (e) {
    return { delivered: false, reason: (e as Error).message };
  }
}

/** Meta's subscription handshake: echo hub.challenge when the verify token matches the env
 *  token OR any connected tenant's verifyToken (Meta verifies the webhook once per app, but
 *  each tenant may have typed its own token — accept any live one). Null → reject with 403. */
export async function verifyWhatsAppChallenge(query: Record<string, unknown>): Promise<string | null> {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || !token) return null;
  if (process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return String(challenge ?? "");
  }
  const rows = await activeChannelConnections("whatsapp").catch(() => []);
  if (rows.some((r) => r.secret.verifyToken && r.secret.verifyToken === token)) {
    return String(challenge ?? "");
  }
  return null;
}

interface WaWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{ id?: string; from?: string; text?: { body?: string } }>;
      };
    }>;
  }>;
}

/** Resolve which tenant a webhook change belongs to: the connection owning the receiving
 *  phone_number_id, else the env-bound tenant. */
async function resolveTenantForChange(phoneId: string | undefined): Promise<string | null> {
  if (phoneId) {
    const rows = await activeChannelConnections("whatsapp").catch(() => []);
    const owner = rows.find((r) => String(r.config.phoneId ?? "") === phoneId);
    if (owner) return owner.tenantId;
  }
  return process.env.WHATSAPP_TENANT_ID || null;
}

/** Parse a Cloud API webhook payload and funnel each text message through the shared inbound core
 *  (idempotent on the WhatsApp message id). Best-effort; unresolvable tenant → dropped. */
export async function handleWhatsAppWebhook(body: WaWebhookBody): Promise<void> {
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const tenantId = await resolveTenantForChange(change.value?.metadata?.phone_number_id);
      if (!tenantId) continue;
      for (const m of change.value?.messages ?? []) {
        const text = m.text?.body;
        if (!text || !m.from) continue;
        await ingestInbound({
          tenantId,
          body: text,
          authorType: "customer",
          idempotencyKey: `whatsapp:${m.id ?? `${m.from}:${text.slice(0, 24)}`}`,
          channelType: "whatsapp",
          externalChannelId: m.from,
          identity: { externalId: m.from, name: null },
          subject: text.slice(0, 80),
        });
      }
    }
  }
}
