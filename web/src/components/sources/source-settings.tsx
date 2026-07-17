import { useState, type FormEvent } from "react";
import { Loader2, Save, ShieldCheck, Clock } from "lucide-react";
import {
  updateSource,
  type SourceRow,
  type SourceConfig,
} from "@/lib/sources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Editable settings for one live source — the write half of the source detail
// page. Replaces the old read-only <dl>. Saves via updateSource(id, {label,
// config}); the github token is WRITE-ONLY (never rendered, preserved unless a
// new one is typed). A dirty state gates Save; the returned masked row is bubbled
// up via onSaved so the header/title stay in sync.
// ─────────────────────────────────────────────────────────────────────────────

// Full http(s) URL — mirrors the add-connection form's validation.
function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
// owner/name — GitHub's slug shape (letters, digits, dot, dash, underscore).
const GITHUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
function isGithubRepo(v: string): boolean {
  return GITHUB_REPO_RE.test(v.trim());
}

// Sync-cadence choices. Stored in config.sync_interval_minutes (0 = manual).
// Honest: this is a saved *preference* — no scheduler runs it yet.
const CADENCE_OPTIONS: ComboOption[] = [
  { value: "0", label: "Manual only", icon: Clock },
  { value: "60", label: "Every hour", icon: Clock },
  { value: "360", label: "Every 6 hours", icon: Clock },
  { value: "720", label: "Every 12 hours", icon: Clock },
  { value: "1440", label: "Every day", icon: Clock },
  { value: "10080", label: "Every week", icon: Clock },
];

// The editable text/number fields, all held as strings for controlled inputs.
interface FormState {
  label: string;
  url: string;
  repo: string;
  branch: string;
  path: string;
  channelId: string;
  guildId: string;
  limit: string;
  syncInterval: string;
}

const FORM_KEYS: (keyof FormState)[] = [
  "label",
  "url",
  "repo",
  "branch",
  "path",
  "channelId",
  "guildId",
  "limit",
  "syncInterval",
];

function formFromSource(s: SourceRow): FormState {
  const c = s.config ?? {};
  return {
    label: s.label ?? "",
    url: c.url ?? "",
    repo: c.repo ?? "",
    branch: c.branch ?? "",
    path: c.path ?? "",
    channelId: c.channelId ?? "",
    guildId: c.guildId ?? "",
    limit: c.limit != null ? String(c.limit) : "",
    syncInterval: String(c.sync_interval_minutes ?? 0),
  };
}

export function SourceSettings({
  source,
  onSaved,
}: {
  source: SourceRow;
  /** Called with the server's masked row after a successful save. */
  onSaved: (updated: SourceRow) => void;
}) {
  // Initialize once per mount. The detail page keys <SourceDetail> by sourceId,
  // so this component remounts on source change — a background poll refreshing
  // `source` (doc_count climbing mid-crawl) never blows away in-progress edits.
  const [form, setForm] = useState<FormState>(() => formFromSource(source));
  const [baseline, setBaseline] = useState<FormState>(() => formFromSource(source));
  const [replacingToken, setReplacingToken] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasToken = !!source.config?.has_token;
  // The github token input is shown when there's nothing stored yet, or the user
  // clicked "Replace token". Otherwise we render a "Credential set" chip.
  const showTokenInput = source.kind === "github" && (!hasToken || replacingToken);
  const tokenProvided = newToken.trim().length > 0;

  const fieldsDirty = FORM_KEYS.some((k) => form[k] !== baseline[k]);
  const tokenDirty = showTokenInput && tokenProvided;
  const dirty = fieldsDirty || tokenDirty;

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setError(null);
  }

  // Validate the current kind's fields and assemble the patch, or null + set an
  // error. Never sends `has_token`; only sends `token` when a new one is typed.
  function buildPatch(): { label?: string; config: SourceConfig } | null {
    const base: SourceConfig = { ...(source.config ?? {}) };
    delete base.has_token;
    delete base.token;

    const config: SourceConfig = { ...base, sync_interval_minutes: Number(form.syncInterval) || 0 };

    if (source.kind === "url") {
      const url = form.url.trim();
      if (!isHttpUrl(url)) {
        setError("Enter a full http:// or https:// address.");
        return null;
      }
      config.url = url;
    } else if (source.kind === "github") {
      const repo = form.repo.trim();
      if (!isGithubRepo(repo)) {
        setError("Enter the repository as owner/name (e.g. facebook/react).");
        return null;
      }
      config.repo = repo;
      config.branch = form.branch.trim() || undefined;
      config.path = form.path.trim() || undefined;
      const token = newToken.trim();
      if (showTokenInput && token) config.token = token; // else PRESERVED server-side
    } else {
      const channelId = form.channelId.trim();
      if (!channelId) {
        setError("Enter the Discord channel ID.");
        return null;
      }
      config.channelId = channelId;
      config.guildId = form.guildId.trim() || undefined;
      const raw = form.limit.trim();
      if (raw) {
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit <= 0) {
          setError("Max messages must be a positive whole number.");
          return null;
        }
        config.limit = limit;
      } else {
        config.limit = undefined;
      }
    }

    return { label: form.label.trim(), config };
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const patch = buildPatch();
    if (!patch) return;
    setSaving(true);
    try {
      const updated = await updateSource(source.id, patch);
      onSaved(updated); // bubble the masked row up so the header/title re-sync
      const next = formFromSource(updated);
      setForm(next);
      setBaseline(next);
      setReplacingToken(false);
      setNewToken("");
      toast.success("Settings saved.");
    } catch {
      setError("Couldn't save your changes. Please try again.");
      toast.error("Couldn't save settings.");
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setForm(baseline);
    setReplacingToken(false);
    setNewToken("");
    setError(null);
  }

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Settings
        </h3>
        {dirty && (
          <Badge variant="warning" className="text-micro">
            Unsaved changes
          </Badge>
        )}
      </div>

      <form onSubmit={(e) => void save(e)} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
        {/* Common: label */}
        <div className="space-y-1.5">
          <Label htmlFor="set-label" className="text-xs">
            Label <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="set-label"
            value={form.label}
            onChange={(e) => set("label", e.target.value)}
            placeholder="Product docs"
            className="h-9 text-sm"
            autoComplete="off"
          />
          <p className="text-micro text-muted-foreground">
            A friendly name shown in your sources list. Leave blank to use the target.
          </p>
        </div>

        {/* url kind */}
        {source.kind === "url" && (
          <div className="space-y-1.5">
            <Label htmlFor="set-url" className="text-xs">
              URL
            </Label>
            <Input
              id="set-url"
              value={form.url}
              onChange={(e) => set("url", e.target.value)}
              placeholder="https://docs.example.com"
              className="h-9 text-sm"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          </div>
        )}

        {/* github kind */}
        {source.kind === "github" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="set-repo" className="text-xs">
                Repository
              </Label>
              <Input
                id="set-repo"
                value={form.repo}
                onChange={(e) => set("repo", e.target.value)}
                placeholder="owner/name"
                className="h-9 text-sm"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="set-branch" className="text-xs">
                  Branch <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="set-branch"
                  value={form.branch}
                  onChange={(e) => set("branch", e.target.value)}
                  placeholder="default"
                  className="h-9 text-sm"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="set-path" className="text-xs">
                  Path <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="set-path"
                  value={form.path}
                  onChange={(e) => set("path", e.target.value)}
                  placeholder="docs/"
                  className="h-9 text-sm"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>

            {/* write-only token: masked when set, revealed only on "Replace" */}
            <div className="space-y-1.5">
              <Label htmlFor="set-token" className="text-xs">
                Access token{" "}
                <span className="font-normal text-muted-foreground">(for private repos)</span>
              </Label>
              {hasToken && !replacingToken ? (
                <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80">
                    <ShieldCheck className="size-3.5 text-success" />
                    Credential set
                    <span className="font-normal text-muted-foreground">· hidden for security</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setReplacingToken(true)}
                  >
                    Replace token
                  </Button>
                </div>
              ) : (
                <>
                  <Input
                    id="set-token"
                    type="password"
                    value={newToken}
                    onChange={(e) => setNewToken(e.target.value)}
                    placeholder={hasToken ? "Enter a new token" : "ghp_…"}
                    className="h-9 text-sm"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-micro text-muted-foreground">
                      {hasToken
                        ? "Leave blank to keep the current token. Stored encrypted, never shown again."
                        : "Only needed for private repos. Stored encrypted, never shown again."}
                    </p>
                    {hasToken && (
                      <button
                        type="button"
                        onClick={() => {
                          setReplacingToken(false);
                          setNewToken("");
                        }}
                        className="text-micro font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* discord kind */}
        {source.kind === "discord" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="set-channel" className="text-xs">
                Channel ID
              </Label>
              <Input
                id="set-channel"
                value={form.channelId}
                onChange={(e) => set("channelId", e.target.value)}
                placeholder="123456789012345678"
                className="h-9 text-sm"
                autoComplete="off"
                spellCheck={false}
                inputMode="numeric"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="set-guild" className="text-xs">
                  Guild ID <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="set-guild"
                  value={form.guildId}
                  onChange={(e) => set("guildId", e.target.value)}
                  placeholder="server ID"
                  className="h-9 text-sm"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="set-limit" className="text-xs">
                  Max messages <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="set-limit"
                  type="number"
                  min={1}
                  value={form.limit}
                  onChange={(e) => set("limit", e.target.value)}
                  placeholder="500"
                  className="h-9 text-sm"
                  autoComplete="off"
                />
              </div>
            </div>
          </>
        )}

        {/* Sync cadence — a saved preference (no scheduler yet) */}
        <div className="space-y-1.5 border-t pt-4">
          <Label htmlFor="set-cadence" className="text-xs">
            Sync frequency
          </Label>
          <Combobox
            value={form.syncInterval}
            onChange={(v) => set("syncInterval", v)}
            options={CADENCE_OPTIONS}
            searchable={false}
            triggerClassName="flex w-full sm:max-w-xs"
            className="w-full"
          />
          <p className="text-micro text-muted-foreground">
            Saved as a preference — automatic scheduling isn't wired up yet. Use{" "}
            <span className="font-medium text-foreground">Sync now</span> to crawl on demand.
          </p>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center gap-2 border-t pt-4">
          <Button type="submit" size="sm" className="gap-1.5" disabled={!dirty || saving}>
            {saving ? (
              <>
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Saving…
              </>
            ) : (
              <>
                <Save className="size-3.5" /> Save changes
              </>
            )}
          </Button>
          {dirty && !saving && (
            <Button type="button" size="sm" variant="ghost" onClick={discard}>
              Discard
            </Button>
          )}
          <span
            className={cn(
              "ml-auto text-micro tabular-nums transition-opacity motion-reduce:transition-none",
              dirty ? "text-muted-foreground opacity-100" : "opacity-0",
            )}
            aria-live="polite"
          >
            Unsaved changes
          </span>
        </div>
      </form>
    </section>
  );
}
