import { api } from "@/lib/api";

// Email templates — the tenant's designed "stationery" for outbound email
// (broadcasts, and later replies). Two read-only built-ins ("branded",
// "personal") ship with full token sets; custom templates are tenant rows
// storing PARTIAL tokens that the server merges over the branded defaults at
// render time. The designer edits tokens and previews server-rendered HTML.

/** One footer social link — label + destination. The server caps the list at 6. */
export interface SocialLink {
  label: string;
  url: string;
}

/** The designable knobs of an email template. ALL optional — an absent token
 *  falls back to the branded default server-side. Colors are hex strings
 *  (#rgb…#rrggbbaa); sizes are bounded ints (px). */
export interface EmailTemplateTokens {
  // Frame — the page behind the card, and the card itself.
  bodyBackground?: string;
  cardBackground?: string;
  borderColor?: string;
  /** Card corner radius, 0–32. */
  borderRadius?: number;
  /** false = a plain letter without card chrome. */
  showCard?: boolean;
  // Typography.
  fontFamily?: string;
  textColor?: string;
  mutedColor?: string;
  /** Link/accent color. */
  linkColor?: string;
  // Sizes (px): subject 14–40, h1 12–40, h2 11–32, paragraph 11–24, small 9–18.
  h1Size?: number;
  h2Size?: number;
  paragraphSize?: number;
  smallSize?: number;
  subjectSize?: number;
  // Header.
  /** Render the subject as an in-body headline. */
  showSubject?: boolean;
  /** Header wordmark text (max 60) — empty string hides the header. */
  wordmark?: string;
  /** When set, an image replaces the wordmark text. */
  logoUrl?: string;
  // Footer.
  footerText?: string;
  socialLinks?: SocialLink[];
}

export interface EmailTemplate {
  id: string;
  name: string;
  /** Built-ins ("branded", "personal") are read-only — duplicate to customize. */
  builtin: boolean;
  tokens: EmailTemplateTokens;
  /** Custom rows only (built-ins never carry it). At most ONE template per
   *  tenant is flagged — its design tokens restyle the ticket-reply email
   *  frame; with none flagged, replies wear the stock "personal" look. */
  useForReplies?: boolean;
  /** Present on custom rows only — built-ins have no edit history. */
  updated_at?: string;
}

export async function fetchEmailTemplates(): Promise<EmailTemplate[]> {
  return (await api<{ templates: EmailTemplate[] }>("/email-templates")).templates;
}

export async function createEmailTemplate(input: {
  name: string;
  tokens?: EmailTemplateTokens;
}): Promise<EmailTemplate> {
  const res = await api<{ template: EmailTemplate }>("/email-templates", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return res.template;
}

export async function updateEmailTemplate(
  id: string,
  patch: {
    name?: string;
    tokens?: EmailTemplateTokens;
    /** Flagging one template un-flags any other — single per tenant, server-enforced. */
    useForReplies?: boolean;
  },
): Promise<EmailTemplate> {
  const res = await api<{ template: EmailTemplate }>(`/email-templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return res.template;
}

export async function deleteEmailTemplate(id: string): Promise<void> {
  await api<{ ok: true }>(`/email-templates/${id}`, { method: "DELETE" });
}

/** Server-rendered preview. `tokens` (partial fine) carries live unsaved
 *  designer state and wins over `templateId`; subject/body are optional —
 *  the server supplies good sample copy. The html is a full document meant
 *  for an <iframe sandbox srcDoc>. */
export async function previewEmailTemplate(input: {
  tokens?: EmailTemplateTokens;
  templateId?: string;
  subject?: string;
  body?: string;
}): Promise<{ html: string; text: string }> {
  return api<{ html: string; text: string }>("/email-templates/preview", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
