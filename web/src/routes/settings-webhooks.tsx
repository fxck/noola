import { useEffect, useRef, useState } from "react";
import {
  Webhook as WebhookIcon,
  Check,
  Copy,
  AlertTriangle,
  Loader2,
  Plug,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronRight,
  PlugZap,
  ShieldCheck,
  Plus,
} from "lucide-react";
import { toast } from "@/components/ui/toaster";
import {
  type Webhook,
  type Delivery,
  EVENT_TYPES,
  EVENT_LABELS,
  fetchWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  fetchDeliveries,
} from "@/lib/webhooks";
import type { ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/tickets";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormDialog } from "@/components/ui/form-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { SettingsRail } from "@/components/settings-rail";
import { cn } from "@/lib/utils";

type Status = "loading" | "ready" | "error" | "unavailable";

function eventLabel(e: string): string {
  return EVENT_LABELS[e] ?? e;
}

// Accept only a public http(s) URL. Rejects loopback / link-local / RFC1918 / metadata
// literals up front (immediate UX + defense-in-depth); the server re-checks after DNS
// resolution, which is the authoritative SSRF guard.
function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      host.endsWith(".local") ||
      host === "0.0.0.0" ||
      host === "::1"
    ) {
      return false;
    }
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (
        a === 0 ||
        a === 127 ||
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function SettingsWebhooksPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);

  // The one add/edit surface: `null` closed, `"new"` create, a Webhook to edit.
  const [editing, setEditing] = useState<Webhook | "new" | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Set<string>>(new Set(EVENT_TYPES));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The one-time secret callout for the endpoint we just created.
  const [newSecret, setNewSecret] = useState<{ url: string; secret: string } | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  const load = useRef(async () => {
    setStatus("loading");
    try {
      setWebhooks(await fetchWebhooks());
      setStatus("ready");
    } catch (e) {
      setStatus((e as ApiError)?.status === 404 ? "unavailable" : "error");
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  function toggleEvent(e: string, on: boolean) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (on) next.add(e);
      else next.delete(e);
      return next;
    });
  }

  function openNew() {
    setUrl("");
    setEvents(new Set(EVENT_TYPES));
    setFormError(null);
    setEditing("new");
  }

  function openEdit(w: Webhook) {
    setUrl(w.url);
    setEvents(new Set(w.events));
    setFormError(null);
    setEditing(w);
  }

  async function save() {
    setFormError(null);
    if (!isHttpUrl(url)) {
      setFormError("Enter a valid http(s) URL.");
      return;
    }
    if (events.size === 0) {
      setFormError("Pick at least one event to send.");
      return;
    }
    const chosen = EVENT_TYPES.filter((e) => events.has(e));
    setSaving(true);
    try {
      if (editing === "new") {
        const { webhook, secret } = await createWebhook({ url: url.trim(), events: chosen });
        setWebhooks((ws) => [webhook, ...ws]);
        setNewSecret({ url: webhook.url, secret });
        setSecretCopied(false);
        toast.success("Webhook endpoint added.");
      } else if (editing) {
        const saved = await updateWebhook(editing.id, { url: url.trim(), events: chosen });
        setWebhooks((ws) => ws.map((x) => (x.id === saved.id ? saved : x)));
        toast.success("Webhook endpoint updated.");
      }
      setEditing(null);
    } catch {
      setFormError("Couldn't save the endpoint. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select and copy it manually.");
    }
  }

  // Optimistic active-toggle; reconcile to server, revert + toast on failure.
  async function onToggleActive(w: Webhook, active: boolean) {
    setWebhooks((ws) => ws.map((x) => (x.id === w.id ? { ...x, active } : x)));
    try {
      const saved = await updateWebhook(w.id, { active });
      setWebhooks((ws) => ws.map((x) => (x.id === w.id ? saved : x)));
    } catch {
      setWebhooks((ws) => ws.map((x) => (x.id === w.id ? { ...x, active: !active } : x)));
      toast.error("Couldn't update the endpoint.");
    }
  }

  async function onDelete(w: Webhook) {
    const prev = webhooks;
    setWebhooks((ws) => ws.filter((x) => x.id !== w.id));
    try {
      await deleteWebhook(w.id);
      toast.success("Webhook endpoint deleted.");
    } catch {
      setWebhooks(prev);
      toast.error("Couldn't delete the endpoint.");
    }
  }

  async function onTest(w: Webhook): Promise<Delivery | null> {
    try {
      const d = await testWebhook(w.id);
      if (d.ok) {
        toast.success(`Test ping delivered${d.status_code ? ` (HTTP ${d.status_code})` : ""}.`);
      } else {
        toast.error(
          d.error
            ? `Test ping failed: ${d.error}`
            : `Test ping failed${d.status_code ? ` (HTTP ${d.status_code})` : ""}.`,
        );
      }
      return d;
    } catch {
      toast.error("Couldn't send the test ping.");
      return null;
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <SettingsRail active="webhooks" />

        {/* ── page body ─────────────────────────────────────────── */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <header className="flex h-12 shrink-0 items-center gap-2 px-6">
            <h1 className="text-sm font-semibold tracking-tight">Webhooks</h1>
            {status === "ready" && webhooks.length > 0 && (
              <span className="text-sm tabular-nums text-muted-foreground">{webhooks.length}</span>
            )}
            {status === "ready" && (
              <Button size="sm" variant="brand" className="ml-auto h-8 gap-1.5" onClick={openNew}>
                <Plus className="size-4" /> New webhook
              </Button>
            )}
          </header>
          <p className="px-6 text-small text-muted-foreground">
            Send contact, ticket, and message events to your own systems as signed POSTs.
          </p>
          <div className="max-w-3xl px-6 pb-10 pt-4">
            {/* ── One-time secret callout ──────────────────────── */}
            {newSecret && (
              <div className="mb-5 space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-5">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">Signing secret for {newSecret.url}</p>
                    <p className="text-xs text-muted-foreground">
                      Save this now — it won't be shown again. Sign verification: HMAC-SHA256, header{" "}
                      <span className="font-mono">X-Noola-Signature</span>.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-input bg-background px-3 py-2 font-mono text-xs">
                    {newSecret.secret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copySecret(newSecret.secret)}
                    className="shrink-0"
                  >
                    {secretCopied ? (
                      <>
                        <Check className="text-success" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy /> Copy
                      </>
                    )}
                  </Button>
                </div>
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => setNewSecret(null)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {/* ── Endpoint list (resting state) ────────────────── */}
            {status === "loading" ? (
              <RowsSkeleton rows={4} />
            ) : status === "error" ? (
              <ErrorState title="Couldn't load your webhook endpoints" onRetry={() => void load()} />
            ) : status === "unavailable" ? (
              <EmptyState
                icon={PlugZap}
                title="Webhooks aren't available yet"
                description="They'll appear here once outbound events are enabled for this workspace."
              />
            ) : webhooks.length === 0 ? (
              <EmptyState
                icon={WebhookIcon}
                title="No webhooks yet"
                description="Add an endpoint to receive contact & ticket events as signed POSTs."
                action={
                  <Button size="sm" variant="brand" className="gap-1.5" onClick={openNew}>
                    <Plus className="size-4" /> New webhook
                  </Button>
                }
              />
            ) : (
              <div className="space-y-3">
                {webhooks.map((w) => (
                  <WebhookRow
                    key={w.id}
                    webhook={w}
                    onEdit={openEdit}
                    onToggleActive={onToggleActive}
                    onDelete={onDelete}
                    onTest={onTest}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <FormDialog
        open={editing !== null}
        size="lg"
        title={editing === "new" ? "New webhook" : "Edit webhook"}
        description="We'll POST a signed payload to this endpoint for the events you pick."
        onClose={() => setEditing(null)}
        onSubmit={() => void save()}
        submitLabel={saving ? "Saving…" : editing === "new" ? "Add endpoint" : "Save changes"}
        submitDisabled={!url.trim() || events.size === 0}
        busy={saving}
      >
        <div className="space-y-1.5">
          <Label htmlFor="url">Endpoint URL</Label>
          <Input
            id="url"
            autoFocus
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setFormError(null);
            }}
            placeholder="https://api.your-app.com/hooks/noola"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
          />
          <p className="text-xs text-muted-foreground">Must be a public http(s) URL.</p>
        </div>

        <div className="space-y-2">
          <Label>Events</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {EVENT_TYPES.map((e) => {
              const on = events.has(e);
              return (
                <label
                  key={e}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                    on ? "border-primary/50 bg-primary/5" : "border-input hover:bg-muted/50",
                  )}
                >
                  <Checkbox checked={on} onCheckedChange={(v) => toggleEvent(e, v)} />
                  <span className="min-w-0">
                    <span className="block truncate">{eventLabel(e)}</span>
                    <span className="block truncate font-mono text-micro text-muted-foreground">{e}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {formError && (
          <span className="flex items-center gap-1 text-sm text-destructive">
            <AlertTriangle className="size-3.5" /> {formError}
          </span>
        )}
      </FormDialog>
    </>
  );
}

// ── Single endpoint row ───────────────────────────────────────────────────────
function WebhookRow({
  webhook: w,
  onEdit,
  onToggleActive,
  onDelete,
  onTest,
}: {
  webhook: Webhook;
  onEdit: (w: Webhook) => void;
  onToggleActive: (w: Webhook, active: boolean) => Promise<void>;
  onDelete: (w: Webhook) => Promise<void>;
  onTest: (w: Webhook) => Promise<Delivery | null>;
}) {
  const [testing, setTesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [delivLoading, setDelivLoading] = useState(false);
  const [delivError, setDelivError] = useState(false);

  const loadDeliveries = useRef(async () => {
    setDelivLoading(true);
    setDelivError(false);
    try {
      setDeliveries(await fetchDeliveries(w.id));
    } catch {
      setDelivError(true);
    } finally {
      setDelivLoading(false);
    }
  }).current;

  function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && deliveries === null && !delivLoading) void loadDeliveries();
  }

  async function runTest() {
    setTesting(true);
    try {
      const d = await onTest(w);
      // Reflect the fresh attempt if the deliveries view is open.
      if (d && expanded) setDeliveries((prev) => [d, ...(prev ?? [])]);
      else if (d) setDeliveries(null); // force a refetch next expand
    } finally {
      setTesting(false);
    }
  }

  async function runDelete() {
    setDeleting(true);
    try {
      await onDelete(w);
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-mono text-sm font-medium" title={w.url}>
              {w.url}
            </span>
            {!w.active && (
              <span className="flex shrink-0 items-center gap-1.5 text-micro text-muted-foreground">
                <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden /> Paused
              </span>
            )}
          </div>
          <div className="mt-1 truncate font-mono text-micro text-muted-foreground">
            {w.events.length === 0 ? "No events subscribed" : w.events.join(" · ")}
          </div>
        </div>

        {/* Active toggle */}
        <Switch
          className="mt-0.5"
          checked={w.active}
          aria-label={w.active ? "Deactivate endpoint" : "Activate endpoint"}
          onCheckedChange={() => void onToggleActive(w, !w.active)}
        />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
        <Button variant="outline" size="sm" onClick={() => void runTest()} disabled={testing}>
          {testing ? (
            <>
              <Loader2 className="animate-spin motion-reduce:animate-none" /> Testing…
            </>
          ) : (
            <>
              <Plug /> Test
            </>
          )}
        </Button>

        <Button variant="ghost" size="sm" onClick={() => onEdit(w)}>
          <Pencil /> Edit
        </Button>

        <button
          type="button"
          onClick={toggleExpand}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Recent deliveries
        </button>

        <div className="ml-auto flex items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs text-muted-foreground">Delete this endpoint?</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void runDelete()} disabled={deleting}>
                {deleting ? (
                  <>
                    <Loader2 className="animate-spin motion-reduce:animate-none" /> Deleting…
                  </>
                ) : (
                  "Delete"
                )}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(true)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 /> Delete
            </Button>
          )}
        </div>
      </div>

      {/* Recent deliveries */}
      {expanded && (
        <div className="border-t px-4 py-3">
          {delivLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Loading deliveries…
            </div>
          ) : delivError ? (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <AlertTriangle className="size-3.5 text-muted-foreground/60" /> Couldn't load deliveries.
              <button
                type="button"
                onClick={() => void loadDeliveries()}
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                Retry
              </button>
            </div>
          ) : !deliveries || deliveries.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              No deliveries yet. Use Test to send a ping.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {deliveries.map((d, i) => (
                <DeliveryRow key={i} d={d} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── One delivery attempt row (quiet dot + text; failure earns the color) ──────
function DeliveryRow({ d }: { d: Delivery }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs">
      <span
        className={cn("size-1.5 shrink-0 rounded-full", d.ok ? "bg-muted-foreground/40" : "bg-destructive")}
        aria-hidden
      />
      <span className={cn(d.ok ? "text-muted-foreground" : "font-medium text-destructive")}>
        {d.ok ? "Delivered" : "Failed"}
      </span>
      {d.status_code != null && (
        <span className="font-mono text-muted-foreground">HTTP {d.status_code}</span>
      )}
      {d.event && (
        <span className="font-mono text-micro text-muted-foreground">{d.event}</span>
      )}
      {d.error && (
        <span className="min-w-0 truncate text-muted-foreground" title={d.error}>
          {d.error}
        </span>
      )}
      <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{relativeTime(d.created_at)}</span>
    </li>
  );
}
