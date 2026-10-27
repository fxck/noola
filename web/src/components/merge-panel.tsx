import { useEffect, useRef, useState } from "react";
import { GitMerge, Loader2, Search } from "lucide-react";
import { type Ticket, searchTickets, mergeTicket } from "@/lib/tickets";
import { Input } from "@/components/ui/input";

/** Fold this ticket into a canonical one (duplicate handling): search for the target ticket, then
 *  merge — the current ticket's messages move to the target and this one is closed + flagged. When
 *  already merged, shows the destination instead of the picker. */
export function MergePanel({ ticket, onMerged }: { ticket: Ticket; onMerged?: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Ticket[]>([]);
  const [searching, setSearching] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    debounce.current = setTimeout(() => {
      setSearching(true);
      searchTickets(term)
        .then((ts) => setResults(ts.filter((t) => t.id !== ticket.id && !t.merged_into).slice(0, 6)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [q, ticket.id]);

  async function merge(target: Ticket) {
    setMerging(true);
    setError(null);
    try {
      await mergeTicket(ticket.id, target.id);
      onMerged?.();
    } catch {
      setError("Couldn't merge — the other ticket may already be merged.");
    } finally {
      setMerging(false);
    }
  }

  if (ticket.merged_into) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <GitMerge className="size-3.5" /> Merged into another ticket as a duplicate.
      </p>
    );
  }

  // Hosted inside the thread overflow popover (it supplies the title row) —
  // picking "Merge duplicate…" from the menu IS the intent, so go straight
  // to the target search, no second "Mark as duplicate…" gate.
  return (
    <section>
      {
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Search for the ticket this duplicates — its messages move there and this one closes.</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search tickets…"
              className="h-8 pl-8 text-sm"
              autoFocus
            />
          </div>
          {searching && <p className="flex items-center gap-1 text-micro text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> Searching…</p>}
          {!searching && q.trim().length >= 2 && results.length === 0 && (
            <p className="text-micro text-muted-foreground">No matching tickets.</p>
          )}
          <ul className="space-y-1">
            {results.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={merging}
                  onClick={() => void merge(t)}
                  className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                  <span className="shrink-0 text-micro text-muted-foreground">{t.status}</span>
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="text-xs text-warning">{error}</p>}
        </div>
      }
    </section>
  );
}
