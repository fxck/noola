import { useMemo } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { EDITOR_NODES, MD_TRANSFORMERS, editorTheme, onEditorError } from "./config";
import { cn } from "@/lib/utils";

// Cheap stable key so the read-only tree re-initializes when the body changes
// (LexicalComposer only reads initialConfig once on mount).
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Renders authored Markdown as real formatted structure — the read twin of
 * {@link RichTextEditor}, using the identical node set + type theme so author
 * output and reader render match exactly. Read-only Lexical builds a DOM tree
 * (not innerHTML), so there's no HTML-injection surface even on the public help
 * center. For empty bodies, render your own placeholder instead of this.
 */
export function ArticleBody({ markdown, className }: { markdown: string; className?: string }) {
  const key = useMemo(() => hash(markdown), [markdown]);
  const initialConfig = useMemo(
    () => ({
      namespace: "noola-article",
      editable: false,
      theme: editorTheme,
      nodes: [...EDITOR_NODES],
      onError: onEditorError,
      editorState: () => $convertFromMarkdownString(markdown, MD_TRANSFORMERS),
    }),
    [markdown],
  );

  return (
    <div className={cn("text-base leading-relaxed text-foreground", className)}>
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
