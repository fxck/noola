import { useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  BookOpen,
  FolderOpen,
  Layers,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Lightbulb,
  Lock,
  ArrowUpRight,
  MoreHorizontal,
  List as ListIcon,
} from "lucide-react";
import {
  type KbArticle,
  type KbCollection,
  fetchArticles,
  searchArticles,
  fetchArticle,
  createArticle,
  updateArticle,
  deleteCollection,
  fetchCollections,
} from "@/lib/kb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Badge } from "@/components/ui/badge";
import { RichTextEditor } from "@/components/editor/rich-text-editor";
import { ArticleBody } from "@/components/editor/article-body";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { Popover } from "@/components/ui/popover";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { useRealtime } from "@/lib/realtime-context";
import { cn } from "@/lib/utils";
import { useNerdMode } from "@/lib/nerd-mode";
import { compactNum } from "@/components/live/nerd-stats";
import { CollectionRail, type RailCounts } from "@/components/kb/collection-rail";
import { GapsList } from "@/components/kb/gaps-list";
import { fetchKnowledgeGaps, updateKnowledgeGap, type KnowledgeGap } from "@/lib/gaps";
import { CollectionDialog } from "@/components/kb/collection-dialog";
import { MoveToMenu } from "@/components/kb/move-menu";
import { CollectionDot, collectionOptions } from "@/components/kb/collection-common";

// all-MiniLM-L6-v2 — the embedder bakes a fixed 384-dim vector per chunk.
const EMBED_DIM = 384;

const kbRoute = getRouteApi("/kb");

// A dialog target: create a new collection, or edit an existing one.
type DialogState = { mode: "create" } | { mode: "edit"; collection: KbCollection };

function relativeTime(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// ── read-view shared bits (used by the routed detail + the live preview pane) ──
type TocEntry = { level: 2 | 3; text: string };

// Pull H2/H3 headings out of the article Markdown for an auto Table of Contents.
// The i-th entry lines up with the i-th `<h2>/<h3>` ArticleBody renders, so scroll
// targets resolve by DOM order (no ids needed on the read tree we don't own).
function tocFromMarkdown(md: string): TocEntry[] {
  const out: TocEntry[] = [];
  for (const raw of md.split("\n")) {
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (!m) continue;
    const text = m[2].replace(/[*_`~]/g, "").trim();
    if (text) out.push({ level: m[1].length as 2 | 3, text });
  }
  return out;
}

// The publish-state badges shared by the detail + preview read views.
function PublishBadges({ a }: { a: KbArticle }) {
  return (
    <>
      {a.status === "draft" && <Badge variant="warning">Draft</Badge>}
      {a.visibility === "public" ? (
        <Badge variant={a.status === "published" ? "default" : "muted"}>
          {a.status === "published" ? "Live on help center" : "Public (unpublished)"}
        </Badge>
      ) : (
        <Badge variant="muted">Internal</Badge>
      )}
    </>
  );
}

// The retrieval footprint — every article grounds agent answers; the chunk count is
// its indexed size. No per-article "N answers served" metric exists, so we state the
// truthful footprint rather than invent a usage number.
function UsageStat({ a, className }: { a: KbArticle; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Lock className="size-3 shrink-0 opacity-70" />
      <span>Powers agent answers</span>
      {a.chunk_count != null && (
        <>
          <span className="text-muted-foreground/40">·</span>
          <span className="font-mono tabular-nums">{compactNum(a.chunk_count)} chunks</span>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The KB is now a two-pane, collections-organized workspace: a left rail of
// collections drives a `?collection` search param (deep-linkable), and the right
// pane shows the scoped article list — grouped by collection when "All" is
// selected. Full-text search overrides the collection view while a query is
// present. Rows navigate to the routed, deep-linkable article page
// (/kb/$articleId); creating a new article is a full-page takeover here.
// ─────────────────────────────────────────────────────────────────────────────
export function KbPage() {
  const navigate = useNavigate();
  const { subscribe } = useRealtime();
  const { nerd } = useNerdMode();
  const { collection: selected, article: articleParam } = kbRoute.useSearch();
  const goNew = () =>
    void navigate({
      to: "/kb/new",
      search: selected && selected !== "none" ? { collection: selected } : {},
    });

  const [articles, setArticles] = useState<KbArticle[] | null>(null);
  const [collections, setCollections] = useState<KbCollection[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KbArticle[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchMs, setSearchMs] = useState<number | null>(null);
  const [error, setError] = useState(false);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<KbCollection | null>(null);
  const [deletingCollection, setDeletingCollection] = useState(false);

  // The article shown in the live-preview pane (wide screens) + keyboard cursor.
  const [selectedId, setSelectedId] = useState<string | null>(articleParam ?? null);
  // Selection is deep-linkable: /kb?article=<id> restores the preview, and every
  // click reflects into the URL (replace — browsing rows shouldn't grow history).
  useEffect(() => {
    if (articleParam && articleParam !== selectedId) setSelectedId(articleParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleParam]);
  const selectArticle = (id: string) => {
    setSelectedId(id);
    void navigate({
      to: "/kb",
      replace: true,
      search: (s: { collection?: string; article?: string }) => ({ ...s, article: id }),
    });
  };
  const searchRef = useRef<HTMLInputElement>(null);

  // Open knowledge gaps — the content-loop worklist, surfaced as a rail entry
  // (its action is "write an article", so it lives here, not on Sources).
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);

  const load = useRef(async () => {
    try {
      const [arts, cols] = await Promise.all([fetchArticles(), fetchCollections()]);
      setArticles(arts);
      setCollections(cols);
      setError(false);
    } catch {
      setError(true);
    }
    // Non-fatal — the Gaps entry simply hides if this endpoint is unavailable.
    try {
      setGaps((await fetchKnowledgeGaps("open")).gaps);
    } catch {
      setGaps([]);
    }
  }).current;

  // Optimistic gap triage — the worklist only shows open gaps.
  const triageGap = async (id: string, status: "resolved" | "dismissed") => {
    setGaps((g) => g.filter((x) => x.id !== id));
    try {
      await updateKnowledgeGap(id, { status });
    } catch {
      void load(); // reconcile on failure
    }
  };

  // Seed a new article from a gap: title prefilled, gap auto-resolved on save.
  const writeGapArticle = (g: KnowledgeGap) =>
    void navigate({ to: "/kb/new", search: { title: g.question, gap: g.id } });

  useEffect(() => {
    void load();
  }, [load]);

  // Live: another agent editing the KB (or ingest completing) refreshes both lists.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe, load]);

  // debounced full-text search (overrides the collection view when active)
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let live = true;
    const t = setTimeout(async () => {
      const startedAt = performance.now();
      try {
        const r = await searchArticles(q);
        if (live) {
          setResults(r);
          setSearchMs(Math.round(performance.now() - startedAt));
        }
      } catch {
        if (live) setResults([]);
      } finally {
        if (live) setSearching(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  const searchMode = query.trim().length > 0;
  const searchHits = results?.length ?? 0;

  // Known collection ids — anything else (null, or a dangling id) is uncategorized.
  const known = useMemo(
    () => new Set((collections ?? []).map((c) => c.id)),
    [collections],
  );

  // Per-collection tallies from the loaded corpus — the source of truth for the
  // rail badges and headers, so counts stay consistent with the visible list.
  const counts = useMemo<RailCounts>(() => {
    const arts = articles ?? [];
    const byId: Record<string, number> = {};
    let none = 0;
    for (const a of arts) {
      if (a.collection_id && known.has(a.collection_id)) {
        byId[a.collection_id] = (byId[a.collection_id] ?? 0) + 1;
      } else {
        none += 1;
      }
    }
    return { all: arts.length, none, byId };
  }, [articles, known]);

  // "All" view: ordered collection sections (by position), uncategorized last.
  const groups = useMemo(() => {
    const arts = articles ?? [];
    const byId = new Map<string, KbArticle[]>();
    const uncat: KbArticle[] = [];
    for (const a of arts) {
      if (a.collection_id && known.has(a.collection_id)) {
        const bucket = byId.get(a.collection_id);
        if (bucket) bucket.push(a);
        else byId.set(a.collection_id, [a]);
      } else {
        uncat.push(a);
      }
    }
    const ordered = [...(collections ?? [])].sort((a, b) => a.position - b.position);
    const result: { key: string; name: string; color: string | null; articles: KbArticle[] }[] =
      [];
    for (const c of ordered) {
      const items = byId.get(c.id);
      if (items && items.length) result.push({ key: c.id, name: c.name, color: c.color, articles: items });
    }
    if (uncat.length) result.push({ key: "none", name: "Uncategorized", color: null, articles: uncat });
    return result;
  }, [articles, collections, known]);

  // Scoped view (a specific collection or "none"): the flat filtered list.
  const scoped = useMemo(() => {
    if (selected === undefined) return null;
    const arts = articles ?? [];
    if (selected === "none") return arts.filter((a) => !a.collection_id || !known.has(a.collection_id));
    return arts.filter((a) => a.collection_id === selected);
  }, [selected, articles, known]);

  const selectedCollection = useMemo(
    () =>
      selected && selected !== "none"
        ? (collections ?? []).find((c) => c.id === selected) ?? null
        : null,
    [selected, collections],
  );

  // Nerd totals across the loaded corpus (char_count falls back to body length).
  const totals = useMemo(() => {
    const docs = articles ?? [];
    let chunks = 0;
    let chars = 0;
    for (const a of docs) {
      chunks += a.chunk_count ?? 0;
      chars += a.char_count ?? a.body.length;
    }
    return { docs: docs.length, chunks, chars };
  }, [articles]);

  // The collection a freshly created article should default into.

  const gapsMode = !searchMode && selected === "gaps";
  const heading = searchMode
    ? "Search"
    : gapsMode
      ? "Gaps"
      : selected === undefined
        ? "Articles"
        : selected === "none"
          ? "Uncategorized"
          : selectedCollection?.name ?? "Collection";

  const scopedCount = scoped?.length ?? 0;
  const countLabel =
    articles === null && !error
      ? "loading…"
      : searchMode
        ? `${searchHits} ${searchHits === 1 ? "result" : "results"}`
        : gapsMode
          ? `${gaps.length} open ${gaps.length === 1 ? "question" : "questions"}`
          : selected === undefined
            ? `${counts.all}`
            : `${scopedCount}`;

  const mobileOptions = useMemo<ComboOption[]>(
    () => [{ value: "all", label: "All articles", icon: Layers }, ...collectionOptions(collections ?? [])],
    [collections],
  );

  const selectCollection = (c: string | undefined) =>
    void navigate({ to: "/kb", search: { collection: c } });
  const openArticle = (a: KbArticle) =>
    void navigate({ to: "/kb/$articleId", params: { articleId: a.id } });
  const editArticle = (a: KbArticle) =>
    void navigate({ to: "/kb/$articleId/edit", params: { articleId: a.id } });

  // The flat article sequence exactly as rendered — the source of truth for the
  // preview cursor and keyboard roving (search hits → scoped list → grouped "All").
  const visibleList = useMemo<KbArticle[]>(() => {
    if (searchMode) return results ?? [];
    if (selected !== undefined) return scoped ?? [];
    return groups.flatMap((g) => g.articles);
  }, [searchMode, results, selected, scoped, groups]);

  const selectedArticle = useMemo(
    () => visibleList.find((a) => a.id === selectedId) ?? null,
    [visibleList, selectedId],
  );

  // Rows preview in place on wide layouts (the right pane is visible ≥ xl); on
  // narrower widths there's no preview slot, so a click opens the routed page.
  const activate = (a: KbArticle) => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches) {
      selectArticle(a.id);
    } else {
      openArticle(a);
    }
  };

  // Roving keyboard nav: j/k or ↑/↓ move the cursor (previewing), Enter opens the
  // routed page, "/" jumps to search. Bound once; live state read through a ref.
  const selectRef = useRef(selectArticle);
  selectRef.current = selectArticle;
  const kbd = useRef({ list: visibleList, selectedId });
  useEffect(() => {
    kbd.current = { list: visibleList, selectedId };
  });
  useEffect(() => {
    const scrollTo = (id: string) =>
      requestAnimationFrame(() =>
        document.querySelector(`[data-kb-id="${id}"]`)?.scrollIntoView({ block: "nearest" }),
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) return;
      const { list, selectedId: sel } = kbd.current;
      if (!list.length) return;
      const idx = list.findIndex((x) => x.id === sel);
      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          const n = list[idx < 0 ? 0 : Math.min(idx + 1, list.length - 1)];
          if (n) {
            selectRef.current(n.id);
            scrollTo(n.id);
          }
          break;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          const p = list[idx <= 0 ? 0 : idx - 1];
          if (p) {
            selectRef.current(p.id);
            scrollTo(p.id);
          }
          break;
        }
        case "Enter": {
          if (sel) {
            const a = list.find((x) => x.id === sel);
            if (a) {
              e.preventDefault();
              openArticle(a);
            }
          }
          break;
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function moveArticle(a: KbArticle, collectionId: string | null) {
    if (a.collection_id === collectionId) return;
    const before = a;
    setArticles((prev) =>
      prev ? prev.map((x) => (x.id === a.id ? { ...x, collection_id: collectionId } : x)) : prev,
    );
    try {
      const updated = await updateArticle(a.id, { collection_id: collectionId });
      setArticles((prev) => (prev ? prev.map((x) => (x.id === updated.id ? updated : x)) : prev));
      const dest = collectionId
        ? (collections ?? []).find((c) => c.id === collectionId)?.name ?? "collection"
        : "Uncategorized";
      toast.success(`Moved to ${dest}.`);
    } catch {
      setArticles((prev) => (prev ? prev.map((x) => (x.id === before.id ? before : x)) : prev));
      toast.error("Couldn't move the article. Please try again.");
    }
  }

  async function doDeleteCollection() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    setDeletingCollection(true);
    try {
      await deleteCollection(target.id);
      toast.success("Collection deleted — its articles are now uncategorized.");
      setConfirmDelete(null);
      setDeletingCollection(false);
      if (selected === target.id) selectCollection(undefined);
      void load();
    } catch {
      toast.error("Couldn't delete the collection. Please try again.");
      setDeletingCollection(false);
    }
  }

  function renderList() {
    if (articles === null && !error) {
      return <RowsSkeleton rows={6} />;
    }
    if (error) {
      return (
        <ErrorState
          description="Couldn't load the knowledge base."
          onRetry={() => void load()}
        />
      );
    }

    if (gapsMode) {
      return <GapsList gaps={gaps} onWrite={writeGapArticle} onTriage={(id, s) => void triageGap(id, s)} />;
    }

    if (searchMode) {
      if (searching && searchHits === 0) {
        return <RowsSkeleton rows={6} />;
      }
      if (searchHits === 0) {
        return (
          <EmptyState icon={BookOpen} title={`No articles match “${query.trim()}”.`} />
        );
      }
      return (
        <ul className="divide-y divide-border/50">
          {(results ?? []).map((a) => (
            <ArticleRow
              key={a.id}
              a={a}
              nerd={nerd}
              collections={collections ?? []}
              selected={selectedId === a.id}
              onOpen={() => activate(a)}
              onMove={(cid) => void moveArticle(a, cid)}
            />
          ))}
        </ul>
      );
    }

    // Scoped to one collection (or uncategorized).
    if (selected !== undefined) {
      const items = scoped ?? [];
      if (items.length === 0) {
        const label =
          selected === "none" ? "uncategorized" : `“${selectedCollection?.name ?? "this collection"}”`;
        return (
          <EmptyState
            icon={FolderOpen}
            title={
              selected === "none"
                ? "Nothing uncategorized — every article has a home."
                : `Nothing in ${label} yet.`
            }
            action={
              <Button size="sm" variant="brand" className="gap-1.5" onClick={goNew}>
                <Plus className="size-4" /> New article
              </Button>
            }
          />
        );
      }
      return (
        <ul className="divide-y divide-border/50">
          {items.map((a) => (
            <ArticleRow
              key={a.id}
              a={a}
              nerd={nerd}
              collections={collections ?? []}
              selected={selectedId === a.id}
              onOpen={() => activate(a)}
              onMove={(cid) => void moveArticle(a, cid)}
            />
          ))}
        </ul>
      );
    }

    // "All" — grouped by collection.
    if ((articles ?? []).length === 0) {
      return <EmptyState icon={BookOpen} title="No articles yet. Write the first one." />;
    }
    return (
      <div>
        {groups.map((g) => (
          <section key={g.key}>
            <button
              type="button"
              onClick={() => selectCollection(g.key === "none" ? "none" : g.key)}
              className="sticky top-0 z-10 flex w-full items-center gap-2 border-b bg-background/90 px-4 py-2 text-left backdrop-blur transition-colors hover:bg-muted/60 lg:px-6"
              title={`View ${g.name}`}
            >
              <CollectionDot color={g.color} />
              <span className="text-xs font-semibold tracking-wide">{g.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{g.articles.length}</span>
            </button>
            <ul className="divide-y divide-border/50">
              {g.articles.map((a) => (
                <ArticleRow
                  key={a.id}
                  a={a}
                  nerd={nerd}
                  collections={collections ?? []}
                  selected={selectedId === a.id}
                  onOpen={() => activate(a)}
                  onMove={(cid) => void moveArticle(a, cid)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <>
      {/* ── pane header (h-12, §3) ─────────────────────────────── */}
      <div className="shrink-0">
        <header className="flex h-12 items-center gap-2 px-4">
          <h1 className="truncate text-sm font-semibold tracking-tight">{heading}</h1>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{countLabel}</span>
          {/* mobile collection picker (the rail is hidden below md); search + new live in the
              list column's own header now, aligned above the articles they act on. */}
          <div className="ml-auto flex items-center gap-1.5 md:hidden">
            <Combobox
              value={selected ?? "all"}
              onChange={(v) => selectCollection(v === "all" ? undefined : v)}
              options={mobileOptions}
              className="h-8 w-36"
              align="start"
            />
          </div>
        </header>
        {nerd && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 pb-2 font-mono text-micro tabular-nums text-muted-foreground/80">
            {searchMode ? (
              <>
                <span className="text-foreground/70">
                  {searchHits} hit{searchHits === 1 ? "" : "s"}
                </span>
                {searchMs != null && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span>{searchMs}ms</span>
                  </>
                )}
                <span className="text-muted-foreground/40">·</span>
                <span>full-text</span>
              </>
            ) : (
              <>
                <span className="text-foreground/70">{compactNum(totals.docs)} docs</span>
                <span className="text-muted-foreground/40">·</span>
                <span>{compactNum((collections ?? []).length)} collections</span>
                <span className="text-muted-foreground/40">·</span>
                <span>Σ {compactNum(totals.chunks)} chunks</span>
                <span className="text-muted-foreground/40">·</span>
                <span>Σ {compactNum(totals.chars)} chars</span>
                <span className="text-muted-foreground/40">·</span>
                <span title="all-MiniLM-L6-v2 embedding dimension">{EMBED_DIM}-d</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── three-pane: collections rail · article list · live preview ─── */}
      <div className="flex min-h-0 flex-1">
        <CollectionRail
          className="hidden md:flex"
          collections={collections ?? []}
          loading={collections === null}
          counts={counts}
          gapCount={gaps.length}
          selected={selected}
          onSelect={selectCollection}
          onNew={() => setDialog({ mode: "create" })}
          onRename={(c) => setDialog({ mode: "edit", collection: c })}
          onDelete={(c) => setConfirmDelete(c)}
        />
        {/* article list — capped to a reading column once the preview is present */}
        <div className="flex min-h-0 w-full flex-col xl:w-96 xl:shrink-0 xl:border-r">
          {/* list controls sit ABOVE the list they act on (not floating in the full-width header) */}
          <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border/50 px-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search articles…"
                className="h-8 w-full pl-8 text-sm"
                aria-label="Search articles"
              />
            </div>
            <Button size="sm" variant="brand" className="h-8 shrink-0 gap-1.5 text-xs" onClick={goNew}>
              <Plus className="size-3.5" /> <span className="hidden sm:inline">New</span>
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{renderList()}</div>
        </div>
        {/* live preview — the read view of the selected article (wide only) */}
        <div className="hidden min-h-0 flex-1 overflow-y-auto xl:block">
          {selectedArticle ? (
            <ArticlePreview
              key={selectedArticle.id}
              a={selectedArticle}
              collections={collections ?? []}
              onOpen={() => openArticle(selectedArticle)}
              onEdit={() => editArticle(selectedArticle)}
            />
          ) : gapsMode ? (
            <EmptyState
              icon={Lightbulb}
              title="Close the loop"
              description="Write article seeds a new article from the question — the gap resolves itself when the article saves."
              className="h-full"
            />
          ) : (
            <EmptyState
              icon={BookOpen}
              title="Select an article"
              description="Pick an article from the list to preview how it reads."
              className="h-full"
            />
          )}
        </div>
      </div>

      <CollectionDialog
        open={dialog !== null}
        initial={dialog && dialog.mode === "edit" ? dialog.collection : null}
        nextPosition={(collections ?? []).length}
        onClose={() => setDialog(null)}
        onSaved={(saved) => {
          const wasCreate = !(dialog && dialog.mode === "edit");
          setDialog(null);
          toast.success(wasCreate ? "Collection created." : "Collection updated.");
          void load();
          if (wasCreate) selectCollection(saved.id);
        }}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete collection?"
        message={
          confirmDelete
            ? `“${confirmDelete.name}” will be deleted. Its ${counts.byId[confirmDelete.id] ?? 0} article${
                (counts.byId[confirmDelete.id] ?? 0) === 1 ? "" : "s"
              } will become uncategorized — no articles are lost.`
            : undefined
        }
        confirmLabel="Delete collection"
        destructive
        busy={deletingCollection}
        onConfirm={() => void doDeleteCollection()}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A single article row — navigates to the routed article page, with a hover/focus
// "Move to…" affordance (always visible on touch) for reassigning its collection.
// Publish state renders as weight, not chips (§4): live = nothing (the norm),
// internal = a small lock glyph, draft = muted title text.
// ─────────────────────────────────────────────────────────────────────────────
function ArticleRow({
  a,
  nerd,
  collections,
  selected,
  onOpen,
  onMove,
}: {
  a: KbArticle;
  nerd: boolean;
  collections: KbCollection[];
  selected?: boolean;
  onOpen: () => void;
  onMove: (collectionId: string | null) => void;
}) {
  const railColor = a.collection_id
    ? collections.find((c) => c.id === a.collection_id)?.color ?? null
    : null;
  const internal = a.visibility === "internal";
  return (
    <li className="group relative flex items-stretch" data-kb-id={a.id}>
      {/* leading collection-color rail (persistent identity) */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-0.5"
        style={{ backgroundColor: railColor ?? "transparent" }}
      />
      {/* signature scan-bar — amber spine slides in on hover */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-0.5 origin-left scale-x-0 bg-primary opacity-0 transition-[opacity,transform] duration-150 ease-[var(--ease-out-strong)] group-hover:scale-x-100 group-hover:opacity-100 motion-reduce:transition-none"
      />
      <button
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 pl-4 pr-14 text-left transition-colors active:bg-muted lg:pl-6",
          selected ? "bg-muted" : "hover:bg-muted/50",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-sm font-medium",
              a.status === "draft" && "text-muted-foreground",
            )}
          >
            {a.title}
          </span>
          {internal && (
            <span className="shrink-0" title="Internal">
              <Lock className="size-3 text-muted-foreground/70" aria-hidden />
            </span>
          )}
        </span>
        {/* Internal articles never echo their body (may hold secrets); public ones
            show a help-center snippet. Every article powers agent answers, so that
            fact marks nothing and stays off the rows (§5 fact-once). */}
        {!internal && (
          <span className="truncate text-xs text-muted-foreground">{a.body.slice(0, 80) || "—"}</span>
        )}
        <span className="text-micro text-muted-foreground/70">
          Updated {relativeTime(a.updated_at)}
        </span>
        {nerd && (
          <span className="flex flex-wrap items-center gap-x-1.5 font-mono text-micro tabular-nums text-muted-foreground/70">
            <span>{compactNum(a.chunk_count ?? 0)} chunks</span>
            <span className="text-muted-foreground/40">·</span>
            <span>{compactNum(a.char_count ?? a.body.length)} chars</span>
          </span>
        )}
      </button>
      <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 lg:right-4">
        <MoveToMenu collections={collections} value={a.collection_id} onMove={onMove} />
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Live preview — the read view of the currently-selected list row, shown in the
// right pane on wide layouts. The list already carries the full article body, so
// this renders instantly (no refetch). "Open" jumps to the routed, deep-linkable
// page; "Edit" to its editor.
// ─────────────────────────────────────────────────────────────────────────────
function ArticlePreview({
  a,
  collections,
  onOpen,
  onEdit,
}: {
  a: KbArticle;
  collections: KbCollection[];
  onOpen: () => void;
  onEdit: () => void;
}) {
  const collection = a.collection_id ? collections.find((c) => c.id === a.collection_id) : null;
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <span className="text-micro font-medium uppercase tracking-wide text-muted-foreground/70">
          Preview
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onEdit}>
            <Pencil className="size-3.5" /> Edit
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={onOpen}>
            Open <ArrowUpRight className="size-3.5" />
          </Button>
        </div>
      </div>
      {collection ? (
        <span className="mb-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium text-foreground/80">
          <CollectionDot color={collection.color} />
          {collection.name}
        </span>
      ) : (
        <Badge variant="muted" className="mb-2">
          Uncategorized
        </Badge>
      )}
      <h2 className="text-xl font-semibold tracking-tight text-balance">{a.title}</h2>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <PublishBadges a={a} />
        <span className="text-xs text-muted-foreground">Updated {relativeTime(a.updated_at)}</span>
      </div>
      <UsageStat a={a} className="mt-2" />
      {a.body.trim() ? (
        <ArticleBody markdown={a.body} className="mt-4" />
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">This article has no body yet.</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Article detail — fetched fresh by id (deep-link safe) with loading/404/error
// states. Now collection-aware: shows the article's collection as a chip (links to
// that collection's list) and offers a "Move to…" action. Rendered by the routed
// page at /kb/$articleId; the body keeps its plain-text treatment.
// ─────────────────────────────────────────────────────────────────────────────
export function ArticleDetail({
  articleId,
  nerd,
  onBack,
  onEdit,
  onDelete,
}: {
  articleId: string;
  nerd: boolean;
  onBack: () => void;
  onEdit: (a: KbArticle) => void;
  onDelete: (a: KbArticle) => void;
}) {
  const navigate = useNavigate();
  const [article, setArticle] = useState<KbArticle | null>(null);
  const [collections, setCollections] = useState<KbCollection[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const proseRef = useRef<HTMLDivElement>(null);

  // Auto Table of Contents from the body's H2/H3 headings (shown when ≥ 2).
  const toc = useMemo(() => (article ? tocFromMarkdown(article.body) : []), [article]);

  // Scroll to the i-th heading in the rendered body (DOM order matches `toc`).
  const scrollToHeading = (i: number) => {
    const headings = proseRef.current?.querySelectorAll("h2, h3");
    headings?.[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    let live = true;
    setArticle(null);
    setNotFound(false);
    setError(false);
    void (async () => {
      try {
        const fresh = await fetchArticle(articleId);
        if (live) setArticle(fresh);
      } catch (e) {
        if (!live) return;
        if ((e as { status?: number }).status === 404) setNotFound(true);
        else setError(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [articleId]);

  // Collections for the chip + "Move to…" menu (independent of the article fetch).
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const cols = await fetchCollections();
        if (live) setCollections(cols);
      } catch {
        /* the chip/move menu just stay minimal if this fails */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function move(collectionId: string | null) {
    if (!article || article.collection_id === collectionId) return;
    const before = article;
    setArticle({ ...article, collection_id: collectionId });
    try {
      const updated = await updateArticle(before.id, { collection_id: collectionId });
      setArticle(updated);
      const dest = collectionId
        ? collections.find((c) => c.id === collectionId)?.name ?? "collection"
        : "Uncategorized";
      toast.success(`Moved to ${dest}.`);
    } catch {
      setArticle(before);
      toast.error("Couldn't move the article. Please try again.");
    }
  }

  if (notFound) {
    return (
      <div className="grid h-full flex-1 place-items-center p-8 text-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <AlertTriangle className="size-7 opacity-40" />
          <p className="text-sm">This article no longer exists.</p>
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to articles
          </Button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid h-full flex-1 place-items-center p-8 text-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <AlertTriangle className="size-7 opacity-40" />
          <p className="text-sm">Couldn't load this article.</p>
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to articles
          </Button>
        </div>
      </div>
    );
  }

  const a = article;
  if (!a) {
    return (
      <div className="grid h-full flex-1 place-items-center py-16">
        <Spinner />
      </div>
    );
  }

  const collection = a.collection_id ? collections.find((c) => c.id === a.collection_id) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl gap-10 p-6 lg:p-8">
      {/* ── prose column (capped reading measure) ─────────────────── */}
      <article className="min-w-0 flex-1 lg:max-w-[72ch]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <button
            onClick={onBack}
            className="-ml-1 flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" /> Articles
          </button>
          <div className="flex shrink-0 items-center gap-1.5">
            <MoveToMenu
              collections={collections}
              value={a.collection_id}
              onMove={(cid) => void move(cid)}
              label="Move"
            />
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onEdit(a)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            <Popover
              open={moreOpen}
              onOpenChange={setMoreOpen}
              align="end"
              width={168}
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  aria-label="More actions"
                  aria-haspopup="menu"
                  onClick={() => setMoreOpen((o) => !o)}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              }
            >
              <div className="p-1" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    onDelete(a);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                >
                  <Trash2 className="size-3.5" /> Delete article
                </button>
              </div>
            </Popover>
          </div>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight text-balance md:text-3xl">{a.title}</h1>

        {/* compact meta — only when the sticky rail is hidden (narrow) */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 lg:hidden">
          {a.collection_id && collection ? (
            <button
              type="button"
              onClick={() => void navigate({ to: "/kb", search: { collection: collection.id } })}
              className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted"
              title={`View ${collection.name}`}
            >
              <CollectionDot color={collection.color} />
              {collection.name}
            </button>
          ) : (
            <Badge variant="muted">Uncategorized</Badge>
          )}
          <PublishBadges a={a} />
          <span className="text-xs text-muted-foreground">Updated {relativeTime(a.updated_at)}</span>
        </div>

        {a.body.trim() ? (
          <div ref={proseRef}>
            <ArticleBody markdown={a.body} className="mt-6" />
          </div>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">This article has no body yet.</p>
        )}
      </article>

      {/* ── sticky right rail: identity · usage · TOC ─────────────── */}
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-8 space-y-5 text-sm">
          <div className="space-y-2">
            {a.collection_id && collection ? (
              <button
                type="button"
                onClick={() => void navigate({ to: "/kb", search: { collection: collection.id } })}
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted"
                title={`View ${collection.name}`}
              >
                <CollectionDot color={collection.color} />
                {collection.name}
              </button>
            ) : (
              <Badge variant="muted">Uncategorized</Badge>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <PublishBadges a={a} />
            </div>
            <p className="text-xs text-muted-foreground">
              Updated <span className="tabular-nums">{relativeTime(a.updated_at)}</span>
            </p>
          </div>

          <div className="border-t pt-4">
            <UsageStat a={a} />
            {nerd && (
              <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 font-mono text-micro tabular-nums text-muted-foreground/70">
                <span>{compactNum(a.char_count ?? a.body.length)} chars</span>
                <span className="text-muted-foreground/40">·</span>
                <span title="all-MiniLM-L6-v2 embedding dimension">{EMBED_DIM}-d</span>
              </p>
            )}
          </div>

          {toc.length >= 2 && (
            <nav className="border-t pt-4" aria-label="On this page">
              <p className="mb-2 flex items-center gap-1.5 text-micro font-medium uppercase tracking-wide text-muted-foreground/80">
                <ListIcon className="size-3.5" /> On this page
              </p>
              <ul className="space-y-1">
                {toc.map((h, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => scrollToHeading(i)}
                      className={cn(
                        "flex w-full items-start gap-1 truncate text-left text-xs text-muted-foreground transition-colors hover:text-foreground",
                        h.level === 3 && "pl-3",
                      )}
                      title={h.text}
                    >
                      <ChevronRight className="mt-0.5 size-3 shrink-0 opacity-40" />
                      <span className="truncate">{h.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </aside>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Article editor — shared by the create flow (this page) and the inline edit on
// the routed detail page. Owns the create/update call and reports the saved row.
// Now includes a collection selector so create/edit sets the article's collection;
// new articles default into `defaultCollectionId` (the current collection view).
// ─────────────────────────────────────────────────────────────────────────────
/** A compact segmented toggle (label + pill options). Used for the publish status / audience. */
function Segmented({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="inline-flex rounded-md border bg-muted p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              // Selected = neutral raised (ink on a lifted surface), not amber —
              // amber stays reserved for signal, never for a segmented choice.
              value === o.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Starter skeletons the first-run template chips seed into an empty new article.
const ARTICLE_TEMPLATES: { key: string; label: string; body: string }[] = [
  {
    key: "howto",
    label: "How-to",
    body: "## Overview\n\nWhat this article helps the reader accomplish.\n\n## Steps\n\n1. First step\n2. Second step\n3. Third step\n\n## Result\n\nWhat success looks like when they're done.\n",
  },
  {
    key: "faq",
    label: "FAQ",
    body: "## Question\n\nState the question customers actually ask.\n\n## Answer\n\nA clear, complete answer.\n\n## Related\n\n- Link a related article or next step\n",
  },
  {
    key: "troubleshooting",
    label: "Troubleshooting",
    body: "## Symptom\n\nWhat the customer sees or experiences.\n\n## Cause\n\nWhy it happens.\n\n## Fix\n\n1. First thing to try\n2. Next step\n\n## Still stuck?\n\nHow to escalate or get more help.\n",
  },
];

export function ArticleEditor({
  initial,
  onCancel,
  onSaved,
  onError,
  defaultCollectionId,
  initialTitle,
}: {
  initial: KbArticle | null;
  onCancel: () => void;
  onSaved: (saved: KbArticle) => void;
  onError?: (msg: string) => void;
  /** For the create flow: which collection to preselect (null = uncategorized). */
  defaultCollectionId?: string | null;
  /** For the create flow: seed the title (e.g. from a knowledge gap's question). */
  initialTitle?: string;
}) {
  const [title, setTitle] = useState(initial?.title ?? initialTitle ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [collectionId, setCollectionId] = useState<string | null>(
    initial ? initial.collection_id : defaultCollectionId ?? null,
  );
  const [status, setStatus] = useState<"draft" | "published">(
    initial?.status === "draft" ? "draft" : "published",
  );
  const [visibility, setVisibility] = useState<"internal" | "public">(
    initial?.visibility === "public" ? "public" : "internal",
  );
  const [collections, setCollections] = useState<KbCollection[]>([]);
  const [saving, setSaving] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The editor reads `initialMarkdown` once on mount — seeding a template remounts
  // it (bumped key) with fresh initial content.
  const titleRef = useRef<HTMLInputElement>(null);
  const [editorSeed, setEditorSeed] = useState(0);
  const editorInitial = useRef(initial?.body ?? "");

  function seedTemplate(md: string) {
    setBody(md);
    editorInitial.current = md;
    setEditorSeed((s) => s + 1);
  }

  // First-run: land the cursor in the title so writing starts immediately.
  useEffect(() => {
    if (!initial) titleRef.current?.focus();
  }, [initial]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const cols = await fetchCollections();
        if (live) setCollections(cols);
      } catch {
        /* the selector just shows Uncategorized if this fails */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const collectionOpts = useMemo(() => collectionOptions(collections), [collections]);

  async function save() {
    const t = title.trim();
    if (!t) return;
    setSaving(true);
    setError(null);
    try {
      const saved = initial
        ? await updateArticle(initial.id, { title: t, body, collection_id: collectionId, status, visibility })
        : await createArticle(t, body, collectionId, { status, visibility });
      onSaved(saved);
    } catch {
      const msg = initial
        ? "Couldn't save changes. Please try again."
        : "Couldn't create the article. Please try again.";
      setError(msg);
      onError?.(msg);
      setSaving(false);
    }
  }

  // Dirty + word count power the save-state line; ⌘S saves without reaching for the mouse.
  const dirty = initial
    ? title !== initial.title ||
      body !== (initial.body ?? "") ||
      collectionId !== initial.collection_id ||
      status !== (initial.status === "draft" ? "draft" : "published") ||
      visibility !== (initial.visibility === "public" ? "public" : "internal")
    : title.trim() !== "" || body.trim() !== "";
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;

  const saveRef = useRef(save);
  saveRef.current = save;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!savingRef.current) void saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const hasTitle = title.trim() !== "";
  // Truthful save state — "Saved" only reflects a persisted, unedited article.
  const saveState = saving
    ? "Saving…"
    : dirty
      ? "Unsaved changes"
      : initial
        ? "Saved · ⌘S"
        : "Draft";

  const collectionName = collectionId
    ? collections.find((c) => c.id === collectionId)?.name ?? "Collection"
    : "Uncategorized";
  const metaSummary = `${status === "draft" ? "Draft" : "Published"} · ${
    visibility === "public" ? "Public" : "Internal"
  } · ${collectionName}`;
  const metaHint =
    visibility === "public" && status === "published"
      ? "Live on your help center."
      : visibility === "public"
        ? "Publish to show on the help center."
        : "Internal — powers agent answers only.";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      {/* top bar — the page's only chrome (Medium/Paper: the document IS the page) */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-4">
        <button
          type="button"
          onClick={onCancel}
          className="-ml-1.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-small text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> {initial ? "Article" : "Articles"}
        </button>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {saveState}
          <span className="hidden text-muted-foreground/50 sm:inline">
            {" · "}
            {words} {words === 1 ? "word" : "words"}
          </span>
        </span>
        {/* publish settings — collection / status / audience behind one quiet control */}
        <Popover
          open={metaOpen}
          onOpenChange={setMetaOpen}
          align="end"
          width={300}
          trigger={
            <button
              type="button"
              onClick={() => setMetaOpen((o) => !o)}
              aria-haspopup="dialog"
              aria-expanded={metaOpen}
              className={cn(
                "inline-flex h-8 max-w-72 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                metaOpen && "bg-muted/60 text-foreground",
              )}
            >
              <span className="truncate">{metaSummary}</span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
            </button>
          }
        >
          <div className="space-y-3 p-3">
            <div className="space-y-1.5">
              <div className="text-micro font-semibold uppercase tracking-wider text-muted-foreground/70">
                Collection
              </div>
              <Combobox
                value={collectionId ?? "none"}
                onChange={(v) => setCollectionId(v === "none" ? null : v)}
                options={collectionOpts}
                className="h-8 w-full"
                align="start"
              />
            </div>
            <Segmented
              label="Status"
              value={status}
              onChange={(v) => setStatus(v as "draft" | "published")}
              options={[{ value: "draft", label: "Draft" }, { value: "published", label: "Published" }]}
            />
            <Segmented
              label="Audience"
              value={visibility}
              onChange={(v) => setVisibility(v as "internal" | "public")}
              options={[{ value: "internal", label: "Internal" }, { value: "public", label: "Public" }]}
            />
            <p className="text-xs text-muted-foreground">{metaHint}</p>
          </div>
        </Popover>
        <Button size="sm" className="h-8 text-xs" onClick={() => void save()} disabled={saving || !hasTitle} title="⌘S">
          {saving ? "Saving…" : initial ? "Save" : "Create article"}
        </Button>
      </header>

      {/* the document — one scroll surface, one 72ch measure for title and body;
          no fixed toolbar (markdown shortcuts + the selection toolbar carry formatting) */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[72ch] px-6 pt-10">
          <Input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled article"
            className="h-auto border-0 bg-transparent px-0 py-1 text-3xl font-semibold tracking-tight shadow-none placeholder:text-muted-foreground/40 focus-visible:ring-0 md:text-4xl"
            aria-label="Article title"
          />
          {/* first-run starter — quiet, disappears the moment writing starts */}
          {!initial && !body.trim() && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Start from a template</span>
              {ARTICLE_TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => seedTemplate(t.body)}
                  className="rounded-full border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.97] motion-reduce:active:scale-100"
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <RichTextEditor
          key={`${initial?.id ?? "new"}-${editorSeed}`}
          initialMarkdown={editorInitial.current}
          onChange={setBody}
          placeholder="Write — Markdown works: ## heading, - list, > quote. Select text to format."
          ariaLabel="Article body"
          toolbar={false}
          minHeight={480}
        />
        {error && <p className="mx-auto w-full max-w-[72ch] px-6 text-sm text-destructive">{error}</p>}
        <div className="pb-24" aria-hidden />
      </div>
    </div>
  );
}
