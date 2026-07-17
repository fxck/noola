import { useState, type ComponentType } from "react";
import { ChevronDown } from "lucide-react";
import { type SourceKind, type SourceConfig, REFRESH_PRESETS } from "@/lib/sources";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormDialog } from "@/components/ui/form-dialog";
import { Menu, MenuItem } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { KIND_COMBO, isHttpUrl, isGithubRepo } from "@/components/sources/source-lib";

/**
 * Popover value picker for this dialog. `Combobox` can't be used here: the FormDialog
 * overlay sits at z-[60] while ui/popover panels default to z-50, and only `Menu`
 * exposes the panel className needed to lift the menu above the overlay (the same
 * trick as settings-routing's DialogSelect). The trigger mirrors ui/input.tsx.
 */
function DialogSelect({
  value,
  options,
  onChange,
  autoFocus,
}: {
  value: string;
  options: { value: string; label: string; icon?: ComponentType<{ className?: string }> }[];
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  const Icon = current?.icon;
  return (
    // Popover wraps the trigger in a shrink-wrapping inline-flex span (Menu doesn't
    // forward triggerClassName), so stretch it here to keep the control full-width.
    <div className="[&>span]:w-full">
      <Menu
        align="start"
        width={224}
        className="z-[70]"
        trigger={(open, toggle) => (
          <button
            type="button"
            onClick={toggle}
            autoFocus={autoFocus}
            aria-haspopup="listbox"
            aria-expanded={open}
            className={cn(
              "inline-flex h-9 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-background px-3 py-1 text-sm font-normal shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              !current && "text-muted-foreground",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="truncate">{current?.label ?? "—"}</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      >
        {options.map((o) => (
          <MenuItem
            key={o.value || "__none"}
            icon={o.icon}
            label={o.label}
            selected={o.value === value}
            onSelect={() => onChange(o.value)}
          />
        ))}
      </Menu>
    </div>
  );
}

// Payload the parent needs to create + optimistically insert a source. The parent owns the
// `sources` list (and its optimistic-insert / reconcile logic), so this form is purely the
// field state + validation: it hands a validated payload up and reports success/failure.
export interface AddSourcePayload {
  kind: SourceKind;
  label: string;
  config: SourceConfig;
  refreshIntervalMinutes: number | null;
}

// The add-connection dialog: owns every field's state + per-kind validation, and delegates the
// actual create to `onCreate` (returns true on success). On success it resets + closes; on
// failure it surfaces a retry message. Renders as a FormDialog ("Add source") — the parent
// mounts it while open, so closing also discards the draft. Extracted from SourcesPage to keep
// that component focused on the list/selection surfaces.
export function AddSourceForm({
  onCreate,
  onClose,
}: {
  onCreate: (payload: AddSourcePayload) => Promise<boolean>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<SourceKind>("url");
  const [label, setLabel] = useState("");
  // auto-refresh cadence in minutes (null = manual only)
  const [refresh, setRefresh] = useState<number | null>(null);
  // url
  const [url, setUrl] = useState("");
  // github
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [token, setToken] = useState("");
  // discord
  const [channelId, setChannelId] = useState("");
  const [guildId, setGuildId] = useState("");
  const [limit, setLimit] = useState("");
  const [solvedOnly, setSolvedOnly] = useState(true);
  const [solvedTags, setSolvedTags] = useState("");
  const [solvedReaction, setSolvedReaction] = useState("");
  const [distill, setDistill] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    kind === "url"
      ? url.trim().length > 0
      : kind === "github"
        ? repo.trim().length > 0
        : channelId.trim().length > 0;

  function reset() {
    setUrl("");
    setRepo("");
    setBranch("");
    setPath("");
    setToken("");
    setChannelId("");
    setGuildId("");
    setLimit("");
    setSolvedOnly(true);
    setSolvedTags("");
    setSolvedReaction("");
    setDistill(true);
    setLabel("");
    setRefresh(null);
  }

  /** Validate the selected kind's fields and build its `config`, or null + set an error. */
  function buildConfig(): SourceConfig | null {
    if (kind === "url") {
      const u = url.trim();
      if (!isHttpUrl(u)) {
        setError("Enter a full http:// or https:// address.");
        return null;
      }
      return { url: u };
    }
    if (kind === "github") {
      const r = repo.trim();
      if (!isGithubRepo(r)) {
        setError("Enter the repository as owner/name (e.g. facebook/react).");
        return null;
      }
      return {
        repo: r,
        branch: branch.trim() || undefined,
        path: path.trim() || undefined,
        token: token.trim() || undefined,
      };
    }
    // discord
    const ch = channelId.trim();
    if (!ch) {
      setError("Enter the Discord channel ID.");
      return null;
    }
    let lim: number | undefined;
    const raw = limit.trim();
    if (raw) {
      lim = Number(raw);
      if (!Number.isInteger(lim) || lim <= 0) {
        setError("Max messages must be a positive whole number.");
        return null;
      }
    }
    return {
      channelId: ch,
      guildId: guildId.trim() || undefined,
      limit: lim,
      solvedOnly,
      solvedTags: solvedTags.trim() || undefined,
      solvedReaction: solvedReaction.trim() || undefined,
      distill: distill ? undefined : false, // default ON — only persist the opt-out
    };
  }

  async function submit() {
    setError(null);
    const config = buildConfig();
    if (!config) return;
    setBusy(true);
    const ok = await onCreate({ kind, label: label.trim(), config, refreshIntervalMinutes: refresh });
    setBusy(false);
    if (ok) {
      reset();
      onClose();
    } else {
      setError("Couldn't add that source. Please try again.");
    }
  }

  function close() {
    reset();
    setError(null);
    onClose();
  }

  return (
    <FormDialog
      open
      title="Add source"
      description="Connect a docs URL, GitHub repo, or Discord channel — we'll crawl it, keep it fresh, and cite it in replies."
      onClose={close}
      onSubmit={() => void submit()}
      submitLabel={busy ? "Adding…" : "Add connection"}
      submitDisabled={!canSubmit}
      busy={busy}
    >
      <div className="space-y-1.5">
        <Label htmlFor="src-kind" className="text-xs">
          Type
        </Label>
        <DialogSelect
          autoFocus
          value={kind}
          onChange={(v) => {
            setKind(v as SourceKind);
            setError(null);
          }}
          options={KIND_COMBO}
        />
      </div>

      {kind === "url" && (
        <div className="space-y-1">
          <Label htmlFor="src-url" className="text-xs">
            URL
          </Label>
          <Input
            id="src-url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            placeholder="https://docs.example.com"
            className="h-9 text-sm"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
          />
        </div>
      )}

      {kind === "github" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="src-repo" className="text-xs">
              Repository
            </Label>
            <Input
              id="src-repo"
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                setError(null);
              }}
              placeholder="owner/name"
              className="h-9 text-sm"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="src-branch" className="text-xs">
                Branch <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="src-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="default"
                className="h-9 text-sm"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="src-path" className="text-xs">
                Path <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="src-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="docs/"
                className="h-9 text-sm"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="src-token" className="text-xs">
              Access token <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="src-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_…"
              className="h-9 text-sm"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-micro text-muted-foreground">
              Only for private repos. Stored encrypted and never shown again.
            </p>
          </div>
        </>
      )}

      {kind === "discord" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="src-channel" className="text-xs">
              Channel ID
            </Label>
            <Input
              id="src-channel"
              value={channelId}
              onChange={(e) => {
                setChannelId(e.target.value);
                setError(null);
              }}
              placeholder="123456789012345678"
              className="h-9 text-sm"
              autoComplete="off"
              spellCheck={false}
              inputMode="numeric"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="src-guild" className="text-xs">
                Guild ID <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="src-guild"
                value={guildId}
                onChange={(e) => setGuildId(e.target.value)}
                placeholder="server ID"
                className="h-9 text-sm"
                autoComplete="off"
                spellCheck={false}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="src-limit" className="text-xs">
                Max messages <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="src-limit"
                type="number"
                min={1}
                value={limit}
                onChange={(e) => {
                  setLimit(e.target.value);
                  setError(null);
                }}
                placeholder="500"
                className="h-9 text-sm"
                autoComplete="off"
              />
            </div>
          </div>
          <div className="space-y-2.5 rounded-lg border bg-muted/40 p-2.5">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={solvedOnly}
                onChange={(e) => setSolvedOnly(e.target.checked)}
                className="mt-0.5 accent-primary"
              />
              <span className="text-micro text-muted-foreground">
                <span className="font-medium text-foreground">Only solved threads (forums).</span> For a forum
                channel, only posts marked solved are ingested. Plain text channels ingest the recent
                message log.
              </span>
            </label>
            {solvedOnly && (
              <div className="grid grid-cols-2 gap-2 pl-6">
                <div className="space-y-1">
                  <Label htmlFor="src-solved-tags" className="text-xs">
                    Solved tags <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="src-solved-tags"
                    value={solvedTags}
                    onChange={(e) => setSolvedTags(e.target.value)}
                    placeholder="solved, answered, resolved, done"
                    className="h-9 text-sm"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="src-solved-reaction" className="text-xs">
                    Solved reaction <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="src-solved-reaction"
                    value={solvedReaction}
                    onChange={(e) => setSolvedReaction(e.target.value)}
                    placeholder="✅ (or white_check_mark)"
                    className="h-9 text-sm"
                    autoComplete="off"
                  />
                </div>
                <p className="col-span-2 text-micro text-muted-foreground">
                  A post counts as solved when it carries one of these forum tags — or, in forums without
                  such tags, when a message has the solved reaction.
                </p>
              </div>
            )}
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={distill}
                onChange={(e) => setDistill(e.target.checked)}
                className="mt-0.5 accent-primary"
              />
              <span className="text-micro text-muted-foreground">
                <span className="font-medium text-foreground">Distill into Q&amp;A.</span> Each thread becomes a
                canonical question-and-answer article (via your workspace model, with a deterministic
                fallback). Off = keep the cleaned raw transcript.
              </span>
            </label>
          </div>
          <p className="text-micro text-muted-foreground">
            The bot must be in the server and have read access to the channel.
          </p>
        </>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="src-label" className="text-xs">
          Label <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="src-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Product docs"
          className="h-9 text-sm"
          autoComplete="off"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="src-refresh" className="text-xs">
          Auto-refresh <span className="font-normal text-muted-foreground">(re-crawl on a schedule)</span>
        </Label>
        <DialogSelect
          value={refresh == null ? "" : String(refresh)}
          onChange={(v) => setRefresh(v ? Number(v) : null)}
          options={REFRESH_PRESETS.map((p) => ({
            value: p.minutes == null ? "" : String(p.minutes),
            label: p.label,
          }))}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </FormDialog>
  );
}
