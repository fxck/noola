import { useEffect, useRef, useState } from "react";
import { MessagesSquare, Plus, Copy, Check, Trash2, Loader2, Home, MessageCircle, LifeBuoy } from "lucide-react";
import { toast } from "@/components/ui/toaster";
import { SettingsPage } from "@/components/settings-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { API_URL } from "@/lib/api";
import { EDGE_URL } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import {
  type WidgetKey,
  type WidgetConfig,
  WIDGET_CONFIG_DEFAULTS,
  fetchWidgetKeys,
  createWidgetKey,
  updateWidgetKey,
  deleteWidgetKey,
} from "@/lib/widget";

type Status = "loading" | "ready" | "error";

const HEX = /^#[0-9a-fA-F]{6}$/;

export function SettingsMessengerPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [keys, setKeys] = useState<WidgetKey[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useRef(async () => {
    setStatus("loading");
    try {
      const ks = await fetchWidgetKeys();
      setKeys(ks);
      setSelected((cur) => cur ?? ks[0]?.publicKey ?? null);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  const current = keys.find((k) => k.publicKey === selected) ?? null;

  async function onCreate() {
    try {
      const key = await createWidgetKey({});
      setKeys((ks) => [key, ...ks]);
      setSelected(key.publicKey);
      toast.success("Widget key created.");
    } catch {
      toast.error("Couldn't create the widget key.");
    }
  }

  async function onDelete(k: WidgetKey) {
    const prev = keys;
    setKeys((ks) => ks.filter((x) => x.publicKey !== k.publicKey));
    if (selected === k.publicKey) setSelected(keys.find((x) => x.publicKey !== k.publicKey)?.publicKey ?? null);
    try {
      await deleteWidgetKey(k.publicKey);
      toast.success("Widget key deleted.");
    } catch {
      setKeys(prev);
      toast.error("Couldn't delete the widget key.");
    }
  }

  function onSaved(updated: WidgetKey) {
    setKeys((ks) => ks.map((k) => (k.publicKey === updated.publicKey ? updated : k)));
  }

  return (
    <SettingsPage
      active="messenger"
      title="Messenger"
      description="Personalize the embeddable chat widget — its look, greeting, and which tabs your customers see."
      status={status}
      onRetry={() => void load()}
      errorTitle="Couldn't load your messenger settings"
      actions={
        status === "ready" && keys.length > 0 ? (
          <Button size="sm" variant="brand" className="h-8 gap-1.5" onClick={() => void onCreate()}>
            <Plus className="size-4" /> New key
          </Button>
        ) : undefined
      }
    >
      <div className="max-w-3xl px-6 pb-12 pt-4">
        {keys.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title="No widget yet"
            description="Create a widget key to embed the messenger on your site and personalize it here."
            action={
              <Button size="sm" variant="brand" className="gap-1.5" onClick={() => void onCreate()}>
                <Plus className="size-4" /> Create widget key
              </Button>
            }
          />
        ) : (
          <div className="space-y-6">
            {/* Key selector — one row per widget key */}
            {keys.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {keys.map((k) => (
                  <button
                    key={k.publicKey}
                    onClick={() => setSelected(k.publicKey)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-small font-medium transition-colors",
                      k.publicKey === selected
                        ? "border-primary/50 bg-primary/5 text-foreground"
                        : "border-input text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    {k.label || k.publicKey.slice(0, 14) + "…"}
                  </button>
                ))}
              </div>
            )}

            {current && (
              <MessengerEditor key={current.publicKey} widgetKey={current} onSaved={onSaved} onDelete={() => void onDelete(current)} />
            )}
          </div>
        )}
      </div>
    </SettingsPage>
  );
}

const PRESET_COLORS = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#111827"];

function MessengerEditor({
  widgetKey,
  onSaved,
  onDelete,
}: {
  widgetKey: WidgetKey;
  onSaved: (k: WidgetKey) => void;
  onDelete: () => void;
}) {
  const [cfg, setCfg] = useState<WidgetConfig>(widgetKey.config ?? WIDGET_CONFIG_DEFAULTS);
  const [label, setLabel] = useState(widgetKey.label ?? "");
  const [domains, setDomains] = useState((widgetKey.allowedDomains ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const dirty =
    JSON.stringify(cfg) !== JSON.stringify(widgetKey.config) ||
    label !== (widgetKey.label ?? "") ||
    domains !== (widgetKey.allowedDomains ?? []).join(", ");

  function set<K extends keyof WidgetConfig>(k: K, v: WidgetConfig[K]) {
    setCfg((c) => ({ ...c, [k]: v }));
  }
  function toggleTab(t: keyof WidgetConfig["tabs"], on: boolean) {
    setCfg((c) => ({ ...c, tabs: { ...c.tabs, [t]: on } }));
  }

  async function save() {
    if (!HEX.test(cfg.accent)) {
      toast.error("Accent color must be a hex value like #4f46e5.");
      return;
    }
    if (!cfg.tabs.home && !cfg.tabs.messages && !cfg.tabs.help) {
      toast.error("Enable at least one tab.");
      return;
    }
    setSaving(true);
    try {
      const allowedDomains = domains.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
      const updated = await updateWidgetKey(widgetKey.publicKey, { label: label.trim() || null, allowedDomains, config: cfg });
      onSaved(updated);
      toast.success("Messenger settings saved.");
    } catch {
      toast.error("Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const snippet = `<script src="${API_URL}/widget.js"
  data-noola-key="${widgetKey.publicKey}"
  data-noola-api="${API_URL}"
  data-noola-edge="${EDGE_URL}"></script>`;

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select and copy it manually.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-[1fr_260px]">
        {/* Form */}
        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="wk-label">Key name</Label>
            <Input id="wk-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Website widget" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wk-domains">Allowed domains</Label>
            <Input
              id="wk-domains"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="acme.com, docs.acme.com"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-micro text-muted-foreground">
              Only these sites can use this key (subdomains of a listed domain count). Empty ={" "}
              <strong>any site</strong> — fine for testing, lock it down before going live.
            </p>
            <p className="font-mono text-micro text-muted-foreground">{widgetKey.publicKey}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wk-title">Panel title</Label>
            <Input id="wk-title" value={cfg.title} onChange={(e) => set("title", e.target.value)} maxLength={80} placeholder="Ask us anything" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wk-greeting">Home greeting</Label>
            <Textarea
              id="wk-greeting"
              value={cfg.greeting}
              onChange={(e) => set("greeting", e.target.value)}
              maxLength={280}
              rows={2}
              placeholder="Hi there 👋 How can we help?"
            />
          </div>

          <div className="space-y-2">
            <Label>Accent color</Label>
            <div className="flex flex-wrap items-center gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Use ${c}`}
                  onClick={() => set("accent", c)}
                  className={cn(
                    "size-7 rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110",
                    cfg.accent.toLowerCase() === c.toLowerCase() && "ring-2 ring-foreground",
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="color"
                aria-label="Custom accent color"
                value={HEX.test(cfg.accent) ? cfg.accent : "#4f46e5"}
                onChange={(e) => set("accent", e.target.value)}
                className="size-7 cursor-pointer rounded-full border border-input bg-transparent p-0"
              />
              <Input
                value={cfg.accent}
                onChange={(e) => set("accent", e.target.value)}
                className="h-8 w-28 font-mono text-xs"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Launcher position</Label>
            <div className="inline-flex rounded-lg border border-input p-0.5">
              {(["left", "right"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => set("position", p)}
                  className={cn(
                    "rounded-md px-4 py-1.5 text-small font-medium capitalize transition-colors",
                    cfg.position === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Tabs</Label>
            <div className="divide-y rounded-lg border">
              <TabToggle icon={Home} label="Home" desc="Greeting, quick actions & top articles" on={cfg.tabs.home} onChange={(v) => toggleTab("home", v)} />
              <TabToggle icon={MessageCircle} label="Messages" desc="Conversations & AI chat with human hand-off" on={cfg.tabs.messages} onChange={(v) => toggleTab("messages", v)} />
              <TabToggle icon={LifeBuoy} label="Help" desc="Searchable knowledge base articles" on={cfg.tabs.help} onChange={(v) => toggleTab("help", v)} />
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div className="space-y-2">
          <Label>Preview</Label>
          <WidgetPreview cfg={cfg} />
        </div>
      </div>

      {/* Embed snippet */}
      <div className="space-y-2">
        <Label>Embed snippet</Label>
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-input bg-background p-3 text-micro leading-relaxed">
            {snippet}
          </pre>
          <Button type="button" variant="outline" size="sm" onClick={() => void copySnippet()} className="shrink-0">
            {copied ? (
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
        <p className="text-xs text-muted-foreground">
          Add the <span className="font-mono">Noola(…)</span> SDK to identify users and track activity:{" "}
          <span className="font-mono">Noola('boot', {"{ email, name, user_id }"})</span>,{" "}
          <span className="font-mono">Noola('track', 'event_name')</span>.
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button variant="brand" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : "Save changes"}
        </Button>
        {confirming ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Delete this key?</span>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onDelete}>
              Delete
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => setConfirming(true)}>
            <Trash2 /> Delete key
          </Button>
        )}
      </div>
    </div>
  );
}

function TabToggle({
  icon: Icon,
  label,
  desc,
  on,
  onChange,
}: {
  icon: typeof Home;
  label: string;
  desc: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="truncate text-xs text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={on} onCheckedChange={onChange} />
    </div>
  );
}

function WidgetPreview({ cfg }: { cfg: WidgetConfig }) {
  const enabled = (["home", "messages", "help"] as const).filter((t) => cfg.tabs[t]);
  return (
    <div className="relative h-[320px] overflow-hidden rounded-xl border bg-muted/40">
      {/* Panel mock */}
      <div
        className={cn(
          "absolute bottom-3 flex w-[220px] flex-col overflow-hidden rounded-xl bg-white shadow-lg dark:bg-neutral-900",
          cfg.position === "left" ? "left-3" : "right-3",
        )}
        style={{ height: 268 }}
      >
        <div className="px-3 py-3 text-white" style={{ backgroundColor: cfg.accent }}>
          <div className="text-small font-semibold leading-tight">{cfg.title || "Ask us anything"}</div>
        </div>
        <div className="flex-1 space-y-2 overflow-hidden bg-neutral-50 p-3 dark:bg-neutral-800/50">
          <p className="text-micro leading-snug text-neutral-600 dark:text-neutral-300">{cfg.greeting}</p>
          <div className="flex items-center justify-between rounded-lg px-3 py-2 text-micro font-semibold text-white" style={{ backgroundColor: cfg.accent }}>
            Send us a message
          </div>
          <div className="rounded-lg border bg-white p-2 text-micro text-neutral-500 dark:bg-neutral-900">Search for help…</div>
        </div>
        {enabled.length > 1 && (
          <div className="flex border-t bg-white dark:bg-neutral-900">
            {enabled.map((t) => (
              <div key={t} className="flex-1 py-1.5 text-center text-[9px] font-medium capitalize" style={{ color: cfg.accent }}>
                {t}
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Launcher bubble */}
      <div
        className={cn("absolute bottom-3 grid size-11 place-items-center rounded-full text-white shadow-lg", cfg.position === "left" ? "left-3" : "right-3")}
        style={{ backgroundColor: cfg.accent }}
      >
        <MessagesSquare className="size-5" />
      </div>
    </div>
  );
}
