import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  createCommand,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_LOW,
  type LexicalCommand,
  type TextFormatType,
} from "lexical";
import { TOGGLE_LINK_COMMAND, $isLinkNode, type LinkNode } from "@lexical/link";
import { mergeRegister } from "@lexical/utils";
import { Bold, Italic, Code, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Editor plumbing shared by the document editor (rich-text-editor.tsx) and the
// inbox reply composer (inbox/chat-composer.tsx): the toolbar button primitive,
// the floating selection bubble, and the anchored link card. Both surfaces run
// the same node set + markdown pipeline, so the formatting affordances are one
// implementation, not two drifting copies.

// ── link editing ─────────────────────────────────────────────────────────────
// A custom command is the clean cross-component channel: both the fixed toolbar
// and the floating selection bubble dispatch it with the anchor rect they want
// the link card to open against; the LinkEditorPlugin owns the popover itself.
export const OPEN_LINK_EDITOR_COMMAND: LexicalCommand<DOMRect> = createCommand("OPEN_LINK_EDITOR");

/**
 * Normalize what a human typed into a valid href, or `null` to remove the link.
 * Accepts http(s) + mailto as-is, upgrades a bare `user@host` to `mailto:`, and
 * prepends `https://` to a bare domain. Empty → remove.
 */
export function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^(https?:\/\/|mailto:)/i.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  return `https://${v}`;
}

/** Read the URL of the LinkNode the caret sits in (own node or its parent), else "". */
export function $readSelectionLinkUrl(): string {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return "";
  const node = sel.anchor.getNode();
  const link = $isLinkNode(node) ? node : $isLinkNode(node.getParent()) ? node.getParent() : null;
  return link ? (link as LinkNode).getURL() : "";
}

// ── toolbar button ───────────────────────────────────────────────────────────
export function ToolbarButton({
  onClick,
  active,
  label,
  children,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // Keep focus in the editor so the command applies to the live selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        "flex size-7 items-center justify-center rounded transition-[transform,color,background-color] duration-150 ease-[var(--ease-out-strong)] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ── link editor popover (B2) ─────────────────────────────────────────────────
/**
 * Inline anchored link card — replaces the old `window.prompt` flow. Opened by
 * OPEN_LINK_EDITOR_COMMAND (fixed toolbar or the selection bubble), pre-filled
 * with the caret's existing LinkNode URL. Apply normalizes + toggles the link,
 * Remove (or an empty URL) clears it. Scales in from its anchor via `.motion-pop`
 * (origin-top, <180ms, reduced-motion respected); closes on Escape / outside-click.
 */
export function LinkEditorPlugin() {
  const [editor] = useLexicalComposerContext();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      editor.registerCommand(
        OPEN_LINK_EDITOR_COMMAND,
        (rect) => {
          setUrl(editor.getEditorState().read($readSelectionLinkUrl));
          setAnchor(rect);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor],
  );

  const close = useCallback(() => setAnchor(null), []);

  useEffect(() => {
    if (!anchor) return;
    // Focus + select the field once the card is mounted.
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        editor.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [anchor, close, editor]);

  const apply = () => {
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, normalizeUrl(url));
    close();
    editor.focus();
  };
  const remove = () => {
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
    close();
    editor.focus();
  };

  if (!anchor) return null;

  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 316));
  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Edit link"
      style={{ position: "fixed", top: anchor.bottom + 8, left, maxWidth: "calc(100vw - 16px)" }}
      className="motion-pop z-50 flex origin-top items-center gap-1.5 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-lg"
    >
      <Input
        ref={inputRef}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
        placeholder="https://…"
        aria-label="Link URL"
        className="h-8 w-56 text-sm"
      />
      <Button type="button" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={apply}>
        Apply
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onMouseDown={(e) => e.preventDefault()}
        onClick={remove}
      >
        Remove
      </Button>
    </div>,
    document.body,
  );
}

// ── selection bubble toolbar (B6) ────────────────────────────────────────────
/**
 * Floating format bubble (bold / italic / code / link) over a non-collapsed text
 * selection. Scales in from the selection anchor via `.motion-pop` (origin-bottom,
 * <180ms), hides the moment the selection collapses. The link button hands the
 * selection rect to the shared LinkEditorPlugin.
 */
export function SelectionToolbar() {
  const [editor] = useLexicalComposerContext();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [fmt, setFmt] = useState({ bold: false, italic: false, code: false });

  const update = useCallback(() => {
    const sel = $getSelection();
    const native = window.getSelection();
    const root = editor.getRootElement();
    if (
      !$isRangeSelection(sel) ||
      sel.isCollapsed() ||
      !native ||
      native.rangeCount === 0 ||
      !root ||
      !native.anchorNode ||
      !root.contains(native.anchorNode)
    ) {
      setRect(null);
      return;
    }
    const r = native.getRangeAt(0).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      setRect(null);
      return;
    }
    setFmt({ bold: sel.hasFormat("bold"), italic: sel.hasFormat("italic"), code: sel.hasFormat("code") });
    setRect(r);
  }, [editor]);

  useEffect(() => {
    const read = () => editor.getEditorState().read(update);
    const unregister = mergeRegister(
      editor.registerUpdateListener(({ editorState }) => editorState.read(update)),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          read();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
    window.addEventListener("scroll", read, true);
    window.addEventListener("resize", read);
    return () => {
      unregister();
      window.removeEventListener("scroll", read, true);
      window.removeEventListener("resize", read);
    };
  }, [editor, update]);

  if (!rect) return null;

  const format = (f: TextFormatType) => editor.dispatchCommand(FORMAT_TEXT_COMMAND, f);
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
        transform: "translate(-50%, -100%)",
      }}
      className="motion-pop z-50 flex origin-bottom items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      <ToolbarButton label="Bold" active={fmt.bold} onClick={() => format("bold")}>
        <Bold />
      </ToolbarButton>
      <ToolbarButton label="Italic" active={fmt.italic} onClick={() => format("italic")}>
        <Italic />
      </ToolbarButton>
      <ToolbarButton label="Inline code" active={fmt.code} onClick={() => format("code")}>
        <Code />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton
        label="Insert link"
        onClick={() => editor.dispatchCommand(OPEN_LINK_EDITOR_COMMAND, rect)}
      >
        <Link2 />
      </ToolbarButton>
    </div>,
    document.body,
  );
}
