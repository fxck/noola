import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { TRANSFORMERS } from "@lexical/markdown";
import type { Klass, LexicalNode } from "lexical";

/**
 * The node set shared by the editor and the read-only renderer, so an author's
 * output and a reader's render are the exact same tree — no "looks different in
 * preview" gap. Bodies are stored as Markdown (portable, degrades to plain text,
 * and every legacy plain-string body is already valid Markdown).
 */
export const EDITOR_NODES: ReadonlyArray<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
];

export const MD_TRANSFORMERS = TRANSFORMERS;

/**
 * One editorial type treatment, applied identically to the editable surface and
 * to ArticleBody so the live editor and the rendered article are pixel-identical.
 * A chosen reading register (Dropbox-Paper/Medium): tight heading tracking, a
 * comfortable ~16px body on relaxed leading, real paragraph rhythm, quiet list
 * markers, restrained (never-amber) links, monospace for code. The base font
 * size lives on the container wrappers (see RichTextEditor + ArticleBody) — both
 * set `text-base leading-relaxed`, so the two surfaces share one scale.
 */
export const editorTheme = {
  paragraph: "mb-4 leading-relaxed",
  quote: "my-5 border-l-2 border-border pl-4 italic text-muted-foreground",
  heading: {
    h1: "mb-4 mt-8 text-2xl font-semibold tracking-tight first:mt-0",
    h2: "mb-3 mt-7 text-xl font-semibold tracking-tight first:mt-0",
    h3: "mb-2 mt-6 text-lg font-semibold tracking-tight first:mt-0",
  },
  list: {
    ul: "mb-4 ml-5 list-disc space-y-1.5 marker:text-muted-foreground",
    ol: "mb-4 ml-5 list-decimal space-y-1.5 marker:text-muted-foreground",
    listitem: "leading-relaxed",
    nested: { listitem: "list-none" },
  },
  // Restrained link tone — a quiet ink that resolves to full foreground on hover.
  // Amber is reserved signal, never link paint.
  link: "text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground",
  code: "my-4 block overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm leading-relaxed",
  text: {
    bold: "font-semibold",
    italic: "italic",
    underline: "underline underline-offset-2",
    strikethrough: "line-through",
    code: "rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]",
  },
};

export function onEditorError(error: unknown) {
  // A malformed transform must never take down the surrounding surface.
  // eslint-disable-next-line no-console
  console.error("[editor]", error);
}
