import { useMemo, type MouseEvent } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { EDITOR_NODES, editorTheme, onEditorError } from "./config";
import { $importMarkdown } from "./import-markdown";
import { cn } from "@/lib/utils";

// Cheap stable key so the read-only tree re-initializes when the body changes
// (LexicalComposer only reads initialConfig once on mount).
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Opens a clicked http(s) or mailto link in a new tab, so following a link in a message keeps the inbox open. */
function openLinkInNewTab(e: MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
}

/**
 * Renders authored Markdown as real formatted structure — the read twin of
 * {@link RichTextEditor}, using the identical node set + type theme so author
 * output and reader render match exactly. Read-only Lexical builds a DOM tree
 * (not innerHTML), so there's no HTML-injection surface even on the public help
 * center. For empty bodies, render your own placeholder instead of this.
 * With `messageLinks`, bare URLs become links and every link opens in a new tab.
 */
export function ArticleBody({ markdown, className, messageLinks = false }: { markdown: string; className?: string; messageLinks?: boolean }) {
  const key = useMemo(() => hash(markdown), [markdown]);
  const initialConfig = useMemo(
    () => ({
      namespace: "noola-article",
      editable: false,
      theme: editorTheme,
      nodes: [...EDITOR_NODES],
      onError: onEditorError,
      editorState: () => $importMarkdown(markdown, messageLinks),
    }),
    [markdown, messageLinks],
  );

  return (
    <div className={cn("text-base leading-relaxed text-foreground", className)} onClick={messageLinks ? openLinkInNewTab : undefined}>
      <LexicalComposer key={key} initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={<ContentEditable readOnly className="focus:outline-none" />}
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </LexicalComposer>
    </div>
  );
}
