import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Lightbulb, Plus, Loader2, MessageSquare, ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import {
  type FeatureRequest,
  type FeatureRequestDetail,
  type FeatureStatus,
  FEATURE_STATUSES,
  STATUS_META,
  fetchFeatureRequests,
  fetchFeatureRequest,
  createFeatureRequest,
  updateFeatureRequest,
  deleteFeatureRequest,
  unlinkTicketFromFeature,
} from "@/lib/features";
import { relativeTime } from "@/lib/tickets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toaster";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { FormDialog } from "@/components/ui/form-dialog";
import { TAB_BASE, TAB_OFF, TAB_ON } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

// Feature-request board — the voice-of-customer backlog. Requests are grouped by lifecycle status and
// ordered by evidence (linked tickets), so the most-demanded, least-done work surfaces at the top.

const ORDER: FeatureStatus[] = ["open", "planned", "in_progress", "shipped", "declined"];

export function FeaturesPage() {
  const [requests, setRequests] = useState<FeatureRequest[] | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sort, setSort] = useState<"demand" | "newest">("demand");

  const load = () => {
    setRequests(null); setError(false);
    fetchFeatureRequests().then(setRequests).catch(() => setError(true));
  };
  useEffect(() => load(), []);

  async function create() {
    const t = title.trim();
    if (!t) return;
    try {
      await createFeatureRequest({ title: t, description: desc.trim() || undefined });
      setTitle(""); setDesc(""); setCreating(false);
      toast.success("Feature request created.");
      load();
    } catch {
      toast.error("Couldn't create the request.");
    }
  }

  async function setStatus(id: string, status: FeatureStatus) {
    setRequests((prev) => prev?.map((r) => (r.id === id ? { ...r, status } : r)) ?? null);
    try {
      await updateFeatureRequest(id, { status });
    } catch {
      toast.error("Couldn't update status."); load();
    }
  }

  async function remove(id: string) {
    if (expanded === id) setExpanded(null);
    setRequests((prev) => prev?.filter((r) => r.id !== id) ?? null);
    try { await deleteFeatureRequest(id); } catch { toast.error("Couldn't delete."); load(); }
  }

  // Client-side ranking over the already-loaded array. Default "demand" = most ticket evidence first,
  // so the board reflects what customers are pushing for; "newest" falls back to recency.
  const sortItems = (items: FeatureRequest[]) =>
    [...items].sort((a, b) =>
      sort === "demand"
        ? b.evidence_count - a.evidence_count || +new Date(b.created_at) - +new Date(a.created_at)
        : +new Date(b.created_at) - +new Date(a.created_at),
    );
  const grouped = ORDER.map((s) => ({ status: s, items: sortItems((requests ?? []).filter((r) => r.status === s)) })).filter((g) => g.items.length > 0);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* ── pane header (h-12, §3) ─────────────────────────────────────── */}
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          <h1 className="text-sm font-semibold tracking-tight">Feature requests</h1>
          {requests != null && (
            <span className="text-xs tabular-nums text-muted-foreground">{requests.length}</span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {requests && requests.length > 0 && (
              <div
                role="tablist"
                aria-label="Sort feature requests"
                className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5"
              >
                {(["demand", "newest"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={sort === k}
                    onClick={() => setSort(k)}
                    className={cn(TAB_BASE, sort === k ? TAB_ON : TAB_OFF)}
                  >
                    {k === "demand" ? "Most requested" : "Newest"}
                  </button>
                ))}
              </div>
            )}
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> New request
            </Button>
          </div>
        </header>

        <FormDialog
          open={creating}
          title="New feature request"
          description="Name the ask — link the tickets that back it afterwards."
          onClose={() => { setCreating(false); setTitle(""); setDesc(""); }}
          onSubmit={() => void create()}
          submitLabel="Create"
          submitDisabled={!title.trim()}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What are they asking for?" autoFocus />
          <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="Optional detail…" className="resize-y" />
        </FormDialog>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <ErrorState title="Couldn't load feature requests" onRetry={load} />
          ) : !requests ? (
            <RowsSkeleton rows={8} />
          ) : requests.length === 0 ? (
            <EmptyState
              icon={Lightbulb}
              title="No feature requests yet"
              description="Create one, then link the tickets that ask for it."
            />
          ) : (
            <div className="pb-6">
              {grouped.map((g) => (
                <section key={g.status}>
                  <h2 className="flex items-center gap-2 px-4 pb-1.5 pt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {STATUS_META[g.status].label}
                    <span className="font-mono font-medium tabular-nums text-muted-foreground/70">{g.items.length}</span>
                  </h2>
                  <ul className="divide-y divide-border/50">
                    {g.items.map((r) => (
                      <FeatureCard
                        key={r.id}
                        request={r}
                        expanded={expanded === r.id}
                        onToggle={() => setExpanded((e) => (e === r.id ? null : r.id))}
                        onStatus={(s) => void setStatus(r.id, s)}
                        onRemove={() => void remove(r.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function FeatureCard({ request, expanded, onToggle, onStatus, onRemove }: {
  request: FeatureRequest;
  expanded: boolean;
  onToggle: () => void;
  onStatus: (s: FeatureStatus) => void;
  onRemove: () => void;
}) {
  const [detail, setDetail] = useState<FeatureRequestDetail | null>(null);

  useEffect(() => {
    if (expanded && !detail) fetchFeatureRequest(request.id).then(setDetail).catch(() => {});
  }, [expanded, detail, request.id]);

  return (
    <li>
      {/* Full-bleed row — the group header already names the status, so the row
          carries no status chip (§4/§5). Evidence tally stays left-anchored. */}
      <div
        className={cn(
          "flex items-start gap-3 px-4 py-3 transition-colors",
          expanded ? "bg-muted/30" : "hover:bg-muted/50",
        )}
      >
        <div
          className="flex w-10 shrink-0 flex-col items-center gap-0.5 pt-0.5 text-center"
          title={`${request.evidence_count} ticket${request.evidence_count === 1 ? "" : "s"} backing this request`}
        >
          <MessageSquare className="size-3.5 text-muted-foreground" />
          <span className="font-mono text-sm font-semibold leading-none tabular-nums text-muted-foreground">{request.evidence_count}</span>
        </div>
        <button onClick={onToggle} className="min-w-0 flex-1 text-left" aria-expanded={expanded} aria-label={expanded ? "Collapse" : "Expand"}>
          <span className="text-sm font-medium">{request.title}</span>
          {request.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{request.description}</p>}
          <div className="mt-1 text-xs tabular-nums text-muted-foreground/70">Updated {relativeTime(request.updated_at)}</div>
        </button>
        <button onClick={onToggle} className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground" aria-label={expanded ? "Collapse" : "Expand"}>
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border/50 bg-muted/20 px-4 py-3">
          {request.description && <p className="mb-3 whitespace-pre-wrap text-sm text-foreground/90">{request.description}</p>}
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Status</span>
            {FEATURE_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => onStatus(s)}
                className={cn("rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
                  request.status === s ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")}
              >
                {STATUS_META[s].label}
              </button>
            ))}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Evidence — {request.evidence_count} {request.evidence_count === 1 ? "ticket" : "tickets"}</p>
            {!detail ? (
              <div className="py-2"><Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" /></div>
            ) : detail.tickets.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tickets linked yet. Link one from a conversation's rail.</p>
            ) : (
              <ul className="space-y-1">
                {detail.tickets.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs">
                    <Link to="/" search={{ ticket: t.id }} className="min-w-0 flex-1 truncate hover:underline">{t.subject || "(no subject)"}</Link>
                    <Badge variant="outline" className="shrink-0 capitalize">{t.status}</Badge>
                    <button
                      onClick={() => { void unlinkTicketFromFeature(request.id, t.id); setDetail((d) => d ? { ...d, tickets: d.tickets.filter((x) => x.id !== t.id) } : d); }}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label="Unlink"
                    ><X className="size-3.5" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive" onClick={onRemove}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
