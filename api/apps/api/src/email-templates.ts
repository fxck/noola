import { withTenant } from "@repo/db";
import { EmailTemplateTokens } from "@repo/contracts";

// Email template designer — per-tenant DESIGN TOKENS that parameterize the react.email
// frame (emails/broadcast-email.tsx). Two built-ins live in code: 'branded' (the card
// frame broadcasts always had) and 'personal' (the plain letter the reply email uses);
// custom templates are tenant rows cloned from either. resolveTemplateTokens is the one
// read path the send loop and the preview endpoint share, so what the designer shows IS
// what ships.

export interface EmailTemplateRow {
  id: string;
  name: string;
  tokens: EmailTemplateTokens;
  use_for_replies: boolean;
  created_at: string;
  updated_at: string;
}

/** A template as the API lists it — built-ins carry their slug as id and builtin=true. */
export interface EmailTemplateView {
  id: string;
  name: string;
  builtin: boolean;
  tokens: Required<EmailTemplateTokens> | EmailTemplateTokens;
  /** This template frames ticket replies (at most one per tenant; built-ins can't be flagged —
   *  no flagged row = the stock personal frame). */
  useForReplies?: boolean;
  updated_at?: string; // custom rows only — built-ins have no edit history
}

const COLS = "id, name, tokens, use_for_replies, created_at, updated_at";

/** The 'branded' frame — every token has a value here; custom/partial tokens merge over it. */
export const BRANDED_TOKENS: Required<EmailTemplateTokens> = {
  bodyBackground: "#f4f4f5",
  cardBackground: "#ffffff",
  borderColor: "#e4e4e7",
  borderRadius: 12,
  showCard: true,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  textColor: "#18181b",
  mutedColor: "#71717a",
  linkColor: "#e8a33d",
  h1Size: 20,
  h2Size: 17,
  paragraphSize: 15,
  smallSize: 12,
  subjectSize: 22,
  showSubject: true,
  wordmark: "Noola",
  logoUrl: "",
  footerText: "You received this because you're a contact of this workspace.",
  socialLinks: [],
};

/** The 'personal' frame — a plain letter: no card, no wordmark, no in-body subject. */
export const PERSONAL_TOKENS: Required<EmailTemplateTokens> = {
  ...BRANDED_TOKENS,
  bodyBackground: "#ffffff",
  showCard: false,
  showSubject: false,
  wordmark: "",
};

const BUILTINS: { id: string; name: string; tokens: Required<EmailTemplateTokens> }[] = [
  { id: "branded", name: "Branded", tokens: BRANDED_TOKENS },
  { id: "personal", name: "Personal", tokens: PERSONAL_TOKENS },
];

export function isBuiltinTemplate(id: string): boolean {
  return BUILTINS.some((b) => b.id === id);
}

/** Merge partial designer tokens over the branded base so the renderer always sees a full set. */
export function mergeTokens(partial: EmailTemplateTokens | null | undefined): Required<EmailTemplateTokens> {
  const parsed = EmailTemplateTokens.safeParse(partial ?? {});
  return { ...BRANDED_TOKENS, ...(parsed.success ? parsed.data : {}) };
}

/** All templates the tenant can pick: the two built-ins, then custom rows (newest first). */
export async function listTemplates(tenantId: string): Promise<EmailTemplateView[]> {
  const custom = await withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM email_templates ORDER BY created_at DESC LIMIT 100`);
    return r.rows as EmailTemplateRow[];
  });
  return [
    ...BUILTINS.map((b) => ({ id: b.id, name: b.name, builtin: true, tokens: b.tokens })),
    ...custom.map((t) => ({ id: t.id, name: t.name, builtin: false, tokens: t.tokens, useForReplies: t.use_for_replies, updated_at: t.updated_at })),
  ];
}

export async function createTemplate(
  tenantId: string,
  input: { name: string; tokens?: EmailTemplateTokens },
): Promise<EmailTemplateRow> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO email_templates (tenant_id, name, tokens)
       VALUES (current_tenant(), $1, $2::jsonb) RETURNING ${COLS}`,
      [input.name, JSON.stringify(input.tokens ?? {})],
    );
    return r.rows[0] as EmailTemplateRow;
  });
}

export async function updateTemplate(
  tenantId: string,
  id: string,
  patch: { name?: string; tokens?: EmailTemplateTokens; useForReplies?: boolean },
): Promise<EmailTemplateRow | null> {
  return withTenant(tenantId, async (c) => {
    // Single reply frame per tenant (partial unique index): flagging one un-flags the rest
    // in the same txn so the constraint never fires mid-flight.
    if (patch.useForReplies === true) {
      await c.query("UPDATE email_templates SET use_for_replies = false WHERE use_for_replies AND id <> $1", [id]);
    }
    const r = await c.query(
      `UPDATE email_templates
          SET name = COALESCE($2, name),
              tokens = COALESCE($3::jsonb, tokens),
              use_for_replies = COALESCE($4, use_for_replies),
              updated_at = now()
        WHERE id = $1
      RETURNING ${COLS}`,
      [id, patch.name ?? null, patch.tokens === undefined ? null : JSON.stringify(patch.tokens), patch.useForReplies ?? null],
    );
    return r.rowCount ? (r.rows[0] as EmailTemplateRow) : null;
  });
}

/** The reply frame's tokens: the tenant's flagged template merged over the PERSONAL base
 *  (replies stay letter-like unless the design says otherwise), or null = stock personal
 *  frame (renderReplyEmail's built-in look, zero DB reads on the common path is NOT worth
 *  a cache here — one indexed row read per outbound reply). */
export async function getReplyTemplateTokens(tenantId: string): Promise<Required<EmailTemplateTokens> | null> {
  const row = await withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT tokens FROM email_templates WHERE use_for_replies LIMIT 1");
    return r.rowCount ? (r.rows[0].tokens as EmailTemplateTokens) : null;
  });
  if (!row) return null;
  const parsed = EmailTemplateTokens.safeParse(row);
  return { ...PERSONAL_TOKENS, ...(parsed.success ? parsed.data : {}) };
}

export async function deleteTemplate(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM email_templates WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** Whether a templateId names something pickable for this tenant (built-in slug or custom row). */
export async function templateExists(tenantId: string, id: string): Promise<boolean> {
  if (isBuiltinTemplate(id)) return true;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT 1 FROM email_templates WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** The send/preview read path: a built-in's full tokens, or a custom row's tokens merged over
 *  the branded base. Unknown/deleted ids degrade to 'branded' — a stale template_id must
 *  never block a send. */
export async function resolveTemplateTokens(
  tenantId: string,
  templateId: string | null | undefined,
): Promise<Required<EmailTemplateTokens>> {
  const builtin = BUILTINS.find((b) => b.id === (templateId ?? "branded"));
  if (builtin) return builtin.tokens;
  if (!templateId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(templateId)) {
    return BRANDED_TOKENS;
  }
  const row = await withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT tokens FROM email_templates WHERE id = $1", [templateId]);
    return r.rowCount ? (r.rows[0].tokens as EmailTemplateTokens) : null;
  });
  return mergeTokens(row);
}
