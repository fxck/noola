import { useEffect, useId, useState } from "react";
import { Plus, Tag, X } from "lucide-react";
import { fetchContactTags } from "@/lib/contacts";
import { cn } from "@/lib/utils";

// Contact tags (0123) — small shared pieces: a read-only chip list, and an inline editor (chips
// with remove + an add field suggesting the tags already in use).

export function TagChips({ tags, max = 3, className }: { tags: string[]; max?: number; className?: string }) {
  if (!tags.length) return null;
  const shown = tags.slice(0, max);
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)} title={tags.join(", ")}>
      {shown.map((t) => (
        <span key={t} className="max-w-[10rem] truncate rounded border bg-muted/40 px-1.5 py-0.5 text-micro">
          {t}
        </span>
      ))}
      {tags.length > max && <span className="text-micro text-muted-foreground">+{tags.length - max}</span>}
    </span>
  );
}

/** Tag suggestions (tags in use), loaded once per mount. */
export function useTagSuggestions(): { tag: string; count: number }[] {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  useEffect(() => {
    fetchContactTags().then(setTags).catch(() => setTags([]));
  }, []);
  return tags;
}

export function TagEditor({ tags, onChange, disabled }: { tags: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const suggestions = useTagSuggestions();
  const listId = useId();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  function add() {
    const v = draft.trim().replace(/\s+/g, " ");
    setDraft("");
    setAdding(false);
    if (!v || tags.some((t) => t.toLowerCase() === v.toLowerCase())) return;
    onChange([...tags, v]);
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {tags.map((t) => (
        <span key={t} className="inline-flex max-w-[12rem] items-center gap-0.5 rounded border bg-muted/40 py-0.5 pl-1.5 pr-0.5 text-micro">
          <span className="truncate">{t}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(tags.filter((x) => x !== t))}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Remove tag ${t}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {adding ? (
        <>
          <input
            autoFocus
            list={listId}
            value={draft}
            maxLength={60}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); add(); }
              if (e.key === "Escape") { setDraft(""); setAdding(false); }
            }}
            placeholder="Tag…"
            className="h-6 w-32 rounded border border-input bg-background px-1.5 text-micro outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <datalist id={listId}>
            {suggestions.map((s) => <option key={s.tag} value={s.tag} />)}
          </datalist>
        </>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-micro text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {tags.length ? <Plus className="size-3" /> : <Tag className="size-3" />} {tags.length ? "" : "Add tag"}
        </button>
      )}
    </span>
  );
}
