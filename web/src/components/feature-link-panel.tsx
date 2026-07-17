import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, Loader2, X } from "lucide-react";
import { type FeatureStatus, STATUS_META, fetchFeatureRequests, fetchTicketFeatures, linkTicketToFeature, unlinkTicketFromFeature, createFeatureRequest } from "@/lib/features";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/** Ticket rail panel — link this conversation as evidence for a feature request (or spin up a new
 *  one from it). The count of linked tickets is the demand signal on the feature board. */
export function FeatureLinkPanel({ ticketId }: { ticketId: string }) {
  const [linked, setLinked] = useState<{ id: string; title: string; status: FeatureStatus }[]>([]);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; title: string; status: FeatureStatus }[]>([]);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    fetchTicketFeatures(ticketId).then(setLinked).catch(() => setLinked([]));
  }, [ticketId]);
  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!adding) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      setLoading(true);
      const linkedIds = new Set(linked.map((l) => l.id));
      fetchFeatureRequests()
        .then((rs) => {
          const term = q.trim().toLowerCase();
          setResults(rs.filter((r) => !linkedIds.has(r.id) && (!term || r.title.toLowerCase().includes(term))).slice(0, 6));
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [q, adding, linked]);

  async function link(id: string) {
    await linkTicketToFeature(id, ticketId).catch(() => {});
    setQ(""); setResults([]); setAdding(false);
    load();
  }

  async function createAndLink() {
    const title = q.trim();
    if (!title) return;
    try {
      const r = await createFeatureRequest({ title });
      await linkTicketToFeature(r.id, ticketId);
      setQ(""); setResults([]); setAdding(false);
      load();
    } catch { /* ignore */ }
  }

  async function unlink(id: string) {
    setLinked((ls) => ls.filter((l) => l.id !== id));
    await unlinkTicketFromFeature(id, ticketId).catch(() => load());
  }

  // Hosted inside the thread overflow popover (it supplies the title row).
  return (
    <section>
      {!adding && (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Link
          </Button>
        </div>
      )}

      {linked.length > 0 && (
        <ul className="mt-2 space-y-1">
          {linked.map((l) => (
            <li key={l.id} className="group flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">{l.title}</span>
              <Badge variant="outline" className="shrink-0">{STATUS_META[l.status].label}</Badge>
              <button type="button" onClick={() => void unlink(l.id)} className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:opacity-100" aria-label="Unlink">
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
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find or create a request…" className="h-8 pl-8 text-sm" autoFocus />
          </div>
          {loading && <p className="flex items-center gap-1 text-micro text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> Searching…</p>}
          <ul className="space-y-1">
            {results.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => void link(r.id)} className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-xs hover:bg-muted">
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <Badge variant="outline" className="shrink-0">{STATUS_META[r.status].label}</Badge>
                </button>
              </li>
            ))}
          </ul>
          {q.trim() && !results.some((r) => r.title.toLowerCase() === q.trim().toLowerCase()) && (
            <Button size="sm" variant="outline" className="h-7 w-full gap-1 text-xs" onClick={() => void createAndLink()}>
              <Plus className="size-3.5" /> Create “{q.trim()}” &amp; link
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setAdding(false); setQ(""); }}>Cancel</Button>
        </div>
      )}

      {!adding && linked.length === 0 && <p className="mt-1.5 text-xs text-muted-foreground">Not linked to any request.</p>}
    </section>
  );
}
