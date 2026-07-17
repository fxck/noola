import { Fragment, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Braces,
  Code,
  Image as ImageIcon,
  Minus,
  MousePointerClick,
  MoveVertical,
  Plus,
  Trash2,
  Type,
} from "lucide-react";
import type { BroadcastBlock } from "@/lib/broadcasts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover } from "@/components/ui/popover";
import { Menu, MenuItem } from "@/components/ui/menu";
import { TAB_BASE, TAB_OFF, TAB_ON } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

// Block composer — the ordered block editor an EMAIL broadcast is written in
// (Intercom's pattern, our idiom). Chat channels keep a plain textarea; this
// component owns only the block list. Blocks carry a client-side id so moves
// and deletes stay keyed while the server payload stays the bare union.

/** A block plus the client-only list key (stripped before it ships). */
export type EditorBlock = BroadcastBlock & { id: string };

export function newTextBlock(): EditorBlock {
  return { id: crypto.randomUUID(), type: "text", md: "" };
}

function makeBlock(type: BroadcastBlock["type"]): EditorBlock {
  const id = crypto.randomUUID();
  switch (type) {
    case "text":
      return { id, type, md: "" };
    case "image":
      return { id, type, url: "" };
    case "button":
      return { id, type, label: "", url: "" };
    case "divider":
      return { id, type };
    case "spacer":
      // The server's default is fine, but a concrete number gives the stepper
      // something to show (and the operator something to react to).
      return { id, type, height: 24 };
    case "html":
      return { id, type, html: "" };
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** The chat form of the draft — text blocks joined by blank lines. Used to seed
 *  the plain textarea when the operator switches to a chat channel. */
export function textFromBlocks(blocks: EditorBlock[]): string {
  return blocks
    .filter((b): b is EditorBlock & { type: "text" } => b.type === "text")
    .map((b) => b.md.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** What actually ships: ids stripped, empty text blocks dropped, and numeric
 *  fields clamped to the server's ranges so a half-typed number never 400s. */
export function cleanBlocks(blocks: EditorBlock[]): BroadcastBlock[] {
  const out: BroadcastBlock[] = [];
  for (const { id: _id, ...b } of blocks) {
    if (b.type === "text" && !b.md.trim()) continue;
    if (b.type === "image" && b.width !== undefined) b.width = clamp(b.width, 40, 560);
    if (b.type === "spacer" && b.height !== undefined) b.height = clamp(b.height, 4, 96);
    out.push(b);
  }
  return out;
}

/** Why a block can't ship yet (null = fine). Mirrors the server's zod schema so
 *  an incomplete draft disables Create instead of round-tripping a 400. */
export function blockIssue(b: BroadcastBlock): string | null {
  switch (b.type) {
    case "image": {
      if (!b.url.trim()) return "An image block needs a URL.";
      try {
        new URL(b.url.trim());
      } catch {
        return "The image URL isn't a valid URL.";
      }
      return null;
    }
    case "button":
      if (!b.label.trim()) return "A button block needs a label.";
      if (!b.url.trim()) return "A button block needs a link URL.";
      return null;
    case "html":
      return b.html.trim() ? null : "The HTML block is empty.";
    default:
      return null;
  }
}

/** Blocks safe to send to preview-render mid-edit — invalid ones would 400 and
 *  blank the preview while the operator is still typing a URL. */
export function previewableBlocks(blocks: EditorBlock[]): BroadcastBlock[] {
  return cleanBlocks(blocks).filter((b) => blockIssue(b) === null);
}

// ── block type catalog (labels + icons for cards and the inserter menu) ──────
const BLOCK_TYPES: { type: BroadcastBlock["type"]; label: string; icon: typeof Type }[] = [
  { type: "text", label: "Text", icon: Type },
  { type: "image", label: "Image", icon: ImageIcon },
  { type: "button", label: "Button", icon: MousePointerClick },
  { type: "divider", label: "Divider", icon: Minus },
  { type: "spacer", label: "Spacer", icon: MoveVertical },
  { type: "html", label: "HTML", icon: Code },
];

// ─────────────────────────────────────────────────────────────────────────────
// The composer — ordered block cards with an inserter between and after them.
// ─────────────────────────────────────────────────────────────────────────────
export function BlockComposer({
  blocks,
  onChange,
}: {
  blocks: EditorBlock[];
  onChange: (blocks: EditorBlock[]) => void;
}) {
  const replace = (i: number, next: EditorBlock) =>
    onChange(blocks.map((b, j) => (j === i ? next : b)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  // Drag-to-reorder (0092): pull block `from` out and splice it back in at `to`.
  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const remove = (i: number) => onChange(blocks.filter((_, j) => j !== i));
  const insertAt = (i: number, type: BroadcastBlock["type"]) =>
    onChange([...blocks.slice(0, i), makeBlock(type), ...blocks.slice(i)]);

  // Deleting the last block leaves just an inserter — the empty state IS the
  // "+" affordance, no extra placeholder needed.
  if (blocks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-3 py-4">
        <BlockInserter onPick={(t) => insertAt(0, t)} label="Add a block" />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {blocks.map((b, i) => (
        <Fragment key={b.id}>
          <BlockCard
            block={b}
            first={i === 0}
            last={i === blocks.length - 1}
            dragging={dragIndex === i}
            dropTarget={overIndex === i && dragIndex !== null && dragIndex !== i}
            onChange={(next) => replace(i, next)}
            onMove={(dir) => move(i, dir)}
            onRemove={() => remove(i)}
            onDragStart={() => setDragIndex(i)}
            onDragOverCard={() => setOverIndex(i)}
            onDrop={() => { if (dragIndex !== null) reorder(dragIndex, i); setDragIndex(null); setOverIndex(null); }}
            onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
          />
          {/* "+" between blocks and at the end — the last one is "the end" */}
          <BlockInserter onPick={(t) => insertAt(i + 1, t)} />
        </Fragment>
      ))}
    </div>
  );
}

/** Centered dashed "+" revealing the block-type menu. */
function BlockInserter({
  onPick,
  label,
}: {
  onPick: (type: BroadcastBlock["type"]) => void;
  label?: string;
}) {
  return (
    <div className="flex justify-center py-0.5">
      <Menu
        align="start"
        width={168}
        trigger={(open, toggle) => (
          <button
            type="button"
            onClick={toggle}
            aria-label="Add a block"
            aria-expanded={open}
            className={cn(
              "inline-flex h-6 items-center justify-center gap-1 rounded-full border border-dashed border-border/80 px-1.5 text-xs text-muted-foreground/70 transition-colors duration-150 hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              label ? "px-2.5" : "w-6",
            )}
          >
            <Plus className="size-3.5 shrink-0" />
            {label}
          </button>
        )}
      >
        {BLOCK_TYPES.map((t) => (
          <MenuItem key={t.type} icon={t.icon} label={t.label} onSelect={() => onPick(t.type)} />
        ))}
      </Menu>
    </div>
  );
}

/** One block card — quiet chrome, controls surface on hover/focus. */
function BlockCard({
  block,
  first,
  last,
  dragging,
  dropTarget,
  onChange,
  onMove,
  onRemove,
  onDragStart,
  onDragOverCard,
  onDrop,
  onDragEnd,
}: {
  block: EditorBlock;
  first: boolean;
  last: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onChange: (next: EditorBlock) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOverCard: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const meta = BLOCK_TYPES.find((t) => t.type === block.type);
  // Only the grip starts a drag (draggable toggles on grab) — so selecting text in a block
  // doesn't accidentally initiate a drag.
  const [grabbable, setGrabbable] = useState(false);
  return (
    <div
      className={cn(
        "group/blk rounded-lg border bg-background shadow-sm transition-[box-shadow,opacity]",
        dragging && "opacity-50",
        dropTarget && "ring-2 ring-primary ring-offset-1",
      )}
      draggable={grabbable}
      onDragStart={onDragStart}
      onDragOver={(e) => { e.preventDefault(); onDragOverCard(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      onDragEnd={() => { setGrabbable(false); onDragEnd(); }}
    >
      <div className="flex items-center gap-1 px-3 pt-2">
        <button
          type="button"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          className="-ml-1 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity duration-150 hover:text-muted-foreground active:cursor-grabbing group-focus-within/blk:opacity-100 group-hover/blk:opacity-100"
          onMouseDown={() => setGrabbable(true)}
          onMouseUp={() => setGrabbable(false)}
        >
          <GripVertical className="size-3.5" />
        </button>
        <span className="text-micro font-semibold uppercase tracking-wider text-muted-foreground/70">
          {meta?.label}
        </span>
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within/blk:opacity-100 group-hover/blk:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            disabled={first}
            onClick={() => onMove(-1)}
            aria-label="Move block up"
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            disabled={last}
            onClick={() => onMove(1)}
            aria-label="Move block down"
          >
            <ArrowDown className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            aria-label="Delete block"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="px-3 pb-3 pt-1.5">
        {block.type === "text" ? (
          <TextBlockEditor block={block} onChange={onChange} />
        ) : block.type === "image" ? (
          <ImageBlockEditor block={block} onChange={onChange} />
        ) : block.type === "button" ? (
          <ButtonBlockEditor block={block} onChange={onChange} />
        ) : block.type === "divider" ? (
          // Nothing to edit — the rule previews itself.
          <div role="presentation" className="my-1.5 h-px bg-border" />
        ) : block.type === "spacer" ? (
          <SpacerBlockEditor block={block} onChange={onChange} />
        ) : (
          <HtmlBlockEditor block={block} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

// ── merge-tag insertion ───────────────────────────────────────────────────────

const VARIABLES: { label: string; tag: string }[] = [
  { label: "First name", tag: "{{firstName|there}}" },
  { label: "Name", tag: "{{name|there}}" },
  { label: "Email", tag: "{{email}}" },
  { label: "Company", tag: "{{company|your company}}" },
];

/** Inserts `text` at the field's caret (replacing any selection) and restores
 *  focus + caret after React commits the new value. Falls back to appending
 *  when the field was never focused. */
function insertAtCursor(
  ref: RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  current: string,
  text: string,
  commit: (next: string) => void,
) {
  const el = ref.current;
  const start = el?.selectionStart ?? current.length;
  const end = el?.selectionEnd ?? start;
  commit(current.slice(0, start) + text + current.slice(end));
  requestAnimationFrame(() => {
    el?.focus();
    el?.setSelectionRange(start + text.length, start + text.length);
  });
}

/** "Insert variable" — the merge-tag popover (Name/First name/Email/Company +
 *  a free `attr:` key). The caller owns WHERE the tag lands (caret position). */
function VariableMenu({ onInsert }: { onInsert: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  const [attrKey, setAttrKey] = useState("");
  const pick = (tag: string) => {
    onInsert(tag);
    setOpen(false);
    setAttrKey("");
  };
  const commitAttr = () => {
    const k = attrKey.trim();
    if (k) pick(`{{attr:${k}}}`);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      width={236}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Braces className="size-3" /> Insert variable
        </button>
      }
    >
      <div className="p-1">
        {VARIABLES.map((v) => (
          <button
            key={v.label}
            type="button"
            onClick={() => pick(v.tag)}
            className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-small transition-colors hover:bg-accent"
          >
            <span>{v.label}</span>
            <code className="shrink-0 font-mono text-micro text-muted-foreground/70">{v.tag}</code>
          </button>
        ))}
        <div role="separator" className="-mx-1 my-1 h-px bg-border/60" />
        <div className="space-y-1 px-2 py-1.5">
          <Label className="text-micro font-medium text-muted-foreground">Custom attribute</Label>
          <div className="flex items-center gap-1">
            <Input
              value={attrKey}
              onChange={(e) => setAttrKey(e.target.value)}
              // Enter inserts instead of submitting the surrounding compose form.
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitAttr();
                }
              }}
              placeholder="plan"
              spellCheck={false}
              aria-label="Attribute key"
              className="h-7 min-w-0 flex-1 px-2 font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!attrKey.trim()}
              onClick={commitAttr}
            >
              Insert
            </Button>
          </div>
        </div>
      </div>
    </Popover>
  );
}

// ── per-type editors ──────────────────────────────────────────────────────────

function TextBlockEditor({
  block,
  onChange,
}: {
  block: EditorBlock & { type: "text" };
  onChange: (next: EditorBlock) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow: the textarea tracks its content height so a long paragraph
  // never scrolls inside its own card.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [block.md]);
  return (
    <div className="space-y-1">
      <Textarea
        ref={ref}
        value={block.md}
        onChange={(e) => onChange({ ...block, md: e.target.value })}
        placeholder="Write… **bold**, _italic_, [links](https://…), lists"
        aria-label="Text block markdown"
        className="overflow-hidden"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Markdown supported.</span>
        <VariableMenu
          onInsert={(tag) => insertAtCursor(ref, block.md, tag, (md) => onChange({ ...block, md }))}
        />
      </div>
    </div>
  );
}

function ImageBlockEditor({
  block,
  onChange,
}: {
  block: EditorBlock & { type: "image" };
  onChange: (next: EditorBlock) => void;
}) {
  return (
    <div className="space-y-2">
      <Input
        value={block.url}
        onChange={(e) => onChange({ ...block, url: e.target.value })}
        placeholder="https://…/image.png"
        spellCheck={false}
        aria-label="Image URL"
        className="h-8 text-xs"
      />
      <div className="flex items-center gap-2">
        <Input
          value={block.alt ?? ""}
          onChange={(e) => onChange({ ...block, alt: e.target.value || undefined })}
          placeholder="Alt text"
          aria-label="Image alt text"
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Input
          type="number"
          min={40}
          max={560}
          value={block.width ?? ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange({
              ...block,
              width: e.target.value.trim() !== "" && Number.isFinite(n) ? Math.round(n) : undefined,
            });
          }}
          // Snap into the server's 40–560 range once the operator is done typing.
          onBlur={() => {
            if (block.width !== undefined) onChange({ ...block, width: clamp(block.width, 40, 560) });
          }}
          placeholder="Width"
          aria-label="Image width in pixels (40–560)"
          className="h-8 w-24 text-xs tabular-nums"
        />
      </div>
    </div>
  );
}

function ButtonBlockEditor({
  block,
  onChange,
}: {
  block: EditorBlock & { type: "button" };
  onChange: (next: EditorBlock) => void;
}) {
  const labelRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const align = block.align ?? "left";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Input
          ref={labelRef}
          value={block.label}
          onChange={(e) => onChange({ ...block, label: e.target.value })}
          maxLength={120}
          placeholder="Button label"
          aria-label="Button label"
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <VariableMenu
          onInsert={(tag) =>
            insertAtCursor(labelRef, block.label, tag, (label) => onChange({ ...block, label }))
          }
        />
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          ref={urlRef}
          value={block.url}
          onChange={(e) => onChange({ ...block, url: e.target.value })}
          placeholder="https://… (variables allowed)"
          spellCheck={false}
          aria-label="Button link URL"
          className="h-8 min-w-0 flex-1 font-mono text-xs"
        />
        <VariableMenu
          onInsert={(tag) =>
            insertAtCursor(urlRef, block.url, tag, (url) => onChange({ ...block, url }))
          }
        />
      </div>
      <div
        role="radiogroup"
        aria-label="Button alignment"
        className="inline-flex w-fit items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5"
      >
        {(["left", "center"] as const).map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={align === a}
            onClick={() => onChange({ ...block, align: a })}
            className={cn(TAB_BASE, align === a ? TAB_ON : TAB_OFF)}
          >
            {a === "left" ? "Left" : "Center"}
          </button>
        ))}
      </div>
    </div>
  );
}

function SpacerBlockEditor({
  block,
  onChange,
}: {
  block: EditorBlock & { type: "spacer" };
  onChange: (next: EditorBlock) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Height</span>
      <Input
        type="number"
        min={4}
        max={96}
        value={block.height ?? 24}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n))
            onChange({ ...block, height: Math.round(n) });
        }}
        // Snap into the server's 4–96 range once the operator is done typing.
        onBlur={() => {
          if (block.height !== undefined) onChange({ ...block, height: clamp(block.height, 4, 96) });
        }}
        aria-label="Spacer height in pixels (4–96)"
        className="h-8 w-20 text-xs tabular-nums"
      />
      <span className="text-xs text-muted-foreground">px</span>
    </div>
  );
}

function HtmlBlockEditor({
  block,
  onChange,
}: {
  block: EditorBlock & { type: "html" };
  onChange: (next: EditorBlock) => void;
}) {
  return (
    <div className="space-y-1">
      <Textarea
        value={block.html}
        onChange={(e) => onChange({ ...block, html: e.target.value })}
        placeholder="<table>…</table>"
        spellCheck={false}
        aria-label="Raw HTML"
        className="min-h-24 font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">Raw HTML is sent as-is to email clients.</p>
    </div>
  );
}
