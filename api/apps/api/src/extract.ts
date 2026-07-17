// Text extraction + chunking — the deterministic front of the ingestion pipeline.
// Text formats (plain / markdown / html) are handled with no heavy deps; binary
// formats (PDF, docx) are rejected here and slot in behind extractText later.

export const SUPPORTED_TYPES = ["text/plain", "text/markdown", "text/html"];

export function isSupported(contentType: string): boolean {
  return SUPPORTED_TYPES.some((t) => contentType.startsWith(t));
}

/** Extract plain text from a supported document. Throws on an unsupported type. */
export function extractText(contentType: string, raw: string): string {
  if (contentType.startsWith("text/html")) {
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  // text/plain and text/markdown: keep as-is (markdown is readable + searchable).
  if (contentType.startsWith("text/")) return raw.trim();
  throw new Error(`unsupported content type: ${contentType}`);
}

/**
 * Split text into overlapping chunks — the retrieval unit. Splits on paragraph
 * boundaries first, packing paragraphs up to ~targetChars, and carries an overlap
 * tail so a passage spanning a boundary is still findable. A single huge paragraph
 * is hard-split. Deterministic (an eval/regression can pin it).
 */
export function chunkText(text: string, targetChars = 900, overlapChars = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = t.length > overlapChars ? t.slice(t.length - overlapChars) : "";
  };

  for (const para of paras) {
    if (para.length > targetChars) {
      if (buf.trim()) flush();
      for (let i = 0; i < para.length; i += targetChars - overlapChars) {
        chunks.push(para.slice(i, i + targetChars).trim());
      }
      buf = "";
      continue;
    }
    if ((buf + "\n\n" + para).length > targetChars) flush();
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  if (buf.trim()) chunks.push(buf.trim());
  // de-dup a possible overlap-only trailing fragment
  return chunks.filter((c, i) => i === 0 || c !== chunks[i - 1]);
}
