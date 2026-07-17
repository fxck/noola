// NOTE: `React` is imported explicitly (not just for JSX) because the runtime (tsx) resolves the
// monorepo-root tsconfig, which uses the CLASSIC JSX transform (React.createElement) — so React must
// be in scope at runtime even though the api tsconfig sets jsx:react-jsx for typechecking.
import * as React from "react";
import { Body, Container, Head, Hr, Html, Img, Markdown, Section, Text } from "@react-email/components";
import { render } from "@react-email/render";
import type { EmailTemplateTokens } from "@repo/contracts";

// The conversation-reply email — deliberately quieter and more personal than the broadcast frame.
// It should read like a person's email, not a marketing card: no in-body subject headline, just
// the agent's markdown-rendered message, an optional quiet signature, and a restrained footer.
// Token-aware (0072): a tenant can flag one designer template as the reply frame — its font,
// colors, header, card chrome and footer apply here; with none flagged the stock personal look
// below renders (identical to the pre-0072 output). Same dependency-light rules as
// broadcast-email.tsx: no external fonts, styles inline.

const DEFAULTS = {
  bodyBackground: "#ffffff",
  cardBackground: "#ffffff",
  borderColor: "#e4e4e7",
  borderRadius: 12,
  showCard: false,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  textColor: "#18181b",
  mutedColor: "#71717a",
  linkColor: "#e8a33d", // Noola amber
  paragraphSize: 15,
  smallSize: 12,
  wordmark: "",
  logoUrl: "",
  footerText: "",
};

type ReplyTokens = typeof DEFAULTS;

function ReplyEmail({ body, agentName, t }: { body: string; agentName?: string | null; t: ReplyTokens }) {
  const main: React.CSSProperties = {
    backgroundColor: t.bodyBackground,
    fontFamily: t.fontFamily,
    padding: "24px 0",
  };
  const container: React.CSSProperties = { maxWidth: "560px", margin: "0 auto", padding: "0 16px" };
  const card: React.CSSProperties = t.showCard
    ? {
        backgroundColor: t.cardBackground,
        border: `1px solid ${t.borderColor}`,
        borderRadius: `${t.borderRadius}px`,
        padding: "24px",
      }
    : {};
  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          {t.logoUrl ? (
            <Img src={t.logoUrl} alt={t.wordmark || "logo"} height={28} style={{ margin: "0 0 16px" }} />
          ) : t.wordmark ? (
            <Text style={{ fontSize: "14px", fontWeight: 700, color: t.textColor, margin: "0 0 16px" }}>
              {t.wordmark}
            </Text>
          ) : null}
          <Section style={card}>
            <Markdown
              markdownContainerStyles={{ fontSize: `${t.paragraphSize}px`, lineHeight: 1.6, color: t.textColor }}
              markdownCustomStyles={{
                h1: { fontSize: `${t.paragraphSize + 5}px`, fontWeight: 700, color: t.textColor },
                h2: { fontSize: `${t.paragraphSize + 2}px`, fontWeight: 700, color: t.textColor },
                link: { color: t.linkColor },
                p: { fontSize: `${t.paragraphSize}px`, lineHeight: 1.6, color: t.textColor },
                li: { fontSize: `${t.paragraphSize}px`, lineHeight: 1.6, color: t.textColor },
                codeInline: { backgroundColor: "#f4f4f5", borderRadius: "4px", padding: "1px 4px" },
              }}
            >
              {body || "_(no content)_"}
            </Markdown>
            {agentName ? (
              <Text style={{ fontSize: `${t.paragraphSize}px`, color: t.mutedColor, lineHeight: 1.6, margin: "16px 0 0" }}>
                {`— ${agentName}`}
              </Text>
            ) : null}
          </Section>
          <Hr style={{ borderColor: t.borderColor, margin: "24px 0 0" }} />
          <Text style={{ fontSize: `${t.smallSize}px`, color: t.mutedColor, lineHeight: 1.6, margin: "16px 0 0" }}>
            {t.footerText || "Sent with Noola · Reply to this email to continue the conversation."}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

/**
 * Render an agent ticket reply to {html, text}. `text` is the markdown-stripped plaintext
 * alternative so text-only clients still read cleanly. Never throws out to the send path —
 * a render failure is handled by the caller (falls back to the raw markdown body, no HTML).
 * `tokens` (the tenant's flagged reply template, already merged to a full set) restyles the
 * frame; omitted = the stock personal look.
 */
export async function renderReplyEmail(
  body: string,
  opts?: { agentName?: string | null; tokens?: Required<EmailTemplateTokens> | null },
): Promise<{ html: string; text: string }> {
  const tk = opts?.tokens;
  const t: ReplyTokens = tk
    ? {
        bodyBackground: tk.bodyBackground,
        cardBackground: tk.cardBackground,
        borderColor: tk.borderColor,
        borderRadius: tk.borderRadius,
        showCard: tk.showCard,
        fontFamily: tk.fontFamily,
        textColor: tk.textColor,
        mutedColor: tk.mutedColor,
        linkColor: tk.linkColor,
        paragraphSize: tk.paragraphSize,
        smallSize: tk.smallSize,
        wordmark: tk.wordmark,
        logoUrl: tk.logoUrl,
        footerText: tk.footerText,
      }
    : DEFAULTS;
  const el = <ReplyEmail body={body} agentName={opts?.agentName} t={t} />;
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
  return { html, text };
}
