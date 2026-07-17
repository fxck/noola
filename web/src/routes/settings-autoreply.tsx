import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { SettingsPage } from "@/components/settings-page";
import {
  type AutoreplyMode,
  type AutoreplyChannel,
  type AutoreplyPolicy,
  type AutoreplyPolicyInput,
  type ChannelMode,
  type SourceKind,
  MODE_OPTIONS,
  CHANNEL_OPTIONS,
  CHANNEL_MODE_OPTIONS,
  fetchAutoreplyPolicy,
  saveAutoreplyPolicy,
} from "@/lib/autoreply";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { PopoverSelect } from "@/components/ui/menu";
import { TAB_BASE, TAB_ON, TAB_OFF } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

// Input-mirroring trigger for PopoverSelect in settings forms (matches ui/input.tsx).
const SELECT_TRIGGER =
  "my-0 h-9 w-full justify-between rounded-md border border-input bg-background px-3 py-1 text-sm font-normal shadow-sm hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed";

// Key-order-insensitive equality for the small config maps (channel_modes / source_scopes).
function sameMap(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
}

// The three retrieval surfaces, in citation-rank order.
const SOURCE_KIND_OPTIONS: { value: SourceKind; label: string }[] = [
  { value: "kb", label: "Knowledge base" },
  { value: "thread", label: "Resolved conversations" },
  { value: "document", label: "Documents" },
];
// What the server uses when a scope isn't configured — mirrored so the checkboxes are truthful.
const SCOPE_DEFAULTS: Record<"public" | "agent", SourceKind[]> = {
  public: ["kb"],
  agent: ["kb", "thread", "document"],
};

const NUM_LIMIT = 10_000; // sane clamp for the per-thread / per-hour caps

export function SettingsAutoreplyPage() {
  const [policy, setPolicy] = useState<AutoreplyPolicy | null>(null);
  const [form, setForm] = useState<AutoreplyPolicy | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  // Every control — mode, kill switch, and the tuning knobs — stages into `form`
  // and is committed together via the one "Save changes" button. No control writes
  // on click; that keeps the whole page on a single, consistent save affordance.

  const load = useRef(async () => {
    setLoadError(false);
    try {
      const p = await fetchAutoreplyPolicy();
      setPolicy(p);
      setForm(p);
    } catch {
      setLoadError(true);
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  function patch(p: Partial<AutoreplyPolicy>) {
    setForm((f) => (f ? { ...f, ...p } : f));
  }

  /** Set a channel's routing override; null clears it back to the inherit default. */
  function setChannelMode(ch: AutoreplyChannel, mode: ChannelMode | null) {
    setForm((f) => {
      if (!f) return f;
      const map = { ...f.channel_modes };
      if (mode === null) delete map[ch];
      else map[ch] = mode;
      return { ...f, channel_modes: map };
    });
  }

  /** Toggle a retrieval kind for one audience; materializes the server default first so
   *  the first click edits what the user actually sees. A row keeps at least one kind. */
  function toggleScope(audience: "public" | "agent", kind: SourceKind, on: boolean) {
    setForm((f) => {
      if (!f) return f;
      const current = f.source_scopes[audience] ?? SCOPE_DEFAULTS[audience];
      const set = new Set(current);
      if (on) set.add(kind);
      else set.delete(kind);
      if (set.size === 0) return f; // never allow an empty scope
      const next = SOURCE_KIND_OPTIONS.map((o) => o.value).filter((v) => set.has(v));
      return { ...f, source_scopes: { ...f.source_scopes, [audience]: next } };
    });
  }

  // Only the changed fields go on the wire. min_confidence is nullable — an explicit
  // null (clearing the floor) is a REAL value and must be sent, so plain !== works.
  function diff(f: AutoreplyPolicy, base: AutoreplyPolicy): AutoreplyPolicyInput {
    const out: AutoreplyPolicyInput = {};
    if (f.mode !== base.mode) out.mode = f.mode;
    if (f.min_agreement !== base.min_agreement) out.min_agreement = f.min_agreement;
    if (f.min_top_score !== base.min_top_score) out.min_top_score = f.min_top_score;
    if (!sameMap(f.channel_modes, base.channel_modes)) out.channel_modes = f.channel_modes;
    if (f.min_confidence !== base.min_confidence) out.min_confidence = f.min_confidence;
    if (!sameMap(f.source_scopes, base.source_scopes)) out.source_scopes = f.source_scopes;
    if (f.max_auto_per_thread !== base.max_auto_per_thread)
      out.max_auto_per_thread = f.max_auto_per_thread;
    if (f.max_auto_per_hour !== base.max_auto_per_hour)
      out.max_auto_per_hour = f.max_auto_per_hour;
    if (f.kill_switch !== base.kill_switch) out.kill_switch = f.kill_switch;
    return out;
  }

  const dirty = !!form && !!policy && Object.keys(diff(form, policy)).length > 0;

  async function save() {
    if (!form || !policy) return;
    const body = diff(form, policy);
    setSaving(true);
    try {
      const saved = await saveAutoreplyPolicy(body);
      setPolicy(saved);
      setForm(saved);
      toast.success("Autoreply settings saved.");
    } catch {
      toast.error("Couldn't save settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const isAuto = form?.mode === "auto";
  const status = loadError ? "error" : form === null ? "loading" : "ready";

  return (
    <SettingsPage
      active="autoreply"
      title="Autoreply"
      description="Decide how much the AI does on its own — from nothing, to preparing drafts for your agents, to sending well-supported answers automatically."
      status={status}
      onRetry={() => void load()}
      errorTitle="Couldn't load your Autoreply settings"
      actions={
        form && (
          <>
            {dirty && !saving && (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            )}
            <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? (
                <>
                  <Loader2 className="animate-spin" /> Saving…
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </>
        )
      }
    >
      {form && (
              <div className="max-w-2xl px-6 pb-10 pt-4">
              {/* Mode — the headline control. Staged; saved via "Save changes". */}
              <div className="space-y-3 rounded-xl border bg-card p-6 shadow-sm">
                <Label>Mode</Label>
                <div className="grid gap-2.5">
                  {MODE_OPTIONS.map((o) => {
                    const active = form.mode === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => patch({ mode: o.value as AutoreplyMode })}
                        aria-pressed={active}
                        className={cn(
                          "flex flex-col items-start gap-0.5 rounded-lg border p-3.5 text-left transition-colors",
                          active
                            ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30"
                            : "border-input hover:bg-muted/50",
                        )}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <span
                            className={cn(
                              "grid size-4 place-items-center rounded-full border",
                              active ? "border-primary" : "border-muted-foreground/40",
                            )}
                          >
                            {active && <span className="size-2 rounded-full bg-primary" />}
                          </span>
                          {o.label}
                        </span>
                        <span className="pl-6 text-xs text-muted-foreground">{o.blurb}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Per-channel routing — matters whenever autoreply is working (suggest or auto). */}
              {form.mode !== "off" && (
                <div className="mt-5 space-y-3 rounded-xl border bg-card p-6 shadow-sm">
                  <div>
                    <Label>Per-channel routing</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {isAuto
                        ? "Auto-send is opt-in per channel — channels left on Default get drafts for review."
                        : "Under Suggest only, channels can only draft or be skipped; enable Auto-send above to unlock per-channel sending."}
                    </p>
                  </div>
                  <div className="divide-y">
                    {CHANNEL_OPTIONS.map((c) => {
                      const explicit = form.channel_modes[c.value];
                      return (
                        <div key={c.value} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                          <span className="text-sm">{c.label}</span>
                          <div role="tablist" aria-label={`${c.label} routing`} className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5">
                            <button
                              type="button"
                              role="tab"
                              aria-selected={explicit === undefined}
                              onClick={() => setChannelMode(c.value, null)}
                              className={cn(TAB_BASE, explicit === undefined ? TAB_ON : TAB_OFF)}
                              title={isAuto ? "Inherit: drafts for review" : "Inherit the global mode"}
                            >
                              Default
                            </button>
                            {CHANNEL_MODE_OPTIONS.map((m) => {
                              const disabled = m.value === "auto" && !isAuto;
                              return (
                                <button
                                  key={m.value}
                                  type="button"
                                  role="tab"
                                  aria-selected={explicit === m.value}
                                  disabled={disabled}
                                  onClick={() => setChannelMode(c.value, m.value)}
                                  className={cn(
                                    TAB_BASE,
                                    explicit === m.value ? TAB_ON : TAB_OFF,
                                    disabled && "cursor-not-allowed opacity-40",
                                  )}
                                  title={disabled ? "Requires the global Auto-send mode" : m.blurb}
                                >
                                  {m.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Answer sources by audience — governs retrieval even when autoreply is off
                  (public widget/docs answers always run through this scope). */}
              <div className="mt-5 space-y-4 rounded-xl border bg-card p-6 shadow-sm">
                <div>
                  <Label>Answer sources by audience</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Which knowledge surfaces each audience may draw answers from.
                  </p>
                </div>
                {([
                  {
                    audience: "public" as const,
                    title: "Public answers",
                    blurb: "Messenger widget, docs embed, and the public answer API.",
                  },
                  {
                    audience: "agent" as const,
                    title: "Agent assist",
                    blurb: "Copilot drafts and the autoreply gate.",
                  },
                ]).map((row) => {
                  const active = form.source_scopes[row.audience] ?? SCOPE_DEFAULTS[row.audience];
                  const risky = row.audience === "public" && active.some((k) => k !== "kb");
                  return (
                    <div key={row.audience} className="space-y-2">
                      <div>
                        <p className="text-sm font-medium">{row.title}</p>
                        <p className="text-xs text-muted-foreground">{row.blurb}</p>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {SOURCE_KIND_OPTIONS.map((k) => {
                          const on = active.includes(k.value);
                          return (
                            <label
                              key={k.value}
                              className={cn(
                                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                                on ? "border-primary/50 bg-primary/5" : "border-input hover:bg-muted/50",
                              )}
                            >
                              <Checkbox
                                checked={on}
                                onCheckedChange={(v) => toggleScope(row.audience, k.value, v)}
                              />
                              {k.label}
                            </label>
                          );
                        })}
                      </div>
                      {risky && (
                        <p className="text-xs text-amber-600 dark:text-amber-500">
                          Resolved conversations and documents may contain customer or internal
                          data — public answers can cite them with this on.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Auto-only controls */}
              {isAuto && (
                <div className="mt-5 space-y-5">
                  {/* Guardrails reassurance */}
                  <div className="flex items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/5 p-4 text-sm">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div className="space-y-1">
                      <p className="font-medium">Auto-send stays on a short leash</p>
                      <p className="text-muted-foreground">
                        It only fires when retrieval corroborates the answer across at least{" "}
                        <span className="font-medium text-foreground">
                          {form.min_agreement}
                        </span>{" "}
                        {form.min_agreement === 1 ? "source" : "sources"}. It{" "}
                        <span className="font-medium text-foreground">never</span> auto-sends on
                        refunds, cancellations, legal or security matters, escalations
                        (&ldquo;talk to a manager&rdquo;), angry messages, or anything with payment
                        or personal data — those always go to a human.
                      </p>
                    </div>
                  </div>

                  {/* Kill switch */}
                  <div
                    className={cn(
                      "flex items-start justify-between gap-4 rounded-xl border p-4 shadow-sm",
                      form.kill_switch
                        ? "border-destructive/40 bg-destructive/5"
                        : "border-input bg-card",
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <ShieldAlert
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          form.kill_switch ? "text-destructive" : "text-muted-foreground",
                        )}
                      />
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">Kill switch</p>
                        <p className="text-xs text-muted-foreground">
                          Pause all auto-sending immediately. Drafts are still prepared for your
                          agents.
                        </p>
                      </div>
                    </div>
                    <Switch
                      tone="destructive"
                      checked={form.kill_switch}
                      onCheckedChange={() => patch({ kill_switch: !form.kill_switch })}
                    />
                  </div>

                  {/* Tuning */}
                  <div className="space-y-5 rounded-xl border bg-card p-6 shadow-sm">
                    <div className="space-y-1.5">
                      {/* The label wraps the trigger so clicking it opens the menu */}
                      <Label className="flex flex-col gap-1.5">
                        <span>Sources that must agree</span>
                        <PopoverSelect
                          value={String(form.min_agreement)}
                          align="start"
                          options={[
                            { value: "1", label: "1 source" },
                            { value: "2", label: "2 sources" },
                            { value: "3", label: "3 sources" },
                          ]}
                          onChange={(v) => {
                            if (v !== null) patch({ min_agreement: Number(v) });
                          }}
                          buttonClassName={SELECT_TRIGGER}
                        />
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        How many distinct knowledge sources must back an answer before it can be
                        sent automatically. Higher is safer.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label>Confidence floor</Label>
                        <Switch
                          checked={form.min_confidence != null}
                          onCheckedChange={(on) =>
                            patch({ min_confidence: on ? (policy?.min_confidence ?? 0.7) : null })
                          }
                        />
                      </div>
                      {form.min_confidence != null && (
                        <div className="flex items-center gap-3 pt-1">
                          <input
                            type="range"
                            min={0.5}
                            max={0.99}
                            step={0.01}
                            value={form.min_confidence}
                            onChange={(e) => patch({ min_confidence: Number(e.target.value) })}
                            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                            aria-label="Minimum model confidence"
                          />
                          <span className="w-12 text-right text-sm font-medium tabular-nums">
                            {Math.round(form.min_confidence * 100)}%
                          </span>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {form.min_confidence != null
                          ? "Drafts below this model confidence are held for human review, even when sources corroborate."
                          : "Off — corroborating sources alone decide. Turn on to also require a minimum model confidence."}
                      </p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="max_thread">Max auto-replies per thread</Label>
                        <Input
                          id="max_thread"
                          type="number"
                          min={0}
                          max={NUM_LIMIT}
                          value={form.max_auto_per_thread}
                          onChange={(e) =>
                            patch({
                              max_auto_per_thread: Math.max(
                                0,
                                Math.min(NUM_LIMIT, Number(e.target.value) || 0),
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="max_hour">Max auto-replies per hour</Label>
                        <Input
                          id="max_hour"
                          type="number"
                          min={0}
                          max={NUM_LIMIT}
                          value={form.max_auto_per_hour}
                          onChange={(e) =>
                            patch({
                              max_auto_per_hour: Math.max(
                                0,
                                Math.min(NUM_LIMIT, Number(e.target.value) || 0),
                              ),
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              </div>
      )}
    </SettingsPage>
  );
}
