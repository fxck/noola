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
