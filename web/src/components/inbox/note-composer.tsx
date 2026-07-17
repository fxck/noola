import { useEffect } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $nodesOfType,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type EditorState,
} from "lexical";
import { MentionNode } from "./lexical/mention-node";
import { MentionsPlugin, type MentionCandidate } from "./lexical/mentions-plugin";
import { cn } from "@/lib/utils";

export interface NoteDraft {
  text: string;
  /** De-duped member ids from the mention chips — the authoritative loop-in list. */
  mentionIds: string[];
}

/** ⌘/Ctrl+Enter submits; plain Enter is a newline (notes are multi-line). When the
 *  mention menu is open, its own higher-priority Enter handler selects the option first. */
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

/** Clears the editor whenever `resetKey` changes (ticket switch, or after a note is sent). */
function ResetPlugin({ resetKey }: { resetKey: string | number }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.update(() => {
      $getRoot().clear();
    });
  }, [editor, resetKey]);
  return null;
}

export function NoteComposer({
  members,
  resetKey,
  placeholder,
  onChange,
  onSubmit,
}: {
  members: MentionCandidate[];
  resetKey: string | number;
  placeholder: string;
  onChange: (draft: NoteDraft) => void;
  onSubmit: () => void;
}) {
  function handleChange(state: EditorState) {
    state.read(() => {
      const text = $getRoot().getTextContent();
      const ids = Array.from(new Set($nodesOfType(MentionNode).map((n) => n.getMentionId())));
      onChange({ text, mentionIds: ids });
    });
  }

  return (
    <LexicalComposer
      initialConfig={{
        namespace: "noola-note",
        nodes: [MentionNode],
        theme: {},
        onError: (error) => {
          // Never let an editor error take down the composer — surface it, keep typing.
          console.error("[note-composer]", error);
        },
      }}
    >
      <div className="relative rounded-md border border-warning/40 bg-warning/5 focus-within:ring-2 focus-within:ring-warning/30">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Internal note"
              className={cn(
                // 3.625rem + the wrapper's 1px top/bottom borders = 3.75rem — the reply
                // Textarea's rest height, so the mode toggle never shifts the composer.
                "max-h-48 min-h-[3.625rem] w-full overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm",
                "text-foreground outline-none",
              )}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-3 top-2 select-none text-sm text-muted-foreground">
              {placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <AutoFocusPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        <MentionsPlugin members={members} />
        <SubmitPlugin onSubmit={onSubmit} />
        <ResetPlugin resetKey={resetKey} />
      </div>
    </LexicalComposer>
  );
}
