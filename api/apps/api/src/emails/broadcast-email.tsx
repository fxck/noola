// NOTE: `React` is imported explicitly (not just for JSX) because the runtime (tsx) resolves the
// monorepo-root tsconfig, which uses the CLASSIC JSX transform (React.createElement) — so React must
// be in scope at runtime even though the api tsconfig sets jsx:react-jsx for typechecking.
import * as React from "react";
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Markdown,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { Button } from "@react-email/components";
import { render } from "@react-email/render";
import type { BroadcastBlock, EmailTemplateTokens } from "@repo/contracts";
import { BRANDED_TOKENS } from "../email-templates.js";

// The outbound email frame, parameterized by DESIGN TOKENS (email-templates.ts). The user
// authors the body as MARKDOWN; <Markdown> turns it into email-safe inline-styled HTML inside
// the token-driven frame — 'branded' reproduces the classic Noola card, 'personal' a plain
// letter, and custom templates recolor/resize anything between. render() produces BOTH the
// HTML and a markdown-stripped plaintext alternative. Kept dependency-light: no external
// fonts (CSP-safe); the one allowed remote asset is the tenant's own logoUrl.

type Tokens = Required<EmailTemplateTokens>;

/** The markdown styling shared by the whole-body path and text blocks. */
function markdownStyles(t: Tokens) {
  return {
    markdownContainerStyles: { fontSize: `${t.paragraphSize}px`, lineHeight: 1.6, color: t.textColor },
    markdownCustomStyles: {
      h1: { fontSize: `${t.h1Size}px`, fontWeight: 700, color: t.textColor },
      h2: { fontSize: `${t.h2Size}px`, fontWeight: 700, color: t.textColor },
      link: { color: t.linkColor },
      p: { fontSize: `${t.paragraphSize}px`, lineHeight: 1.6, color: t.textColor },
      li: { fontSize: `${t.paragraphSize}px`, lineHeight: 1.6, color: t.textColor },
      codeInline: { backgroundColor: t.bodyBackground, borderRadius: "4px", padding: "1px 4px" },
    },
  } as const;
}

/** One composer block → react.email markup, styled from the template tokens. Merge tags in
 *  the content are left INTACT here — the caller substitutes them per recipient into the
 *  rendered output (one render per broadcast, not per contact). */
function Block({ b, t }: { b: BroadcastBlock; t: Tokens }) {
  const md = markdownStyles(t);
  switch (b.type) {
    case "text":
      return <Markdown {...md}>{b.md || " "}</Markdown>;
    case "image":
      return (
        <Img
          src={b.url}
          alt={b.alt ?? ""}
          width={b.width ?? 496}
          style={{ maxWidth: "100%", borderRadius: "6px", margin: "8px 0" }}
        />
      );
    case "button":
      return (
        <Section style={{ textAlign: (b.align ?? "left") as "left" | "center", margin: "12px 0" }}>
          <Button
            href={b.url}
            style={{
              backgroundColor: t.linkColor,
              color: "#ffffff",
              fontSize: `${t.paragraphSize}px`,
              fontWeight: 600,
              padding: "10px 20px",
              borderRadius: "8px",
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            {b.label}
          </Button>
        </Section>
      );
    case "divider":
      return <Hr style={{ borderColor: t.borderColor, margin: "16px 0" }} />;
    case "spacer":
      return <Section style={{ height: `${b.height ?? 24}px`, lineHeight: `${b.height ?? 24}px` }}>{" "}</Section>;
    case "html":
      // The tenant's own raw HTML escape hatch — email clients are the sandbox here; the
      // in-app preview renders inside a scriptless sandboxed iframe.
      return <div dangerouslySetInnerHTML={{ __html: b.html }} />;
  }
}

function BroadcastEmail({
  subject,
  body,
  blocks,
  t,
  unsubscribeHref,
}: {
  subject: string;
  body: string;
  blocks?: BroadcastBlock[];
  t: Tokens;
  unsubscribeHref?: string;
}) {
  const card: React.CSSProperties = t.showCard
    ? {
        backgroundColor: t.cardBackground,
        borderRadius: `${t.borderRadius}px`,
        border: `1px solid ${t.borderColor}`,
        padding: "32px",
      }
    : {};
  const footerStyle: React.CSSProperties = {
    fontSize: `${t.smallSize}px`,
    color: t.mutedColor,
    lineHeight: 1.6,
    margin: "16px 0 0",
    textAlign: t.showCard ? ("center" as const) : ("left" as const),
  };
  return (
    <Html>
      <Head />
      {subject ? <Preview>{subject}</Preview> : null}
      <Body style={{ backgroundColor: t.bodyBackground, fontFamily: t.fontFamily, padding: "24px 0" }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto", padding: "0 16px" }}>
          {t.logoUrl ? (
            <Img src={t.logoUrl} alt={t.wordmark || "logo"} height={28} style={{ margin: "0 0 16px" }} />
          ) : t.wordmark ? (
            <Text
              style={{
                fontSize: "18px",
                fontWeight: 700,
                color: t.textColor,
                margin: "0 0 16px",
                letterSpacing: "-0.01em",
              }}
            >
              {t.wordmark}
              <span style={{ color: t.linkColor }}>.</span>
            </Text>
          ) : null}
          <Section style={card}>
            {t.showSubject && subject ? (
              <Text
                style={{
                  fontSize: `${t.subjectSize}px`,
                  fontWeight: 700,
                  color: t.textColor,
                  lineHeight: 1.3,
                  margin: "0 0 16px",
                  letterSpacing: "-0.02em",
                }}
              >
                {subject}
              </Text>
            ) : null}
            {blocks?.length ? (
              blocks.map((b, i) => <Block key={i} b={b} t={t} />)
            ) : (
              <Markdown {...markdownStyles(t)}>{body || "_(no content)_"}</Markdown>
            )}
          </Section>
          {t.socialLinks.length > 0 ? (
            <Text style={{ ...footerStyle, margin: "20px 0 0" }}>
              {t.socialLinks.map((s, i) => (
                <React.Fragment key={s.url}>
                  {i > 0 ? " · " : null}
                  <Link href={s.url} style={{ color: t.mutedColor, textDecoration: "underline" }}>
                    {s.label}
                  </Link>
                </React.Fragment>
              ))}
            </Text>
          ) : null}
          <Hr style={{ borderColor: t.borderColor, margin: "24px 0 0" }} />
          <Text style={footerStyle}>
            {`Sent with Noola · ${t.footerText}`}
            {unsubscribeHref ? (
              <>
                {" · "}
                <Link href={unsubscribeHref} style={{ color: t.mutedColor, textDecoration: "underline" }}>
                  Unsubscribe
                </Link>
              </>
            ) : null}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

/**
 * Render a broadcast to {html, text}. Called ONCE per broadcast (subject + body are constant
 * across recipients), then reused for every send. `tokens` is a FULL resolved token set
 * (resolveTemplateTokens / mergeTokens) — defaults to the branded frame. `unsubscribeHref`
 * renders the compliance footer link — the caller passes a PLACEHOLDER and substitutes the
 * per-recipient signed URL into both html and text (avoids a re-render per contact). Never
 * throws out to the send loop — a render failure there is handled by the caller (falls back
 * to the raw markdown body).
 */
export async function renderBroadcastEmail(
  subject: string,
  body: string,
  opts?: { tokens?: EmailTemplateTokens; unsubscribeHref?: string; blocks?: BroadcastBlock[] },
): Promise<{ html: string; text: string }> {
  // Plain merge, no re-validation: tokens were schema-checked at their input boundary
  // (route/CRUD), and re-parsing a resolved set here once silently dropped every custom
  // value when one field (logoUrl: "") failed the stricter parse.
  const t: Tokens = { ...BRANDED_TOKENS, ...(opts?.tokens ?? {}) };
  const el = (
    <BroadcastEmail subject={subject} body={body} blocks={opts?.blocks} t={t} unsubscribeHref={opts?.unsubscribeHref} />
  );
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
  return { html, text };
}
