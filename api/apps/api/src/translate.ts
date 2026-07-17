import { withTenant } from "@repo/db";
import { resolveModelDriver } from "./modelconfig.js";
import { detectLanguage, localeName, updateTicketLocale } from "./locale.js";

// Wave 4: conversational reach — auto-translation. Bridges the customer's language and the
// workspace's, in both directions:
//   • inbound  — a foreign customer message is translated FOR the agent (stored on the message so
//                the thread shows it instantly, with a "translated from X" badge + show-original).
//   • outbound — the agent's reply is translated back INTO the customer's language on send, so what
//                the channel delivers is in the customer's tongue while the thread keeps the original.
//
// Translation runs through the tenant's own model driver (modelconfig.resolveModelDriver → optional
// complete()). When no hosted model is configured — the rule baseline, air-gapped, or FORCE_RULE_MODEL
// — complete() is absent and every helper here degrades to a no-op (returns null): detection + the
// language breakdown still work, nothing is ever mistranslated, and tests stay deterministic.

export interface TranslationSettings {
  /** The workspace's own language (ISO-639-1). Agent-facing text is rendered in this. */
  workspaceLocale: string;
  /** Master switch for both translation directions. Detection + analytics run regardless. */
  autoTranslate: boolean;
  updatedAt: string | null;
}

/** The translation counterpart stored on a message's meta.translation. `text` is the OTHER-language
 *  rendering of `message.body`; `agentFacing` says which of the two the agent should read by default
 *  ("text" for an inbound foreign message we translated for them; "body" for an outbound reply whose
 *  original the agent wrote and whose `text` is what the customer received). */
export interface MessageTranslation {
  text: string;
  from: string;
  to: string;
  agentFacing: "body" | "text";
}

const DEFAULTS: TranslationSettings = { workspaceLocale: "en", autoTranslate: false, updatedAt: null };

export async function getTranslationSettings(tenantId: string): Promise<TranslationSettings> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT workspace_locale, auto_translate, updated_at FROM translation_settings WHERE tenant_id = current_tenant()",
    );
    if (!r.rowCount) return DEFAULTS;
    const row = r.rows[0];
    return {
      workspaceLocale: row.workspace_locale as string,
      autoTranslate: row.auto_translate as boolean,
      updatedAt: (row.updated_at as Date | null)?.toISOString() ?? null,
    };
  });
}

export async function putTranslationSettings(
  tenantId: string,
  input: { workspaceLocale: string; autoTranslate: boolean },
): Promise<TranslationSettings> {
  const locale = input.workspaceLocale.trim().toLowerCase();
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO translation_settings (tenant_id, workspace_locale, auto_translate, updated_at)
         VALUES (current_tenant(), $1, $2, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET workspace_locale = EXCLUDED.workspace_locale,
             auto_translate   = EXCLUDED.auto_translate,
             updated_at       = now()
       RETURNING workspace_locale, auto_translate, updated_at`,
      [locale, input.autoTranslate],
    );
    const row = r.rows[0];
    return {
      workspaceLocale: row.workspace_locale as string,
      autoTranslate: row.auto_translate as boolean,
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  });
}

/**
 * Translate `text` from one language to another through the tenant's model driver. Returns null when
 * translation isn't possible or isn't needed: same language, empty input, or no hosted model (the
 * rule baseline has no complete() — honest no-op). A model error also returns null so a translation
 * failure degrades to the untranslated original, never breaks the surrounding operation.
 */
export async function translateText(
  tenantId: string,
  text: string,
  from: string,
  to: string,
): Promise<string | null> {
  const body = (text ?? "").trim();
  if (!body || from === to) return null;
  const driver = await resolveModelDriver(tenantId);
  if (!driver.complete) return null; // extractive baseline / air-gapped → no translation
  const system =
    `You are a professional translation engine for a customer-support tool. Translate the user's ` +
    `message from ${localeName(from)} to ${localeName(to)}. Preserve meaning, tone, names, URLs, ` +
    `code and formatting. Output ONLY the translation — no notes, no quotes, no preamble.`;
  try {
    const out = (await driver.complete(system, body)).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Merge a translation onto a message's meta (JSONB), leaving any existing keys intact. */
async function stampMessageTranslation(
  tenantId: string,
  messageId: string,
  translation: MessageTranslation,
): Promise<void> {
  await withTenant(tenantId, (c) =>
    c.query(
      "UPDATE messages SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('translation', $2::jsonb) WHERE id = $1",
      [messageId, JSON.stringify(translation)],
    ),
  );
}

/**
 * Post-commit hook for an inbound customer message (called fire-and-forget from ingest). Always
 * detects + stamps the ticket locale; then, when auto-translate is on and the customer's language
 * differs from the workspace's, translates the message FOR the agent and stores it on the message so
 * the thread renders the agent-language version with a show-original toggle. Best-effort throughout.
 */
export async function processInboundLanguage(
  tenantId: string,
  ticketId: string,
  messageId: string,
  body: string,
): Promise<void> {
  try {
    const locale = await updateTicketLocale(tenantId, ticketId, body);
    if (!locale) return;
    const settings = await getTranslationSettings(tenantId);
    if (!settings.autoTranslate || locale === settings.workspaceLocale) return;
    const translated = await translateText(tenantId, body, locale, settings.workspaceLocale);
    if (!translated) return;
    await stampMessageTranslation(tenantId, messageId, {
      text: translated,
      from: locale,
      to: settings.workspaceLocale,
      agentFacing: "text",
    });
  } catch {
    /* translation is advisory — never affect ingest */
  }
}

/**
 * Prepare an agent reply for delivery to the customer's channel. When auto-translate is on and the
 * ticket is in another language, returns the reply translated INTO the customer's language as
 * `dispatchBody` (what the channel should actually send) plus the `meta` to stamp on the stored
 * agent message so the thread shows "sent in X". When translation doesn't apply, dispatchBody is the
 * original and meta is null. The stored message body always stays the agent's original words.
 */
export async function translateOutboundReply(
  tenantId: string,
  ticketId: string,
  body: string,
): Promise<{ dispatchBody: string; meta: MessageTranslation | null }> {
  try {
    const settings = await getTranslationSettings(tenantId);
    if (!settings.autoTranslate) return { dispatchBody: body, meta: null };
    const locale = await withTenant(tenantId, (c) =>
      c.query("SELECT locale FROM tickets WHERE id = $1", [ticketId]),
    ).then((r) => (r.rows[0]?.locale as string | null) ?? null);
    if (!locale || locale === settings.workspaceLocale) return { dispatchBody: body, meta: null };
    const translated = await translateText(tenantId, body, settings.workspaceLocale, locale);
    if (!translated) return { dispatchBody: body, meta: null };
    return {
      dispatchBody: translated,
      meta: { text: translated, from: settings.workspaceLocale, to: locale, agentFacing: "body" },
    };
  } catch {
    return { dispatchBody: body, meta: null };
  }
}

/** Stamp an already-persisted agent message with the outbound translation meta (post-reply). */
export async function stampOutboundTranslation(
  tenantId: string,
  messageId: string,
  meta: MessageTranslation,
): Promise<void> {
  try {
    await stampMessageTranslation(tenantId, messageId, meta);
  } catch {
    /* advisory */
  }
}

// Re-export so callers that already import from translate.js get the naming helpers without a
// second import line.
export { detectLanguage, localeName };
