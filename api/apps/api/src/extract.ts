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

// The embedder (all-MiniLM-L6-v2) reads about the first 1000 characters of a passage, so a longer section is split.
const SECTION_TARGET_CHARS = 1000;
// A section shorter than this joins the next subsection or sibling.
const SECTION_MIN_CHARS = 250;

interface MarkdownBlock {
  text: string;
  /** A closed fenced code block, which is never split. */
  fence?: boolean;
  heading?: { level: number; title: string };
}

/** Paragraphs and fenced code blocks in order, with each heading line as its own block. */
function markdownBlocks(md: string): MarkdownBlock[] {
  const out: MarkdownBlock[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = (isFence = false) => {
    const t = buf.join("\n").trim();
    if (t) out.push(isFence ? { text: t, fence: true } : { text: t });
    buf = [];
  };
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (fence) {
      buf.push(line);
      if (line.trim().startsWith(fence)) {
        fence = null;
        flush(true);
      }
      continue;
    }
    const opening = line.trim().match(/^(```+|~~~+)/);
    if (opening) {
      flush();
      fence = opening[1];
      buf.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      flush();
      out.push({ text: line.trim(), heading: { level: heading[1].length, title: heading[2].replace(/[`*]/g, "") } });
      continue;
    }
    if (!line.trim()) flush();
    else buf.push(line);
  }
  // An unclosed fence is split like text, so a stray opener can't make the rest of the page one passage.
  flush();
  return out;
}

/** Pieces of at most SECTION_TARGET_CHARS, cut at the last space in the second half of the limit, else at the limit. */
function hardSplit(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > SECTION_TARGET_CHARS) {
    const space = rest.lastIndexOf(" ", SECTION_TARGET_CHARS);
    const cut = space > SECTION_TARGET_CHARS / 2 ? space : SECTION_TARGET_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A paragraph longer than SECTION_TARGET_CHARS, cut between lines, or between sentences when it is one line. */
function splitBlock(text: string): string[] {
  if (text.length <= SECTION_TARGET_CHARS) return [text];
  const sep = text.includes("\n") ? "\n" : " ";
  const units = (sep === "\n" ? text.split("\n") : text.split(/(?<=[.!?])\s+/)).flatMap(hardSplit);
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > SECTION_TARGET_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}${sep}${u}` : u;
  }
  if (cur) out.push(cur);
  return out;
}

const PATH_SEP = " › ";
const parentPath = (path: string) => path.split(PATH_SEP).slice(0, -1).join(PATH_SEP);
/** `path` as seen from `base`, which is one of its ancestors or the empty root. */
const relativePath = (path: string, base: string) => (base ? path.slice(base.length + PATH_SEP.length) : path);

/**
 * Passages of a Markdown document, one section at a time, each led by its heading path.
 * A long section is split between paragraphs, and a short one takes in the next subsection or sibling.
 * Each section that joins a passage is introduced by its path relative to the passage's path.
 */
export function chunkSections(md: string): string[] {
  const stack: Array<{ level: number; title: string }> = [];
  const sections: Array<{ path: string; body: string[] }> = [];
  let cur: { path: string; level: number; body: string[] } = { path: "", level: 0, body: [] };
  for (const b of markdownBlocks(md)) {
    if (b.heading) {
      // A heading with no body before a deeper heading is kept only in that heading's path. Otherwise it stays a section.
      if (cur.body.length || (cur.path && b.heading.level <= cur.level)) sections.push(cur);
      while (stack.length && stack[stack.length - 1].level >= b.heading.level) stack.pop();
      stack.push(b.heading);
      cur = { path: stack.map((h) => h.title).join(PATH_SEP), level: b.heading.level, body: [] };
      continue;
    }
    cur.body.push(...(b.fence ? [b.text] : splitBlock(b.text)));
  }
  if (cur.body.length || cur.path) sections.push(cur);

  const passages: string[] = [];
  const emit = (p: { path: string; text: string }) => {
    const out = [p.path, p.text].filter(Boolean).join("\n\n");
    if (out) passages.push(out);
  };
  let pending: { path: string; text: string } | null = null;
  for (const s of sections) {
    let text = "";
    for (const para of s.body) {
      if (text && text.length + para.length + 2 > SECTION_TARGET_CHARS) {
        if (pending) emit(pending);
        pending = null;
        emit({ path: s.path, text });
        text = "";
      }
      text = text ? `${text}\n\n${para}` : para;
    }
    if (pending) {
      const child: boolean = !pending.path || s.path.startsWith(`${pending.path}${PATH_SEP}`);
      const base: string = child ? pending.path : parentPath(pending.path);
      const sibling = !child && parentPath(s.path) === base;
      const label = relativePath(s.path, base);
      if ((child || sibling) && pending.text.length + text.length + label.length + 4 <= SECTION_TARGET_CHARS) {
        const before: string = child ? pending.text : [relativePath(pending.path, base), pending.text].filter(Boolean).join("\n\n");
        pending = { path: base, text: [before, label, text].filter(Boolean).join("\n\n") };
        if (pending.text.length >= SECTION_MIN_CHARS) {
          emit(pending);
          pending = null;
        }
        continue;
      }
      emit(pending);
      pending = null;
    }
    if (text.length < SECTION_MIN_CHARS) pending = { path: s.path, text };
    else emit({ path: s.path, text });
  }
  if (pending) emit(pending);
  return passages;
}

/** Passages of a document: a Markdown document with headings by sections, any other by paragraphs. */
export function chunkDocument(text: string, contentType: string): string[] {
  const sections = contentType.startsWith("text/markdown") && markdownBlocks(text).some((b) => b.heading);
  return sections ? chunkSections(text) : chunkText(text);
}
