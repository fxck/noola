// Per-channel markdown adaptation. Agents and broadcasts author ONE body in markdown
// (Discord-flavored: **bold**, _italic_, [text](url), lists, code). Discord renders that
// natively; every other chat surface has its own syntax, so each driver adapts at its send
// seam — the LAST hop before the wire, which also covers ticket replies, autoreplies, and
// broadcasts in one place. Transforms are conservative line-oriented regexes: plain text
// passes through unchanged, and code spans/fences are protected from the inline rules.

// Slot sentinel for protecting code from the inline rules. NUL can't occur in user text
// (Postgres text rejects it long before this), so restore never collides with real content.
const SLOT = "\u0000";

/** Split out code fences/inline code so inline transforms never rewrite code. */
function protectCode(md: string): { text: string; restore: (s: string) => string } {
  const slots: string[] = [];
  const text = md.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    slots.push(m);
    return `${SLOT}${slots.length - 1}${SLOT}`;
  });
  return { text, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? "") };
}

/** Inline rules shared by the transforms. Order is load-bearing: the SINGLE-marker italic
 *  rules run FIRST — they can't match a double marker (the char after `*` is `*`, rejected),
 *  but if bold ran first its OUTPUT (e.g. Slack `*bold*`) would be re-matched as italic. */
function applyInline(
  s: string,
  m: {
    bold: (t: string) => string;
    italic: (t: string) => string;
    strike: (t: string) => string;
    link: (t: string, u: string) => string;
  },
): string {
  return s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => m.link(t, u))
    .replace(/~~([^~\n]+)~~/g, (_, t) => m.strike(t))
    .replace(/(^|[\s(])\*([^\s*][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, (_, pre, t) => `${pre}${m.italic(t)}`)
    .replace(/(^|[\s(])_([^\s_][^_\n]*?)_(?=[\s).,!?:;]|$)/g, (_, pre, t) => `${pre}${m.italic(t)}`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, t) => m.bold(t))
    .replace(/__([^_\n]+)__/g, (_, t) => m.bold(t));
}

/** Headings become bold lines; the marker itself never survives to a chat surface. */
function headingsToBold(s: string, bold: (t: string) => string): string {
  return s.replace(/^#{1,6}\s+(.+)$/gm, (_, t) => bold(t));
}

const bullets = (s: string): string => s.replace(/^(\s*)[-*]\s+/gm, "$1• ");

/** Slack mrkdwn: *bold*, _italic_, ~strike~, <url|text> links, • bullets. Slack renders
 *  ` and ``` natively, so protected code restores verbatim. */
export function mdToSlack(md: string): string {
  const { text, restore } = protectCode(md);
  let s = applyInline(text, {
    bold: (t) => `*${t}*`,
    italic: (t) => `_${t}_`,
    strike: (t) => `~${t}~`,
    link: (t, u) => `<${u}|${t}>`,
  });
  s = headingsToBold(s, (t) => `*${t}*`);
  return restore(bullets(s));
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram HTML (parse_mode: "HTML") — the safe Telegram target; MarkdownV2's escaping
 *  rules reject too many real-world bodies. Code restores into <pre>/<code>, escaped. */
export function mdToTelegramHtml(md: string): string {
  const { text, restore } = protectCode(md);
  let s = applyInline(escapeHtml(text), {
    bold: (t) => `<b>${t}</b>`,
    italic: (t) => `<i>${t}</i>`,
    strike: (t) => `<s>${t}</s>`,
    link: (t, u) => `<a href="${u}">${t}</a>`,
  });
  s = headingsToBold(s, (t) => `<b>${t}</b>`);
  return restore(bullets(s))
    .replace(/```\w*\n?([\s\S]*?)```/g, (_, code) => `<pre>${escapeHtml(code)}</pre>`)
    .replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
}

/** WhatsApp: *bold*, _italic_, ~strike~; no link markup (label + bare URL); ``` is native,
 *  inline ` folds into ``` (WhatsApp's only code marker is the triple backtick). */
export function mdToWhatsApp(md: string): string {
  const { text, restore } = protectCode(md);
  let s = applyInline(text, {
    bold: (t) => `*${t}*`,
    italic: (t) => `_${t}_`,
    strike: (t) => `~${t}~`,
    link: (t, u) => `${t} (${u})`,
  });
  s = headingsToBold(s, (t) => `*${t}*`);
  return restore(bullets(s)).replace(/`([^`\n]+)`/g, "```$1```");
}

// Discord rejects a single message over 2000 chars (embeds cap the description at 4096). A long
// agent reply or a channel-post broadcast must go out as several ordered messages instead of being
// truncated or 400'd. splitForDiscord chunks a body under `limit`, preferring the LEAST disruptive
// break: paragraph boundary, then line boundary, then a hard slice — and it never splits inside a
// ```code fence``` (a fence carried across two messages renders as broken code on both). This is the
// Discord send seam's own concern; the mdTo* transforms above are untouched, so no other channel is
// affected. A body already under the limit returns as a single-element array (the common case).
export function splitForDiscord(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.length) chunks.push(cur.replace(/\n+$/, ""));
    cur = "";
  };
  const push = (piece: string) => {
    // A fence boundary would land mid-message: if adding this block overflows and we already have
    // content, start a fresh message so a ``` block is never split across two.
    if (cur.length && cur.length + piece.length + 2 > limit) flush();
    cur = cur.length ? `${cur}\n\n${piece}` : piece;
  };
  // Split on blank lines first (paragraphs / whole fences — the code-protect regex keeps a fence
  // in one block since it has no blank line between its ``` markers in normal authoring).
  for (const para of text.split(/\n{2,}/)) {
    if (para.length <= limit) {
      push(para);
      continue;
    }
    // An oversized paragraph (a giant fence or a wall of one-per-line list items): break on lines,
    // then hard-slice any single line still over the limit.
    flush();
    let line = "";
    for (const ln of para.split("\n")) {
      const seg = ln.length <= limit ? [ln] : (ln.match(new RegExp(`.{1,${limit}}`, "g")) ?? [ln]);
      for (const s of seg) {
        if (line.length && line.length + s.length + 1 > limit) {
          chunks.push(line);
          line = "";
        }
        line = line.length ? `${line}\n${s}` : s;
      }
    }
    if (line.length) chunks.push(line);
  }
  flush();
  return chunks.filter((c) => c.length);
}

/** Plain text: strip every marker (SMS-like surfaces, fallbacks). */
export function mdToPlain(md: string): string {
  const { text, restore } = protectCode(md);
  let s = applyInline(text, {
    bold: (t) => t,
    italic: (t) => t,
    strike: (t) => t,
    link: (t, u) => `${t} (${u})`,
  });
  s = headingsToBold(s, (t) => t);
  return restore(bullets(s))
    .replace(/```\w*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}
