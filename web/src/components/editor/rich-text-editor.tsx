import { useCallback, useEffect, useState } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_LOW,
  type TextFormatType,
  type ElementNode,
  type LexicalEditor,
  type EditorState,
} from "lexical";
import {
  $createHeadingNode,
  $isHeadingNode,
  $createQuoteNode,
  $isQuoteNode,
  type HeadingTagType,
} from "@lexical/rich-text";
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
  $isListNode,
} from "@lexical/list";
import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { $isLinkNode } from "@lexical/link";
import { $setBlocksType } from "@lexical/selection";
import { mergeRegister } from "@lexical/utils";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
} from "@lexical/markdown";
import {
  Bold,
  Italic,
  Code,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  Link2,
} from "lucide-react";
import { EDITOR_NODES, MD_TRANSFORMERS, editorTheme, onEditorError } from "./config";
import {
  OPEN_LINK_EDITOR_COMMAND,
  ToolbarButton,
  SelectionToolbar,
  LinkEditorPlugin,
} from "./plugins";
import { cn } from "@/lib/utils";

// The toolbar button primitive, the floating selection bubble, and the anchored
// link card live in ./plugins — shared with the inbox reply composer
// (inbox/chat-composer.tsx) so both surfaces format through one implementation.

// ── toolbar ────────────────────────────────────────────────────────────────
type Block = "paragraph" | "h1" | "h2" | "h3" | "ul" | "ol" | "quote" | "code";

function Toolbar() {
  const [editor] = useLexicalComposerContext();
  const [inline, setInline] = useState({ bold: false, italic: false, code: false });
  const [isLink, setIsLink] = useState(false);
  const [block, setBlock] = useState<Block>("paragraph");

  const sync = useCallback(() => {
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) return;
    setInline({
      bold: sel.hasFormat("bold"),
      italic: sel.hasFormat("italic"),
      code: sel.hasFormat("code"),
    });
    const anchor = sel.anchor.getNode();
    setIsLink($isLinkNode(anchor) || $isLinkNode(anchor.getParent()));
    const el = anchor.getKey() === "root" ? anchor : anchor.getTopLevelElementOrThrow();
    let type: Block = "paragraph";
    if ($isHeadingNode(el)) type = el.getTag() as Block;
    else if ($isListNode(el)) type = el.getListType() === "number" ? "ol" : "ul";
    else if ($isQuoteNode(el)) type = "quote";
    else if ($isCodeNode(el)) type = "code";
    setBlock(type);
  }, []);

  useEffect(
    () =>
      mergeRegister(
        editor.registerUpdateListener(({ editorState }) => editorState.read(sync)),
        editor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          () => {
            sync();
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
      ),
    [editor, sync],
  );

  const format = (f: TextFormatType) => editor.dispatchCommand(FORMAT_TEXT_COMMAND, f);

  const setBlockType = (create: () => ElementNode) =>
    editor.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) $setBlocksType(sel, create);
    });

  const toHeading = (tag: HeadingTagType) =>
    setBlockType(() => (block === tag ? $createParagraphNode() : $createHeadingNode(tag)));
  const toQuote = () =>
    setBlockType(() => (block === "quote" ? $createParagraphNode() : $createQuoteNode()));
  const toCode = () =>
    setBlockType(() => (block === "code" ? $createParagraphNode() : $createCodeNode()));
  const toBullet = () =>
    editor.dispatchCommand(
      block === "ul" ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND,
      undefined,
    );
  const toNumber = () =>
    editor.dispatchCommand(
      block === "ol" ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND,
      undefined,
    );
  const openLink = (e: React.MouseEvent<HTMLButtonElement>) =>
    editor.dispatchCommand(OPEN_LINK_EDITOR_COMMAND, e.currentTarget.getBoundingClientRect());

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b px-2 py-1.5">
      <ToolbarButton label="Bold" active={inline.bold} onClick={() => format("bold")}>
        <Bold />
      </ToolbarButton>
      <ToolbarButton label="Italic" active={inline.italic} onClick={() => format("italic")}>
        <Italic />
      </ToolbarButton>
      <ToolbarButton label="Inline code" active={inline.code} onClick={() => format("code")}>
        <Code />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton label="Heading 1" active={block === "h1"} onClick={() => toHeading("h1")}>
        <Heading1 />
      </ToolbarButton>
      <ToolbarButton label="Heading 2" active={block === "h2"} onClick={() => toHeading("h2")}>
        <Heading2 />
      </ToolbarButton>
      <ToolbarButton label="Bulleted list" active={block === "ul"} onClick={toBullet}>
        <List />
      </ToolbarButton>
      <ToolbarButton label="Numbered list" active={block === "ol"} onClick={toNumber}>
        <ListOrdered />
      </ToolbarButton>
      <ToolbarButton label="Quote" active={block === "quote"} onClick={toQuote}>
        <Quote />
      </ToolbarButton>
      <ToolbarButton label="Code block" active={block === "code"} onClick={toCode}>
        <SquareCode />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton label="Insert link" active={isLink} onClick={openLink}>
        <Link2 />
      </ToolbarButton>
    </div>
  );
}

// ── editor ───────────────────────────────────────────────────────────────────
/**
 * A Dropbox-Paper/Medium-grade rich-text editor on installed Lexical. Type
 * Markdown shortcuts (`## `, `- `, `> `, ``` ) or use the toolbar; content is
 * serialized to Markdown via {@link onChange}. Read the same Markdown back with
 * <ArticleBody> for a pixel-identical render.
 */
export function RichTextEditor({
  initialMarkdown = "",
  onChange,
  placeholder = "Write…",
  ariaLabel = "Editor",
  autoFocus = false,
  fill = false,
  toolbar = true,
  minHeight = 240,
  className,
}: {
  initialMarkdown?: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  /** Fill the parent's height (flex child) instead of sizing to content. */
  fill?: boolean;
  /** Hide the fixed toolbar (fullscreen document mode — the selection toolbar
   *  and markdown shortcuts carry formatting). */
  toolbar?: boolean;
  minHeight?: number;
  className?: string;
}) {
  const initialConfig = {
    namespace: "noola-rich",
    theme: editorTheme,
    nodes: [...EDITOR_NODES],
    onError: onEditorError,
    editorState: () => $convertFromMarkdownString(initialMarkdown, MD_TRANSFORMERS),
  };

  const handleChange = useCallback(
    (_state: EditorState, editor: LexicalEditor) => {
      if (!onChange) return;
      editor.read(() => onChange($convertToMarkdownString(MD_TRANSFORMERS)));
    },
    [onChange],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      {/* Borderless document canvas — the writing surface reads as a page, not a
          boxed input. The only chrome is the toolbar's own bottom hairline. */}
      <div
        className={cn("flex flex-col bg-background", fill && "min-h-0 flex-1", className)}
      >
        {toolbar && <Toolbar />}
        <div className={cn("relative", fill ? "min-h-0 flex-1 overflow-y-auto" : "")}>
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                aria-label={ariaLabel}
                // Cap the measure to ~72ch and center it so long lines don't sprawl.
                className={cn(
                  "mx-auto w-full max-w-[72ch] px-6 py-6 text-base leading-relaxed focus:outline-none",
                  fill && "h-full",
                )}
                style={fill ? undefined : { minHeight }}
              />
            }
            placeholder={
              <div className="pointer-events-none absolute inset-x-0 top-6">
                <div className="mx-auto w-full max-w-[72ch] px-6 text-base text-muted-foreground">
                  {placeholder}
                </div>
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <ListPlugin />
          <LinkPlugin />
          <MarkdownShortcutPlugin transformers={MD_TRANSFORMERS} />
          <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
          <SelectionToolbar />
          <LinkEditorPlugin />
          {autoFocus && <AutoFocusPlugin />}
        </div>
      </div>
    </LexicalComposer>
  );
}
