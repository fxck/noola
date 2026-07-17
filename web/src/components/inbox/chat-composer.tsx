import { useCallback, useEffect, useImperativeHandle, type Ref } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  BLUR_COMMAND,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_HIGH,
  type LexicalEditor,
  type EditorState,
} from "lexical";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { EDITOR_NODES, MD_TRANSFORMERS, editorTheme, onEditorError } from "@/components/editor/config";
import { SelectionToolbar, LinkEditorPlugin } from "@/components/editor/plugins";
import { cn } from "@/lib/utils";

// The inbox reply composer's rich-text input: the same Lexical node set +
// markdown pipeline as the document editor (a reply IS markdown, rendered back
// by MessageBubble's <ArticleBody>), but at chat scale and chat chrome —
// borderless like the Textarea it replaced, quiet until you engage it. Formatting
// is FLOATING like the KB editor's clean mode (rich-text-editor.tsx toolbar=false):
// the selection bubble + anchored link card + markdown shortcuts carry it, with NO
// persistent format row — so the composer keeps a fixed rest height and the
// Reply ↔ Internal note toggle never moves under the cursor.

// Chat-scale block overrides — keep in sync with BUBBLE_MD in message-bubble.tsx
// so what the agent types is what the sent bubble renders. editorTheme assumes
// document scale (mb-4 paragraphs, display headings); these descendant rules
// out-rank its direct classes and pull everything down to text-sm rhythm.
const CHAT_MD =
  "[&_p]:mb-2 [&_p]:leading-relaxed [&_p:last-child]:mb-0 " +
  "[&_ol]:mb-2 [&_ul]:mb-2 [&_ol:last-child]:mb-0 [&_ul:last-child]:mb-0 " +
  "[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold " +
  "[&_h1]:my-2 [&_h2]:my-2 [&_h3]:my-2 [&_blockquote]:my-2 [&_pre]:my-2 [&_code]:text-xs";

export interface ChatComposerHandle {
  focus(): void;
  /** Replace the whole draft with `md` (AI draft, queue-draft edit). */
  setMarkdown(md: string): void;
  /** Append `md` below the existing draft as new paragraphs (macro insert). */
  insertMarkdown(md: string): void;
}

/** ⌘/Ctrl+Enter submits; plain Enter is a newline (replies are multi-line). */
function SubmitPlugin({ onSubmit }: { onSubmit: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (event && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSubmit]);
  return null;
}

/** Clears the editor whenever `resetKey` changes (ticket switch, or after send). */
function ResetPlugin({ resetKey }: { resetKey: string | number }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.update(() => {
      // Rebuild from empty markdown (not root.clear()) so the rich-text tree
      // keeps its required trailing paragraph.
      $convertFromMarkdownString("", MD_TRANSFORMERS);
    });
  }, [editor, resetKey]);
  return null;
}

/** Paste: files (a screenshot, a dragged-in copy) become pending attachments via
 *  `onFiles` instead of dumping binary junk into the draft; text/HTML pastes fall
 *  through to Lexical's own rich-paste handling — pasting formatted content and
 *  keeping its structure is a feature. */
function PasteFilesPlugin({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent)) return false;
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        onFiles(files);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onFiles]);
  return null;
}

/** Relays editor blur to the parent (typing-presence clears on blur). */
function BlurPlugin({ onBlur }: { onBlur?: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          onBlur?.();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, onBlur],
  );
  return null;
}

/** Keeps the editor's editable flag in step with the `disabled` prop. */
function EditablePlugin({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(!disabled);
  }, [editor, disabled]);
  return null;
}

/** Wires the imperative handle the parent composer drives: macros append,
 *  AI drafts / queue-draft edits replace. Both go through the markdown pipeline
 *  (same $convertFromMarkdownString semantics as initial state), then land the
 *  caret at the end and focus so the agent keeps typing. */
function HandlePlugin({ handle }: { handle?: Ref<ChatComposerHandle> }) {
  const [editor] = useLexicalComposerContext();
  useImperativeHandle(
    handle,
    () => {
      const load = (md: string) => {
        editor.update(() => {
          $convertFromMarkdownString(md, MD_TRANSFORMERS);
          $getRoot().selectEnd();
        });
        editor.focus();
      };
      return {
        focus: () => editor.focus(),
        setMarkdown: load,
        insertMarkdown: (md: string) => {
          editor.update(() => {
            // Fill an empty draft, else append below as new paragraphs — the
            // same contract the old textarea's insertMacro had.
            const cur = $convertToMarkdownString(MD_TRANSFORMERS);
            $convertFromMarkdownString(cur.trim() ? `${cur.trimEnd()}\n\n${md}` : md, MD_TRANSFORMERS);
            $getRoot().selectEnd();
          });
          editor.focus();
        },
      };
    },
    [editor],
  );
  return null;
}

/**
 * The reply-mode rich composer: Intercom-grade formatting in the same footprint
 * as the plain textarea it replaced. Serializes to markdown on every change —
 * the parent keeps `body` as a plain markdown mirror, so send/macros/AI-draft
 * plumbing is unchanged. Formatting comes three ways: markdown shortcuts while
 * typing, the selection bubble over selected text, and the format row below.
 */
export function ChatComposer({
  resetKey,
  placeholder,
  disabled = false,
  onChange,
  onSubmit,
  onFiles,
  onBlur,
  ref,
}: {
  resetKey: string | number;
  placeholder: string;
  disabled?: boolean;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
  onFiles: (files: File[]) => void;
  onBlur?: () => void;
  ref?: Ref<ChatComposerHandle>;
}) {
  const handleChange = useCallback(
    (_state: EditorState, editor: LexicalEditor) => {
      editor.read(() => onChange($convertToMarkdownString(MD_TRANSFORMERS)));
    },
    [onChange],
  );

  return (
    <LexicalComposer
      initialConfig={{
        namespace: "noola-reply",
        theme: editorTheme,
        nodes: [...EDITOR_NODES],
        onError: onEditorError,
        editable: !disabled,
      }}
    >
      <div className={cn("flex flex-col", disabled && "opacity-50")}>
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                aria-label="Reply"
                // REST HEIGHT 3.75rem: min-h-[3.75rem] is border-box, so the py-2
                // padding + one text-sm/leading-relaxed line (~2.42rem) sit inside
                // it and the min-h wins. The wrapper adds no border/padding and there
                // is NO persistent format row (formatting floats — selection bubble +
                // markdown shortcuts), so the ChatComposer rests at exactly 3.75rem in
                // every state — NoteComposer's 3.625rem content + 1px wrapper borders —
                // and the Reply ↔ Internal note toggle never shifts under the cursor.
                className={cn(
                  "max-h-[40vh] min-h-[3.75rem] w-full overflow-y-auto break-words bg-transparent px-1 py-2",
                  "text-sm leading-relaxed text-foreground outline-none",
                  CHAT_MD,
                )}
              />
            }
            placeholder={
              <div className="pointer-events-none absolute left-1 top-2 select-none text-sm text-muted-foreground">
                {placeholder}
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
          <SubmitPlugin onSubmit={onSubmit} />
          <ResetPlugin resetKey={resetKey} />
          <PasteFilesPlugin onFiles={onFiles} />
          <BlurPlugin onBlur={onBlur} />
          <EditablePlugin disabled={disabled} />
          <HandlePlugin handle={ref} />
        </div>
      </div>
    </LexicalComposer>
  );
}
