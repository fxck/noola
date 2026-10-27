/**
 * Normalize blockquote line boundaries so a quote and the text around it stay SEPARATE blocks.
 *
 * Discord (and people typing quickly) write per-line `>` quotes with no blank line before the answer
 * that follows — "quote the question, answer below". The Lexical markdown importer folds a non-`>`
 * line that directly follows a `>` line INTO the quote (previous-sibling merge), and absorbs a later
 * `>` block into the same quote too — so the whole message renders as one big italic blockquote and
 * `quote / text / quote / text` can't render as distinct blocks.
 *
 * Inserting a blank line at each quote↔non-quote boundary makes each run its own block. Meaning-
 * preserving; consecutive `>` lines stay one quote; fenced code is left untouched. (Kept in sync with
 * the backend `normalizeBlockquotes` in api/apps/api/src/channels/format.ts.)
 */
export function normalizeBlockquotes(md: string): string {
  if (!md || !md.includes(">")) return md;
  const isFence = (l: string) => /^\s*(```|~~~)/.test(l);
  const isQuote = (l: string) => /^\s*>/.test(l);
  const isBlank = (l: string) => l.trim() === "";
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (isFence(line)) inFence = !inFence;
    if (!inFence) {
      const prev = out.length ? out[out.length - 1] : null;
      if (prev !== null && !isBlank(prev) && !isBlank(line) && isQuote(prev) !== isQuote(line)) {
        out.push("");
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

// A bare http(s) URL. Trailing punctuation stays outside, so "see https://x.io." links only the address.
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"'`]*[^\s<>()[\]"'`.,;:!?]/g;
// A URL in angle brackets, which Discord uses to post a link without a preview.
const BRACKETED_URL_RE = /<(https?:\/\/[^\s<>]+)>/g;
/** A URL swapped out of markdown by `extractUrls`, as `\uE000<index>\uE001`. */
export const URL_PLACEHOLDER_RE = /\uE000(\d+)\uE001/g;

/** `md` with fenced code, inline code and existing links swapped for placeholders that `restore` puts back. */
function protectSpans(md: string): { text: string; restore: (s: string) => string } {
  const kept: string[] = [];
  const keep = (m: string) => `\u0000${kept.push(m) - 1}\u0000`;
  const text = md
    .replace(/```[\s\S]*?(?:```|$)/g, keep)
    .replace(/`[^`\n]+`/g, keep)
    .replace(/\[[^\]\n[]*\]\([^)\s[\]]+(?:\s"(?:[^"\n]|\\")*"\s*)?\)/g, keep);
  // A kept link can hold kept inline code, so a restored span is restored again.
  const restore = (s: string): string => s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => restore(kept[Number(i)]));
  return { text, restore };
}

/**
 * Markdown with each bare or bracketed URL outside code and existing links swapped for a placeholder.
 * The markdown importer applies emphasis before links, so a URL like .../__tests__ must not go through it.
 */
export function extractUrls(md: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  if (!md || !md.includes("http")) return { text: md, urls };
  const hold = (url: string) => `\uE000${urls.push(url) - 1}\uE001`;
  const { text, restore } = protectSpans(md);
  return { text: restore(text.replace(BRACKETED_URL_RE, (_, url: string) => hold(url)).replace(URL_RE, hold)), urls };
}

/** Slack's mrkdwn as markdown: `<url|text>` links, `*bold*`, `~strike~` and its escaped `<`, `>` and `&`. */
export function slackToMarkdown(text: string): string {
  if (!text) return text;
  const { text: t, restore } = protectSpans(text);
  return restore(
    t
      .replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/g, (_, url: string, label: string) => `[${label}](${url})`)
      .replace(/<((?:https?|mailto):[^|>\s]+)>/g, "$1")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1**$2**")
      .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?:;])/g, "$1~~$2~~")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  );
}

/** Plain text split into text and URL pieces, for rendering a message that isn't markdown. */
export function splitLinks(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[0], url: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
