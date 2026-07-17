import { useEffect, useRef, useState } from "react";
import {
  KeyRound,
  Check,
  Copy,
  AlertTriangle,
  Loader2,
  Trash2,
  ShieldCheck,
  Terminal,
  MessagesSquare,
  Sparkles,
  ChevronDown,
  Plus,
} from "lucide-react";
import { toast } from "@/components/ui/toaster";
import {
  type ApiKey,
  type ApiScope,
  API_SCOPES,
  SCOPE_LABELS,
  fetchApiKeys,
  createApiKey,
  revokeApiKey,
} from "@/lib/apikeys";
import { API_URL } from "@/lib/api";
import { EDGE_URL } from "@/lib/realtime";
import { relativeTime } from "@/lib/tickets";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormDialog } from "@/components/ui/form-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { SettingsRail } from "@/components/settings-rail";
import { cn } from "@/lib/utils";

type Status = "loading" | "ready" | "error";

export function SettingsApiKeysPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [keys, setKeys] = useState<ApiKey[]>([]);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<ApiScope>>(new Set(["answer"]));
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<{ prefix: string; secret: string } | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);

  const load = useRef(async () => {
    setStatus("loading");
    try {
      setKeys(await fetchApiKeys());
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  function toggleScope(s: ApiScope, on: boolean) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (on) next.add(s);
      else next.delete(s);
      return next;
    });
  }

  function openNew() {
    setName("");
    setScopes(new Set(["answer"]));
    setFormError(null);
    setFormOpen(true);
  }

  async function create() {
    setFormError(null);
    if (scopes.size === 0) {
      setFormError("Pick at least one scope.");
      return;
    }
    setCreating(true);
    try {
      const { key, secret } = await createApiKey({
        name: name.trim() || undefined,
        scopes: API_SCOPES.filter((s) => scopes.has(s)),
      });
      setKeys((ks) => [key, ...ks]);
      setNewSecret({ prefix: key.keyPrefix, secret });
      setSecretCopied(false);
      setFormOpen(false);
      toast.success("API key created.");
    } catch {
      setFormError("Couldn't create the key. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  async function copy(text: string, mark: () => void) {
    try {
      await navigator.clipboard.writeText(text);
      mark();
    } catch {
      toast.error("Couldn't copy — select and copy it manually.");
    }
  }

  async function onRevoke(k: ApiKey) {
    const prev = keys;
    setKeys((ks) => ks.filter((x) => x.id !== k.id));
    try {
      await revokeApiKey(k.id);
      toast.success("Key revoked.");
    } catch {
      setKeys(prev);
      toast.error("Couldn't revoke the key.");
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <SettingsRail active="api-keys" />

        <div className="min-w-0 flex-1 overflow-y-auto">
          <header className="flex h-12 shrink-0 items-center gap-2 px-6">
            <h1 className="text-sm font-semibold tracking-tight">API keys</h1>
            {status === "ready" && keys.length > 0 && (
              <span className="text-sm tabular-nums text-muted-foreground">{keys.length}</span>
            )}
            {status === "ready" && (
              <Button size="sm" variant="brand" className="ml-auto h-8 gap-1.5" onClick={openNew}>
                <Plus className="size-4" /> New key
              </Button>
            )}
          </header>
          <p className="px-6 text-small text-muted-foreground">
            Secret keys for the public API — shown once at creation, so store them somewhere safe.
          </p>
          <div className="max-w-3xl px-6 pb-10 pt-4">
            {/* One-time secret callout */}
            {newSecret && (
              <div className="mb-5 space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-5">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">Your new API key</p>
                    <p className="text-xs text-muted-foreground">
                      Copy it now — it won't be shown again. Send it as an{" "}
                      <span className="font-mono">x-api-key</span> header.
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
                    onClick={() => void copy(newSecret.secret, () => { setSecretCopied(true); setTimeout(() => setSecretCopied(false), 2000); })}
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

            {/* Key list — the resting state, kept near the top */}
            {status === "loading" ? (
              <RowsSkeleton rows={4} />
            ) : status === "error" ? (
              <ErrorState title="Couldn't load your API keys" onRetry={() => void load()} />
            ) : keys.length === 0 ? (
              <EmptyState
                icon={KeyRound}
                title="No API keys yet"
                description="Create one to call the public API from your own backend."
                action={
                  <Button size="sm" variant="brand" className="gap-1.5" onClick={openNew}>
                    <Plus className="size-4" /> New key
                  </Button>
                }
              />
            ) : (
              <div className="space-y-3">
                {keys.map((k) => (
                  <ApiKeyRow key={k.id} apiKey={k} onRevoke={onRevoke} />
                ))}
              </div>
            )}

            {/* Docs & quickstart — collapsed by default so the key list leads */}
            <div className="mt-6 overflow-hidden rounded-xl border bg-card shadow-sm">
              <button
                type="button"
                onClick={() => setDocsOpen((o) => !o)}
                aria-expanded={docsOpen}
                className="flex w-full items-center justify-between gap-2 px-5 py-3.5 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Terminal className="size-4 text-muted-foreground" /> Docs &amp; quickstart
                </span>
                <ChevronDown
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
                    docsOpen && "rotate-180",
                  )}
                />
              </button>
              <div
                className={cn(
                  "grid transition-[grid-template-rows] duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
                  docsOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
              >
                <div className="overflow-hidden">
                  <div className="space-y-6 border-t px-5 py-5">
                    {/* Public API quickstart */}
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                          Public API <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-micro text-muted-foreground">v1</span>
                        </h3>
                        <a href={`${API_URL}/openapi.json`} target="_blank" rel="noreferrer" className="text-xs font-medium text-primary hover:underline">
                          OpenAPI spec →
                        </a>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Everything the UI does, the versioned <span className="font-mono">/v1</span> API does:
                        answers, tickets, and CSAT. Authenticate with the <span className="font-mono">x-api-key</span> header.
                      </p>
                      <pre className="mt-3 overflow-x-auto rounded-md border border-input bg-background p-3 text-micro leading-relaxed">
{`curl -X POST ${API_URL}/v1/public/answer \\
  -H "content-type: application/json" \\
  -H "x-api-key: sk_..." \\
  -d '{"question":"How do I reset my password?"}'

# → { answer, citations[], confidence, uncertain, model }`}
                      </pre>
                      <p className="mt-3 text-xs font-medium text-muted-foreground">Typed SDK (@repo/sdk)</p>
                      <pre className="mt-1.5 overflow-x-auto rounded-md border border-input bg-background p-3 text-micro leading-relaxed">
{`import { NoolaClient } from "@repo/sdk";

const noola = new NoolaClient({ apiKey: "sk_...", baseUrl: "${API_URL}" });
const { answer, uncertain } = await noola.answer("How do I reset my password?");
const { ticketId } = await noola.createTicket({ subject: "Help", body: "..." });
await noola.submitCsat({ ticketId, rating: 5 });`}
                      </pre>
                    </div>

                    {/* MCP server */}
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                          <Terminal className="size-4 text-muted-foreground" /> MCP server
                        </h3>
                        <a href={`${API_URL}/mcp/tools`} target="_blank" rel="noreferrer" className="text-xs font-medium text-primary hover:underline">
                          Tools manifest →
                        </a>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Connect an AI coding agent (Claude Desktop, Cursor…) to your knowledge + tickets.
                        Point it at the endpoint below with an API key as a Bearer token.
                      </p>
                      <pre className="mt-3 overflow-x-auto rounded-md border border-input bg-background p-3 text-micro leading-relaxed">
{`{
  "mcpServers": {
    "noola": {
      "url": "${API_URL}/v1/mcp",
      "headers": { "Authorization": "Bearer sk_..." }
    }
  }
}
// tools: search_knowledge, answer_question, create_ticket, list_tickets`}
                      </pre>
                    </div>

                    {/* Messenger widget */}
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                          <MessagesSquare className="size-4 text-muted-foreground" /> Messenger widget
                        </h3>
                        <a href="/messenger.html" target="_blank" rel="noreferrer" className="text-xs font-medium text-primary hover:underline">
                          Live demo →
                        </a>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Drop this one tag on any site for an embeddable chat bubble — instant AI answers
                        with a “talk to a human” hand-off. Use a <span className="font-mono">widget</span> key
                        (public, domain-allowlisted), not a secret API key. The optional
                        <span className="font-mono"> data-noola-edge</span> attribute streams agent replies
                        in real time (falls back to polling when omitted).
                      </p>
                      <pre className="mt-3 overflow-x-auto rounded-md border border-input bg-background p-3 text-micro leading-relaxed">
{`<script src="${API_URL}/widget.js"
  data-noola-key="wk_..."
  data-noola-api="${API_URL}"
  data-noola-edge="${EDGE_URL}"
  data-noola-title="Ask us anything"></script>`}
                      </pre>
                    </div>

                    {/* Docs "Ask AI" embed */}
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-semibold">
                        <Sparkles className="size-4 text-muted-foreground" /> Docs “Ask AI”
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        The lighter embed for documentation sites: an Ask-AI button that answers from
                        your published knowledge base with citations — no chat thread, no hand-off.
                        Same public <span className="font-mono">widget</span> key. Add
                        <span className="font-mono"> data-noola-mount="#selector"</span> to render the
                        button inline instead of floating.
                      </p>
                      <pre className="mt-3 overflow-x-auto rounded-md border border-input bg-background p-3 text-micro leading-relaxed">
{`<script src="${API_URL}/answers.js"
  data-noola-key="wk_..."
  data-noola-api="${API_URL}"
  data-noola-title="Ask AI"></script>`}
                      </pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <FormDialog
        open={formOpen}
        title="New API key"
        description="Name it and choose its scopes. The secret is shown once, right after you create it."
        onClose={() => setFormOpen(false)}
        onSubmit={() => void create()}
        submitLabel={creating ? "Creating…" : "Create key"}
        submitDisabled={scopes.size === 0}
        busy={creating}
      >
        <div className="space-y-1.5">
          <Label htmlFor="keyname">Name <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input
            id="keyname"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production backend"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="space-y-2">
          <Label>Scopes</Label>
          <div className="grid gap-2">
            {API_SCOPES.map((s) => {
              const on = scopes.has(s);
              return (
                <label
                  key={s}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                    on ? "border-primary/50 bg-primary/5" : "border-input hover:bg-muted/50",
                  )}
                >
                  <Checkbox checked={on} onCheckedChange={(v) => toggleScope(s, v)} />
                  <span className="min-w-0">
                    <span className="block truncate">{SCOPE_LABELS[s]}</span>
                    <span className="block truncate font-mono text-micro text-muted-foreground">{s}</span>
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

function ApiKeyRow({ apiKey: k, onRevoke }: { apiKey: ApiKey; onRevoke: (k: ApiKey) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await onRevoke(k);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{k.name || "Untitled key"}</span>
            <code className="shrink-0 font-mono text-micro text-muted-foreground">
              {k.keyPrefix}…
            </code>
          </div>
          <div className="mt-1 truncate font-mono text-micro text-muted-foreground">
            {k.scopes.length === 0 ? "No scopes" : k.scopes.join(" · ")}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Created {relativeTime(k.createdAt)}
            {k.lastUsedAt ? ` · last used ${relativeTime(k.lastUsedAt)}` : " · never used"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs text-muted-foreground">Revoke?</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void run()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : "Revoke"}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(true)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 /> Revoke
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
