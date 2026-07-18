import { useEffect, useState } from "react";
import { Sparkles, X, FileText } from "lucide-react";
import { type ChunkHit, type SourceDocument, searchChunks } from "@/lib/documents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useNerdMode } from "@/lib/nerd-mode";
import { EMBED_DIM } from "@/components/sources/source-lib";
import { cn } from "@/lib/utils";

// The "Test retrieval" panel: a demoted, opt-in surface that ranks KB chunks server-side (RAG's
// retrieval half) so a user can see the passages the AI would cite. Owns its own query + result
// state; the parent only toggles it open and supplies the doc lookup (for each hit's source name).
export function RetrievalPanel({
  docsById,
  shell,
  onClose,
}: {
  docsById: Map<string, SourceDocument>;
  shell: string;
  onClose: () => void;
}) {
  const { nerd } = useNerdMode();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ChunkHit[] | null>(null); // null = not retrieving
  const [retrieving, setRetrieving] = useState(false);
  const [retrieveMs, setRetrieveMs] = useState<number | null>(null);

  // Debounce the box, then rank chunks server-side. A per-run flag discards out-of-order responses.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      setRetrieving(false);
      return;
    }
    setRetrieving(true);
    let live = true;
    const t = setTimeout(async () => {
      const startedAt = performance.now();
      try {
        const r = await searchChunks(q);
        if (live) {
          setHits(r);
          setRetrieveMs(Math.round(performance.now() - startedAt));
        }
      } catch {
        if (live) setHits([]);
      } finally {
        if (live) setRetrieving(false);
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  return (
    <div className="shrink-0 border-b bg-muted/20">
      <div className={cn(shell, "flex items-center gap-2 py-2")}>
        <Sparkles className="size-4 shrink-0 text-primary" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask across your sources — retrieve the passages the AI would cite…"
          className="h-8 text-sm"
          aria-label="Test retrieval query"
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Close retrieval"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      {query.trim() && (
        <div className={cn(shell, "max-h-72 overflow-y-auto border-t py-2")}>
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>
              {retrieving
                ? "Retrieving passages…"
                : `${hits?.length ?? 0} ${
                    (hits?.length ?? 0) === 1 ? "passage" : "passages"
                  } for “${query.trim()}”`}
            </span>
            {nerd && !retrieving && retrieveMs != null && (
              <span className="font-mono text-micro tabular-nums text-muted-foreground/70">
                · {hits?.length ?? 0} hits · {retrieveMs}ms · {EMBED_DIM}-d knn
              </span>
            )}
          </div>
          {retrieving && (hits === null || hits.length === 0) ? (
            <div className="grid place-items-center py-8">
              <Spinner />
            </div>
          ) : (hits?.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No passages matched. Try different words, or add more sources.
            </p>
          ) : (
            <ul className="space-y-2">
              {(hits ?? []).map((h) => {
                const doc = docsById.get(h.document_id);
                return (
                  <li key={h.id} className="rounded-lg border bg-card p-3">
                    <div className="mb-1.5 flex items-center gap-2 text-micro text-muted-foreground">
                      <FileText className="size-3.5 shrink-0" />
                      <span className="truncate font-medium text-foreground/80">
                        {h.filename ?? doc?.filename ?? "Unknown source"}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">passage {h.chunk_index + 1}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-small leading-relaxed text-foreground/90">
                      {h.text}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
