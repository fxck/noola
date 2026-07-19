import { useEffect, useRef, useState } from "react";
import {
  MessagesSquare, Plus, Copy, Check, Trash2, Loader2, Home, MessageCircle, LifeBuoy,
  ShieldCheck, KeyRound, RefreshCw, Eye, EyeOff, Sparkles,
} from "lucide-react";
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
  setWidgetIdentitySecret,
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
              placeholder="Get an instant answer from our AI, or browse the help center."
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
      </div>

      {/* Identity verification — Intercom-parity HMAC user_hash. */}
      <IdentityVerificationCard
        widgetKey={widgetKey}
        verifyOn={cfg.verifyIdentity}
        onToggle={(v) => set("verifyIdentity", v)}
        onSecretChanged={onSaved}
      />

      {/* Programmatic API reference — control/identify the widget from the host page. */}
      <WidgetApiReference />

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

function IdentityVerificationCard({
  widgetKey,
  verifyOn,
  onToggle,
  onSecretChanged,
}: {
  widgetKey: WidgetKey;
  verifyOn: boolean;
  onToggle: (v: boolean) => void;
  onSecretChanged: (k: WidgetKey) => void;
}) {
  const secret = widgetKey.identitySecret ?? "";
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [byo, setByo] = useState("");
  const [busy, setBusy] = useState<"save" | "rotate" | null>(null);

  const masked = secret ? secret.slice(0, 6) + "•".repeat(Math.max(0, secret.length - 6)) : "—";

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — reveal and copy it manually.");
    }
  }

  async function applySecret(custom?: string) {
    setBusy(custom !== undefined ? "save" : "rotate");
    try {
      const updated = await setWidgetIdentitySecret(widgetKey.publicKey, custom);
      onSecretChanged(updated);
      setByo("");
      setRevealed(false);
      toast.success(custom !== undefined ? "Secret saved." : "Secret rotated — update your server with the new value.");
    } catch {
      toast.error("Couldn't update the secret. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  // Server-side snippet — signs the same JWT Intercom's current Messenger uses (HS256 with your
  // Messenger API Secret). The secret is loaded from env, never inlined into client code.
  const codeSnippet = [
    'const jwt = require("jsonwebtoken");',
    "// Server-side only — sign with your Messenger API Secret (the value shown above).",
    "const token = jwt.sign(",
    "  { user_id: currentUser.id, email: currentUser.email },",
    "  process.env.NOOLA_IDENTITY_SECRET,   // === your Intercom Messenger API Secret",
    '  { algorithm: "HS256" },',
    ");",
    "",
    "// then on the page (drop-in for Intercom's intercom_user_jwt):",
    '//   Noola("boot", { intercom_user_jwt: token })',
  ].join("\n");

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Identity verification</h3>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Prove a visitor is who they claim before showing their conversation history. Your server signs a
            token with a shared secret and passes it to the widget as{" "}
            <code className="font-mono text-micro">intercom_user_jwt</code> — a spoofed{" "}
            <code className="font-mono text-micro">user_id</code> can't read someone else's chats.
          </p>
        </div>
        <Switch checked={verifyOn} onCheckedChange={onToggle} aria-label="Require identity verification" />
      </div>

      {/* Secret */}
      <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
        <Label className="flex items-center gap-1.5 text-micro uppercase tracking-wide text-muted-foreground">
          <KeyRound className="size-3.5" /> Identity verification secret
        </Label>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs">
            {revealed ? secret || "—" : masked}
          </code>
          <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={revealed ? "Hide secret" : "Reveal secret"} onClick={() => setRevealed((v) => !v)}>
            {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void copySecret()}>
            {copied ? <><Check className="text-success" /> Copied</> : <><Copy /> Copy</>}
          </Button>
        </div>
        <p className="text-micro text-muted-foreground">
          Keep this on your server only. Rotating it invalidates every previously-issued <code className="font-mono">user_hash</code>.
        </p>
      </div>

      {/* Already on Intercom? Bring your own secret. */}
      <div className="space-y-1.5">
        <Label htmlFor="byo-secret" className="text-xs">Already using Intercom?</Label>
        <div className="flex items-start gap-2">
          <Input
            id="byo-secret"
            value={byo}
            onChange={(e) => setByo(e.target.value)}
            placeholder="Paste your Intercom Messenger API Secret"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={byo.trim().length < 8 || busy !== null}
            onClick={() => void applySecret(byo.trim())}
          >
            {busy === "save" ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : "Use this secret"}
          </Button>
        </div>
        <p className="text-micro text-muted-foreground">
          Noola verifies the <strong>same signed JWT</strong> Intercom's Messenger uses (
          <code className="font-mono">intercom_user_jwt</code>, HS256). Paste your{" "}
          <strong>Messenger API Secret</strong> and pass the token your backend already generates —{" "}
          <strong>no server changes</strong>. (The legacy <code className="font-mono">user_hash</code> HMAC is
          accepted too.)
        </p>
      </div>

      {/* Server snippet */}
      <div className="space-y-1.5">
        <Label className="text-xs">Compute the hash on your server</Label>
        <pre className="overflow-x-auto rounded-md border border-input bg-background p-3 text-micro leading-relaxed">
          {codeSnippet}
        </pre>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" disabled={busy !== null} onClick={() => void applySecret()}>
          {busy === "rotate" ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <RefreshCw />} Rotate secret
        </Button>
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
  const tabIcon = { home: Home, messages: MessageCircle, help: LifeBuoy } as const;
  // Mirrors widget-embed.ts: a dark hero header (faint accent glow only) with a face cluster, the
  // Panel title + greeting exactly as an admin sets them, and a bottom nav. Accent stays budgeted.
  const heroBg = `radial-gradient(135% 120% at 16% -10%, color-mix(in srgb, ${cfg.accent} 40%, #13241d) 0%, #13241d 46%, #0b1611 100%)`;
  return (
    <div className="relative h-[340px] overflow-hidden rounded-xl border bg-muted/40">
      {/* Panel mock */}
      <div
        className={cn(
          "absolute bottom-3 flex w-[232px] flex-col overflow-hidden rounded-2xl bg-neutral-50 shadow-xl ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10",
          cfg.position === "left" ? "left-3" : "right-3",
        )}
        style={{ height: 300 }}
      >
        {/* Dark hero header */}
        <div className="relative px-3.5 pb-4 pt-3 text-white" style={{ background: heroBg }}>
          <div className="flex items-center justify-end">
            <span className="grid size-6 place-items-center rounded-full text-white ring-2 ring-[#13241d]" style={{ backgroundColor: cfg.accent }}>
              <Sparkles className="size-3" />
            </span>
            <span className="-ml-2.5 grid size-6 place-items-center rounded-full bg-white/[.16] text-[8px] font-semibold text-white ring-2 ring-[#13241d]">JS</span>
          </div>
          <div className="mt-3">
            <div className="text-[10px] font-medium text-white/60">Hi there.</div>
            <div className="text-small font-semibold leading-tight text-balance">{cfg.title || "Ask us anything"}</div>
            {cfg.greeting && <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-white/60">{cfg.greeting}</div>}
          </div>
        </div>
        {/* Body */}
        <div className="flex-1 space-y-2 overflow-hidden bg-neutral-50 p-2.5 dark:bg-neutral-800/40">
          <div className="flex items-center gap-2 rounded-xl border bg-white p-2 shadow-sm dark:border-white/10 dark:bg-neutral-900">
            <span className="grid size-6 place-items-center rounded-full bg-neutral-100 dark:bg-neutral-800" style={{ color: cfg.accent }}>
              <Sparkles className="size-3" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold text-foreground">Ask a question</div>
              <div className="truncate text-[9px] text-muted-foreground">AI Agent &amp; team · instant answers</div>
            </div>
          </div>
          {cfg.tabs.help && (
            <div className="rounded-xl border bg-white p-2 text-[9px] text-neutral-500 dark:border-white/10 dark:bg-neutral-900">Search for help…</div>
          )}
        </div>
        {/* Bottom nav */}
        {enabled.length > 1 && (
          <div className="flex border-t bg-white dark:border-white/10 dark:bg-neutral-900">
            {enabled.map((t, i) => {
              const Icon = tabIcon[t];
              return (
                <div
                  key={t}
                  className="flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[8px] font-medium capitalize text-neutral-400"
                  style={i === 0 ? { color: cfg.accent } : undefined}
                >
                  <Icon className="size-3.5" />
                  {t}
                </div>
              );
            })}
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

// ── Widget API reference ──────────────────────────────────────────────────────
// Documents the embed's programmatic surface right where the install snippet lives, so a developer
// never has to hunt for how to identify users, open the panel from a custom button, or react to
// open/close. Static reference — mirrors widget-embed.ts.
function ApiRow({ code, desc }: { code: string; desc: string }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-1.5 sm:grid-cols-[minmax(0,22rem)_1fr] sm:gap-3">
      <code className="min-w-0 break-words font-mono text-micro text-foreground/90">{code}</code>
      <span className="text-xs leading-snug text-muted-foreground">{desc}</span>
    </div>
  );
}

function WidgetApiReference() {
  return (
    <div className="space-y-2">
      <Label>Widget API</Label>
      <p className="text-xs text-muted-foreground">
        Control the widget from your site with the global <span className="font-mono">Noola(…)</span> queue — calls are
        safe before the script finishes loading.
      </p>
      <div className="divide-y rounded-md border">
        <div className="p-3">
          <div className="mb-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Embed attributes</div>
          <ApiRow code="data-noola-hidden" desc="Start with no launcher bubble — show it yourself, or open on your own button (custom launcher)." />
          <ApiRow code={'data-noola-accent="#4f46e5"'} desc="Brand accent color." />
          <ApiRow code={'data-noola-title="Ask us anything"'} desc="Header title." />
        </div>
        <div className="p-3">
          <div className="mb-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Commands</div>
          <ApiRow code="Noola('open')  ·  Noola('close')" desc="Open / close the chat panel." />
          <ApiRow code="Noola('show')  ·  Noola('hide')" desc="Show / hide the launcher bubble." />
          <ApiRow code="Noola('boot', { email, name, user_id })" desc="Identify the current visitor." />
          <ApiRow code="Noola('update', { … })" desc="Update the identified visitor's attributes." />
          <ApiRow code="Noola('track', 'event_name', { … })" desc="Log a custom activity event." />
          <ApiRow code="Noola('shutdown')" desc="Clear identity + reset (e.g. on logout)." />
        </div>
        <div className="p-3">
          <div className="mb-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Events</div>
          <ApiRow code="window.addEventListener('noola:open', fn)" desc="Fires when the panel opens." />
          <ApiRow code="window.addEventListener('noola:close', fn)" desc="Fires when the panel closes." />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Custom launcher: add <span className="font-mono">data-noola-hidden</span>, then call{" "}
        <span className="font-mono">Noola('open')</span> from your own button.
      </p>
    </div>
  );
}
