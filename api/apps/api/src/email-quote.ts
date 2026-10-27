// Inbound email quote + signature stripping. A customer reply arrives with the ENTIRE
// thread the sender's mail client quoted back — our previous message, its footer and
// signature, the "On <date> … wrote:" attribution, nested `>` marks. We persist only what
// the customer actually typed THIS time (the "visible" fragment) and stash the removed
// remainder on messages.meta.quoted, so a UI can offer a "show quoted text" expander
// (Gmail's ···) without ever losing the original.
//
// No ML and no DOM dependency — pure heuristics, informed by Mailgun's Talon and GitHub's
// email_reply_parser, extended to the locales this workspace actually sees (EN/DE/FR/ES/IT/
// PT/NL/CS/PL). Two entry paths converge on ONE line-based cut:
//   • plaintext part present → cut the plaintext directly (the cleanest signal);
//   • only an HTML part      → excise the known client quote CONTAINERS structurally,
//                              flatten to text, then run the same line cut as a safety net.
//
// Top-posting (the reply sits ABOVE the quote) is assumed — the near-universal convention.
// A cut that would leave nothing visible is REFUSED (we keep the original body), so a bare
// forward, a bottom-poster, or an interleaved reply is never blanked to an empty message.

export interface StripResult {
  /** What the customer wrote this turn — the body we persist + show. */
  visible: string;
  /** The quoted history + signature we removed, or null when there was nothing to strip.
   *  Stashed on messages.meta.quoted for an optional "show quoted text" expander. */
  quoted: string | null;
}

// ---- attribution ("On … wrote:") ---------------------------------------------------------
// The verb that CLOSES an attribution line, per locale. Kept loose on trailing punctuation
// because clients vary ("wrote:", "a écrit :", "napsal(a):").
const ATTRIBUTION_VERB =
  "(?:wrote|sent|schrieb|a\\s+écrit|escribió|ha\\s+scritto|escreveu|schreef|" +
  "napsal(?:a|\\(a\\))?|napisał(?:a|\\(a\\))?|pisze|написал(?:а)?)";
// The leader that OPENS one, per locale (On/Am/Le/El/Il/Em/Op/Dne/W dniu/В).
const ATTRIBUTION_LEAD = "(?:On|Am|Le|El|Il|Em|Op|Den|Dne|W\\s+dniu|В)";
// A whole attribution on one logical line: leader … a date digit … verb … closing colon. The
// verb may sit MID-line (German "Am … schrieb <name>:") or at the end (English "… wrote:"), so
// we only anchor the trailing colon. The required digit (a date/time) stops a plain sentence
// like "On the other hand, I wrote:" from false-positiving.
const ATTRIBUTION_RE = new RegExp(
  `^\\s*${ATTRIBUTION_LEAD}\\b.*\\d.*\\b${ATTRIBUTION_VERB}\\b.*:\\s*$`,
  "i",
);

// ---- single-line cut markers -------------------------------------------------------------
// Outlook/Apple "-----Original Message-----" and its localized twins, and "Forwarded message".
const DIVIDER_RE = new RegExp(
  "^\\s*-{2,}\\s*(?:" +
    "Original\\s+Message|Ursprüngliche\\s+Nachricht|Původní\\s+zpráva|Message\\s+d'origine|" +
    "Mensaje\\s+original|Messaggio\\s+originale|Oorspronkelijk\\s+bericht|Wiadomo(?:ś|s)ć\\s+oryginalna|" +
    "Forwarded\\s+message|Weitergeleitete\\s+Nachricht|Message\\s+transféré" +
    ")\\s*-{2,}\\s*$",
  "i",
);
// "Begin forwarded message:" (Apple Mail) and its German/French forms.
const FORWARD_RE = /^\s*(?:Begin forwarded message|Anfang der weitergeleiteten Nachricht|Début du message transféré)\s*:?\s*$/i;
// A lone line of underscores — Outlook's reply divider that precedes the From/Sent/To header block.
const UNDERSCORE_RE = /^\s*_{5,}\s*$/;
// Our OWN outbound footer, quoted back to us — a reliable backstop when nothing else matches.
const OWN_FOOTER_RE = /^\s*Reply to this email to continue the conversation\.\s*$/i;
// The RFC-3676 signature delimiter ("-- " on its own line) — cut the sender's trailing sig.
const SIG_DELIM_RE = /^--\s?$/;

// ---- forwarded/quoted header block (Outlook, no dashes) ----------------------------------
// A run of "From:/Sent:/To:/Subject:/…" lines. Localized keys included. We only treat it as a
// cut when ≥2 stack up AND one is an originator key (From/Von/De/Od) — so a stray "Subject:"
// in a customer's own prose never trips it.
const HEADER_LINE_RE = new RegExp(
  "^\\s*(From|To|Sent|Date|Subject|Cc|Reply-To|" +
    "Von|An|Gesendet|Betreff|Datum|" + // de
    "De|Envoyé|À|Objet|Pour|" + // fr
    "Para|Enviado|Asunto|" + // es/pt
    "Od|Komu|Odesláno|Předmět|Datum" + // cs
    ")\\s*:",
  "i",
);
const HEADER_ORIGINATOR_RE = /^\s*(From|Von|De|Od)\s*:/i;

/** True when the ≤3-line block starting at `lines[i]` reads as a "… wrote:" attribution.
 *  Handles the common wrap where the address is on one line and "wrote:" on the next. */
function isAttributionAt(lines: string[], i: number): boolean {
  let joined = lines[i]?.trim() ?? "";
  if (ATTRIBUTION_RE.test(joined)) return true;
  for (let k = 1; k <= 2 && i + k < lines.length; k++) {
    joined = `${joined} ${lines[i + k].trim()}`.trim();
    if (ATTRIBUTION_RE.test(joined)) return true;
    // Stop growing the window once a blank line breaks the block.
    if (!lines[i + k].trim()) break;
  }
  return false;
}

/** Index of the first line that begins the quoted region, or -1 if the body is all-visible. */
function findCutLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    // A `>`-quoted line: the classic marker. First one wins (top-post assumption).
    if (/^\s*>/.test(line)) return i;
    if (DIVIDER_RE.test(line) || FORWARD_RE.test(t) || UNDERSCORE_RE.test(line) || OWN_FOOTER_RE.test(line)) return i;
    if (isAttributionAt(lines, i)) return i;
    // Header block: this line + the next are both header-ish and at least one names a sender.
    if (i + 1 < lines.length && HEADER_LINE_RE.test(line) && HEADER_LINE_RE.test(lines[i + 1]) &&
        (HEADER_ORIGINATOR_RE.test(line) || HEADER_ORIGINATOR_RE.test(lines[i + 1]))) {
      return i;
    }
  }
  return -1;
}

/** Trim a trailing "-- " signature block off the visible fragment, returning the removed sig. */
function splitSignature(lines: string[]): { body: string[]; sig: string[] } {
  // Only look in the tail — a "-- " early in a short message is almost certainly real content.
  for (let i = Math.max(0, lines.length - 12); i < lines.length; i++) {
    if (SIG_DELIM_RE.test(lines[i])) return { body: lines.slice(0, i), sig: lines.slice(i) };
  }
  return { body: lines, sig: [] };
}

/** Core line-based cut, shared by the plaintext and (post-flatten) HTML paths. */
function stripPlainText(text: string): StripResult {
  if (!text || !text.trim()) return { visible: text ?? "", quoted: null };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cut = findCutLine(lines);

  let visibleLines = cut === -1 ? lines : lines.slice(0, cut);
  const quotedLines = cut === -1 ? [] : lines.slice(cut);

  const { body, sig } = splitSignature(visibleLines);
  visibleLines = body;

  const visible = visibleLines.join("\n").trim();
  // Refuse a cut that erases the whole message (bare forward / bottom-poster / lone quote).
  if (!visible) return { visible: text.trim(), quoted: null };

  const quoted = [...sig, ...quotedLines].join("\n").trim();
  return { visible, quoted: quoted || null };
}

// ---- HTML path ---------------------------------------------------------------------------
// Earliest-wins markers for the client-specific quote CONTAINER. In a top-posted reply the
// quote is a trailing subtree, so cutting the HTML string from the first marker to the end
// excises it whole without needing a real DOM. Ordered by nothing — we take the minimum index.
const HTML_QUOTE_MARKERS: RegExp[] = [
  /<blockquote/i, // Apple Mail type="cite", generic replies, gmail_quote blockquote
  /class="?gmail_quote/i, // Gmail wrapper div
  /id="?divRplyFwdMsg/i, // Outlook (desktop) reply/forward header
  /id="?appendonsend/i, // Outlook (web) — content appended below this marker
  /id="?mail-editor-reference-message-container/i, // new Outlook
  /class="?yahoo_quoted/i, // Yahoo Mail
  /class="?moz-cite-prefix/i, // Thunderbird attribution line
  /class="?zmail_extra/i, // Zoho Mail
  /border-top:\s*solid/i, // Outlook's grey rule above the quoted headers
];

/** Split an HTML body at the earliest quote-container marker into { head (visible), tail (quote) }.
 *  The cut backs up to the opening `<` of the marker's tag so we never leave a dangling partial tag. */
function splitQuotedHtml(html: string): { head: string; tail: string } {
  let cut = -1;
  for (const re of HTML_QUOTE_MARKERS) {
    const m = re.exec(html);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut === -1) return { head: html, tail: "" };
  const open = html.lastIndexOf("<", cut); // rewind to the tag boundary
  if (open !== -1) cut = open;
  return { head: html.slice(0, cut), tail: html.slice(cut) };
}

/** Flatten HTML to readable plaintext (shared with the inbound fallback). Block tags become
 *  newlines; scripts/styles and remaining tags are dropped; the common entities are decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip quoted history + signature from an inbound email, preferring the plaintext part and
 * falling back to structural HTML excision. Returns the visible fragment to persist and the
 * removed remainder (or null when nothing was quoted).
 */
export function stripInboundQuote(input: { text?: string | null; html?: string | null }): StripResult {
  const text = input.text ?? "";
  if (text.trim()) return stripPlainText(text);

  const html = input.html ?? "";
  if (html.trim()) {
    // Structural excision of the quote container first, then the same line cut on the flattened
    // head as a safety net (catches an attribution not wrapped in any container we recognize).
    const { head, tail } = splitQuotedHtml(html);
    const cut = stripPlainText(htmlToText(head));
    if (cut.visible.trim()) {
      // meta.quoted = everything both passes removed: the excised container + any line-cut tail.
      const quoted = [cut.quoted, htmlToText(tail)].filter((s) => s && s.trim()).join("\n\n").trim();
      return { visible: cut.visible, quoted: quoted || null };
    }
    // Fell through to empty — keep the full flattened body rather than blank the message.
    return { visible: htmlToText(html), quoted: null };
  }

  return { visible: text, quoted: null };
}
