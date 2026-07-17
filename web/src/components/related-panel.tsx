import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Loader2, Plus, Search, X } from "lucide-react";
import { type Ticket, searchTickets } from "@/lib/tickets";
import { type LinkedTicket, fetchLinks, linkTicket, unlinkTicket } from "@/lib/links";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Related tickets — non-destructive symmetric links (compare merge, which folds one into the
 *  other). List existing links + add new ones via search; unlink removes the relation only. */
export function RelatedPanel({ ticketId }: { ticketId: string }) {
  const [links, setLinks] = useState<LinkedTicket[]>([]);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Ticket[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    fetchLinks(ticketId).then(setLinks).catch(() => setLinks([]));
  }, [ticketId]);
  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!adding) return;
    if (debounce.current) clearTimeout(debounce.current);
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    debounce.current = setTimeout(() => {
      setSearching(true);
      const linkedIds = new Set([ticketId, ...links.map((l) => l.id)]);
      searchTickets(term)
        .then((ts) => setResults(ts.filter((t) => !linkedIds.has(t.id)).slice(0, 6)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [q, adding, ticketId, links]);

  async function add(t: Ticket) {
    setBusy(true);
    try {
      await linkTicket(ticketId, t.id);
      setQ(""); setResults([]); setAdding(false);
      load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setLinks((ls) => ls.filter((l) => l.id !== id)); // optimistic
    try {
      await unlinkTicket(ticketId, id);
    } catch {
      load();
    }
  }

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <h2 className="flex items-center gap-1.5 whitespace-nowrap text-micro font-semibold uppercase tracking-wide text-muted-foreground">
          <Link2 className="size-3.5" /> Related tickets
        </h2>
        {!adding && (
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Link
          </Button>
        )}
      </div>

      {links.length > 0 && (
        <ul className="mt-2 space-y-1">
          {links.map((l) => (
            <li key={l.id} className="group flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">{l.subject}</span>
              <span className="shrink-0 text-micro text-muted-foreground">{l.status}</span>
              <button
                type="button"
                onClick={() => void remove(l.id)}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:opacity-100"
                aria-label="Unlink"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mt-2 space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tickets…" className="h-8 pl-8 text-sm" autoFocus />
          </div>
          {searching && <p className="flex items-center gap-1 text-micro text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> Searching…</p>}
          <ul className="space-y-1">
            {results.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void add(t)}
                  className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                  <span className="shrink-0 text-micro text-muted-foreground">{t.status}</span>
                </button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setAdding(false); setQ(""); }}>Cancel</Button>
        </div>
      )}

      {!adding && links.length === 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">No linked tickets.</p>
      )}
    </section>
  );
}
