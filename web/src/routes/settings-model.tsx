import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  KeyRound,
  Check,
  AlertTriangle,
  Loader2,
  Plug,
  ChevronsUpDown,
} from "lucide-react";
import { SettingsRail } from "@/components/settings-rail";
import {
  type ModelJob,
  type ModelProvider,
  type ModelSettings,
  type ModelSettingsInput,
  type ModelTestResult,
  PROVIDER_OPTIONS,
  PROVIDER_EFFORTS,
  MODEL_JOB_LABELS,
  MODEL_PLACEHOLDER,
  MODEL_SUGGESTIONS,
  effortLabel,
  fetchModelSettings,
  fetchAvailableModels,
  saveModelSettings,
  testModelSettings,
} from "@/lib/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PopoverSelect } from "@/components/ui/menu";
import { Popover } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

// Input-mirroring trigger for PopoverSelect in settings forms (matches ui/input.tsx).
const SELECT_TRIGGER =
  "my-0 h-9 w-full justify-between rounded-md border border-input bg-background px-3 py-1 text-sm font-normal shadow-sm hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed";

/**
 * Editable model combobox (D1): a free-text `<Input>` with a filtered menu of known
 * model ids seeded per provider. Picking a suggestion is one tap; typing an id the
 * catalog doesn't list is still allowed (self-hosted / custom models). A typo used to
 * silently break every AI draft — the menu makes the valid set legible without locking
 * it down. When a provider has no catalog (managed/custom) it degrades to a plain input.
 */
function ModelCombobox({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const filtered = suggestions.filter((s) => s.toLowerCase().includes(q));
  const showList = open && filtered.length > 0;
  return (
    <Popover
      open={showList}
      onOpenChange={setOpen}
      align="start"
      triggerClassName="w-full"
      trigger={
        <div className="relative w-full">
          <Input
            id={id}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            className="pr-8 font-mono text-sm"
          />
          {suggestions.length > 0 && (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setOpen((o) => !o)}
              aria-label="Browse models"
              className="absolute inset-y-0 right-0 grid w-8 place-items-center text-muted-foreground hover:text-foreground"
            >
              <ChevronsUpDown className="size-4" />
            </button>
          )}
        </div>
      }
    >
      <div className="max-h-64 overflow-y-auto p-1" role="listbox">
        {filtered.map((s) => {
          const on = s === value.trim();
          return (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => {
                onChange(s);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
                on && "bg-accent/60",
              )}
            >
              <Check className={cn("size-3.5 shrink-0", on ? "text-primary opacity-100" : "opacity-0")} />
              <span className="truncate">{s}</span>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

// Form mirror of the saved settings, plus the two write-only-key affordances.
// An empty job field means "not set": the model's default level, or the answers settings for search and general.
type Form = {
  provider: ModelProvider;
  endpoint: string;
  model: string;
  apiKey: string;
  replacingKey: boolean; // reveal an empty key input over the "Key saved" state
  effort: string;
  searchModel: string;
  searchEffort: string;
  generalModel: string;
  generalEffort: string;
};

function formFrom(s: ModelSettings): Form {
  return {
    provider: s.provider,
    endpoint: s.endpoint ?? "",
    model: s.model ?? "",
    apiKey: "",
    replacingKey: false,
    effort: s.effort ?? "",
    searchModel: s.searchModel ?? "",
    searchEffort: s.searchEffort ?? "",
    generalModel: s.generalModel ?? "",
    generalEffort: s.generalEffort ?? "",
  };
}

const JOB_KEYS = {
  answers: { model: "model", effort: "effort" },
  search: { model: "searchModel", effort: "searchEffort" },
  general: { model: "generalModel", effort: "generalEffort" },
} as const satisfies Record<ModelJob, { model: keyof Form; effort: keyof Form }>;

const JOB_BLURBS: Record<ModelJob, string> = {
  answers:
    "The replies the AI writes on the widget, by e-mail and on Discord, and Draft with AI. The jobs below use these settings unless you set their own.",
  search: "The docs-search query, Translate in the article editor, and translating conversations for your team.",
  general: "Auto-tags, topics, thread summaries, conversation QA, the article draft from a ticket, and automations.",
};

/**
 * One job's model and thinking level. The level menu's empty option names what the server does without one:
 * the answers level when the job has no model of its own, else the model's own default.
 */
function JobFields({
  job,
  model,
  effort,
  onModel,
  onEffort,
  suggestions,
  levels,
  placeholder,
}: {
  job: ModelJob;
  model: string;
  effort: string;
  onModel: (v: string) => void;
  onEffort: (v: string) => void;
  suggestions: string[];
  levels: readonly string[];
  placeholder: string;
}) {
  const inherits = job !== "answers" && !model.trim();
  const id = `${job}-model`;
  return (
    <div role="group" aria-labelledby={`${job}-title`} className="space-y-3 rounded-lg border p-4">
      <div>
        <p id={`${job}-title`} className="text-sm font-medium text-foreground">
          {MODEL_JOB_LABELS[job]}
          {job === "answers" && <span className="text-muted-foreground"> (default)</span>}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{JOB_BLURBS[job]}</p>
      </div>
      <div className={cn("grid gap-3", levels.length > 0 && "sm:grid-cols-[minmax(0,1fr)_11rem]")}>
        <div className="space-y-1.5">
          <Label htmlFor={id}>Model</Label>
          <ModelCombobox id={id} value={model} onChange={onModel} suggestions={suggestions} placeholder={placeholder} />
        </div>
        {levels.length > 0 && (
          <Label className="flex flex-col gap-1.5">
            <span>Thinking level</span>
            <PopoverSelect
              value={levels.includes(effort) ? effort : null}
              align="start"
              options={[
                { value: null, label: inherits ? "Same as answers" : "Model default" },
                ...levels.map((l) => ({ value: l, label: effortLabel(l) })),
              ]}
              onChange={(v) => onEffort(v ?? "")}
              buttonClassName={SELECT_TRIGGER}
            />
          </Label>
        )}
      </div>
    </div>
  );
}

// A failed job carries its own error in the list, so the summary repeats none of them.
function testSummary(r: ModelTestResult): string {
  if (r.jobs.length === 0) {
    return r.ok ? "Connection succeeded. The saved provider is reachable." : r.error || "Connection failed. Check the model, key, and endpoint.";
  }
  return r.ok ? "Connection succeeded. Every job's model responded." : "Connection failed. Check the jobs marked below.";
}

export function SettingsModelPage() {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  // The saved provider's own list replaces the built-in suggestions once a key is saved.
  const [available, setAvailable] = useState<string[]>([]);
  useEffect(() => {
    if (!settings?.hasKey || settings.provider === "managed") {
      setAvailable([]);
      return;
    }
    let live = true;
    fetchAvailableModels()
      .then((models) => live && setAvailable(models))
      .catch(() => live && setAvailable([]));
    return () => {
      live = false;
    };
  }, [settings]);

  const load = useRef(async () => {
    setLoadError(false);
    try {
      const s = await fetchModelSettings();
      setSettings(s);
      setForm(formFrom(s));
    } catch {
      setLoadError(true);
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  function patch(p: Partial<Form>) {
    setForm((f) => (f ? { ...f, ...p } : f));
    setTestResult(null);
  }

  // Another provider's model ids don't run here, so a switch clears the job models and a switch back restores the saved ones.
  // Levels stay in the form and are filtered by the provider when shown and saved, so a round trip keeps them.
  function switchProvider(provider: ModelProvider) {
    const back = provider === settings?.provider;
    setForm((f) =>
      f && f.provider !== provider
        ? {
            ...f,
            provider,
            searchModel: back ? (settings?.searchModel ?? "") : "",
            generalModel: back ? (settings?.generalModel ?? "") : "",
          }
        : f,
    );
    setTestResult(null);
  }

  // A level the selected provider doesn't take counts as unset.
  const levelFor = (provider: ModelProvider, v: string) => (PROVIDER_EFFORTS[provider].includes(v) ? v : "");
  const level = (v: string) => (form ? levelFor(form.provider, v) : "");

  const needsModel = form?.provider === "openai" || form?.provider === "anthropic" || form?.provider === "custom";
  const needsEndpoint = form?.provider === "custom";
  const needsKey = needsModel; // every non-managed provider takes a key
  const levels = form ? PROVIDER_EFFORTS[form.provider] : [];

  // Whether the key input is shown (no key on file, or the user chose to replace).
  const keyInputShown = !!form && (!settings?.hasKey || form.provider !== settings.provider || form.replacingKey);

  // Unsaved-changes guard — Test probes the SAVED config, so warn before it runs.
  const dirty =
    !!form &&
    !!settings &&
    (form.provider !== settings.provider ||
      (needsEndpoint && form.endpoint.trim() !== (settings.endpoint ?? "")) ||
      (needsModel &&
        (form.model.trim() !== (settings.model ?? "") ||
          level(form.effort) !== (settings.effort ?? "") ||
          form.searchModel.trim() !== (settings.searchModel ?? "") ||
          level(form.searchEffort) !== (settings.searchEffort ?? "") ||
          form.generalModel.trim() !== (settings.generalModel ?? "") ||
          level(form.generalEffort) !== (settings.generalEffort ?? ""))) ||
      form.apiKey.trim().length > 0);

  function buildInput(f: Form): ModelSettingsInput {
    if (f.provider === "managed") return { provider: "managed" };
    const orNull = (v: string) => v.trim() || null;
    const input: ModelSettingsInput = {
      provider: f.provider,
      model: f.model.trim(),
      effort: orNull(levelFor(f.provider, f.effort)),
      searchModel: orNull(f.searchModel),
      searchEffort: orNull(levelFor(f.provider, f.searchEffort)),
      generalModel: orNull(f.generalModel),
      generalEffort: orNull(levelFor(f.provider, f.generalEffort)),
    };
    if (needsEndpoint) input.endpoint = f.endpoint.trim();
    if (f.apiKey.trim()) input.apiKey = f.apiKey; // non-empty only — empty keeps existing
    return input;
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setTestResult(null);
    try {
      const saved = await saveModelSettings(buildInput(form));
      setSettings(saved);
      setForm(formFrom(saved));
      toast.success("Model settings saved.");
    } catch {
      toast.error("Couldn't save settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testModelSettings());
    } catch {
      setTestResult({ ok: false, error: "The test request failed to reach the server.", jobs: [] });
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <SettingsRail active="model" />

        {/* ── page body ─────────────────────────────────────────── */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {form === null && !loadError ? (
            <div className="grid h-full place-items-center py-10">
              <Spinner />
            </div>
          ) : loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertTriangle className="size-7 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">Couldn't load your AI &amp; Model settings.</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : form ? (
            <>
              <header className="flex h-12 shrink-0 items-center gap-2 px-6">
                <h1 className="text-sm font-semibold tracking-tight">AI &amp; Model</h1>
                <Button size="sm" className="ml-auto" onClick={() => void save()} disabled={saving}>
                  {saving ? (
                    <>
                      <Loader2 className="animate-spin" /> Saving…
                    </>
                  ) : (
                    "Save changes"
                  )}
                </Button>
              </header>
              <p className="px-6 text-small text-muted-foreground">
                Choose which model runs the AI, and how much it thinks for each job: your own provider key, or
                the built-in assistant.
              </p>

              <div className="max-w-2xl px-6 pb-10 pt-4">
              <div className="space-y-5 rounded-xl border bg-card p-6 shadow-sm">
                {/* Provider — the label wraps the trigger so clicking it opens the menu */}
                <Label className="flex flex-col gap-1.5">
                  <span>Provider</span>
                  <PopoverSelect
                    value={form.provider}
                    align="start"
                    options={PROVIDER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    onChange={(v) => {
                      if (v !== null) switchProvider(v as ModelProvider);
                    }}
                    buttonClassName={SELECT_TRIGGER}
                  />
                </Label>

                {form.provider === "managed" ? (
                  <div className="flex items-start gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                    <p>
                      Uses the built-in assistant. Add your own provider key below for full
                      LLM-written drafts.
                    </p>
                  </div>
                ) : (
                  <>
                    {needsEndpoint && (
                      <div className="space-y-1.5">
                        <Label htmlFor="endpoint">Endpoint</Label>
                        <Input
                          id="endpoint"
                          value={form.endpoint}
                          onChange={(e) => patch({ endpoint: e.target.value })}
                          placeholder="https://api.your-provider.com/v1"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <p className="text-xs text-muted-foreground">
                          OpenAI-compatible base URL. We'll call its chat-completions endpoint.
                        </p>
                      </div>
                    )}

                    {needsKey && (
                      <div className="space-y-1.5">
                        <Label htmlFor="apiKey">API key</Label>
                        {keyInputShown ? (
                          <>
                            <Input
                              id="apiKey"
                              type="password"
                              value={form.apiKey}
                              onChange={(e) => patch({ apiKey: e.target.value })}
                              placeholder={
                                settings?.hasKey && form.provider === settings.provider
                                  ? "Enter a new key to replace the saved one"
                                  : "Paste your API key"
                              }
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <p className="text-xs text-muted-foreground">
                              Stored encrypted and never shown again. Leave blank to keep the
                              current key.
                            </p>
                          </>
                        ) : (
                          <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-background px-3 py-2 text-sm">
                            <span className="flex items-center gap-2 text-muted-foreground">
                              <KeyRound className="size-4" /> Key saved ••••
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => patch({ replacingKey: true })}
                            >
                              Replace key
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {needsModel && (
                <div className="mt-5 space-y-4 rounded-xl border bg-card p-6 shadow-sm">
                  <div>
                    <h2 className="text-sm font-semibold">Model per job</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Pick a known model or type any id your provider serves. A typo silently breaks the job,
                      so double-check custom entries.
                      {levels.length > 0 &&
                        " Only some models accept a thinking level (OpenAI reasoning models, Claude 4.6 and newer). Test connection checks it."}
                    </p>
                  </div>
                  {(["answers", "search", "general"] as const).map((job) => (
                    <JobFields
                      key={job}
                      job={job}
                      model={form[JOB_KEYS[job].model]}
                      effort={form[JOB_KEYS[job].effort]}
                      onModel={(v) => patch({ [JOB_KEYS[job].model]: v })}
                      onEffort={(v) => patch({ [JOB_KEYS[job].effort]: v })}
                      suggestions={
                        available.length && form.provider === settings?.provider ? available : MODEL_SUGGESTIONS[form.provider]
                      }
                      levels={levels}
                      placeholder={job === "answers" ? MODEL_PLACEHOLDER[form.provider] : "Same as answers"}
                    />
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => void test()}
                  disabled={testing || saving || settings?.provider === "managed"}
                  title={
                    settings?.provider === "managed"
                      ? "The built-in assistant is always available."
                      : "Probe the saved provider config"
                  }
                >
                  {testing ? (
                    <>
                      <Loader2 className="animate-spin" /> Testing…
                    </>
                  ) : (
                    <>
                      <Plug /> Test connection
                    </>
                  )}
                </Button>
                {dirty && (
                  <span className="text-xs text-muted-foreground">
                    Unsaved changes — save before testing.
                  </span>
                )}
              </div>

              {/* Inline test result */}
              {testResult && (
                <div
                  className={cn(
                    "mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm",
                    testResult.ok
                      ? "border-primary/25 bg-primary/5 text-foreground"
                      : "border-destructive/30 bg-destructive/5 text-foreground",
                  )}
                >
                  {testResult.ok ? (
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  ) : (
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0 flex-1 space-y-2">
                    <p>{testSummary(testResult)}</p>
                    {testResult.jobs.length > 0 && (
                      <ul className="space-y-1 text-xs">
                        {testResult.jobs.map((j) => (
                          <li key={j.job} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            {j.ok ? (
                              <Check className="size-3.5 shrink-0 text-primary" />
                            ) : (
                              <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                            )}
                            <span className="font-medium">{MODEL_JOB_LABELS[j.job]}</span>
                            <span className="font-mono text-muted-foreground">
                              {j.model}
                              {j.effort && ` · ${j.effort}`}
                            </span>
                            {j.error && <span className="basis-full text-destructive sm:basis-auto">{j.error}</span>}
                          </li>
                        ))}
                        {testResult.jobs.length < 3 && (
                          <li className="text-muted-foreground">Jobs not listed run the answers model at the answers level.</li>
                        )}
                      </ul>
                    )}
                  </div>
                </div>
              )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
