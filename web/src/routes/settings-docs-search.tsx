import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Loader2, RotateCcw, Save } from "lucide-react";
import { useAuth } from "@/auth/auth";
import type { ApiError } from "@/lib/api";
import {
  DOCS_SEARCH_PRODUCT_MAX,
  DOCS_SEARCH_PROMPT_MAX,
  type DocsSearchResponse,
  fetchDocsSearchSettings,
  saveDocsSearchSettings,
} from "@/lib/settings";
import { SettingsPage } from "@/components/settings-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

// The form always holds a prompt text, so the editor shows the default when nothing custom is saved.
interface Form {
  rewrite: boolean;
  product: string;
  prompt: string;
}

function toForm(r: DocsSearchResponse): Form {
  return { rewrite: r.settings.rewrite, product: r.settings.product, prompt: r.settings.prompt ?? r.defaultPrompt };
}

export function SettingsDocsSearchPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState<Form | null>(null);
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [replyFormat, setReplyFormat] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function apply(r: DocsSearchResponse) {
    const f = toForm(r);
    setForm(f);
    setSaved(f);
    setDefaultPrompt(r.defaultPrompt);
    setReplyFormat(r.replyFormat);
  }

  function load() {
    setStatus("loading");
    fetchDocsSearchSettings()
      .then((r) => { apply(r); setStatus("ready"); })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  const dirty = form != null && JSON.stringify(form) !== JSON.stringify(saved);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const prompt = form.prompt.trim();
      apply(await saveDocsSearchSettings({
        rewrite: form.rewrite,
        product: form.product,
        prompt: prompt && prompt !== defaultPrompt.trim() ? form.prompt : null,
      }));
      toast.success("Docs search settings saved.");
    } catch (err) {
      toast.error((err as ApiError).status === 403 ? "Only admins can change docs search." : "Couldn't save docs search settings.");
    } finally {
      setSaving(false);
    }
  }

  const customSaved = saved != null && saved.prompt !== defaultPrompt;

  return (
    <SettingsPage
      active="docs-search"
      title="Docs search"
      description="How the AI searches your docs before it answers a customer."
      status={status}
      onRetry={load}
      errorTitle="Couldn't load docs search settings"
      actions={
        form &&
        (isAdmin ? (
          <>
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
            <Button size="sm" className="gap-1.5" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Save className="size-3.5" />}
              Save
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Only admins can change these settings.</span>
        ))
      }
    >
      {form && (
        <div className="max-w-2xl px-6 pb-10 pt-4">
          <div className="space-y-5 rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Rewrite questions for the docs search</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The Search &amp; translation model turns each customer message into a short query in the workspace
                  language, and the AI searches with the message and the query. This finds the right docs for long, messy or foreign-language
                  messages, at the cost of one quick model call per question. Choose the model under{" "}
                  <Link to="/settings/model" className="font-medium text-foreground underline-offset-4 hover:underline">
                    AI &amp; Model
                  </Link>
                  .
                </p>
              </div>
              <Switch
                className="mt-0.5"
                checked={form.rewrite}
                disabled={!isAdmin || saving}
                onCheckedChange={(v) => set("rewrite", v)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="docs-search-product">About your product</Label>
              <Textarea
                id="docs-search-product"
                rows={2}
                maxLength={DOCS_SEARCH_PRODUCT_MAX}
                disabled={!isAdmin || saving}
                placeholder="e.g. Zerops is a developer cloud platform for deploying apps, databases and services."
                value={form.product}
                onChange={(e) => set("product", e.target.value)}
              />
              <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                <p>A sentence or two that helps the model read messages with several possible meanings.</p>
                <span className="shrink-0 tabular-nums">
                  {form.product.length}/{DOCS_SEARCH_PRODUCT_MAX}
                </span>
              </div>
            </div>

            <div className="border-t pt-4">
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                aria-expanded={advancedOpen}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight className={cn("size-3.5 transition-transform duration-150", advancedOpen && "rotate-90")} />
                Advanced
                {customSaved && <Badge variant="muted">Custom prompt</Badge>}
              </button>

              {advancedOpen && (
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="docs-search-prompt">Edit the whole prompt</Label>
                    {isAdmin && form.prompt !== defaultPrompt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 px-2"
                        disabled={saving}
                        onClick={() => set("prompt", defaultPrompt)}
                      >
                        <RotateCcw className="size-3.5" />
                        Reset to default
                      </Button>
                    )}
                  </div>
                  <Textarea
                    id="docs-search-prompt"
                    autoGrow
                    rows={8}
                    spellCheck={false}
                    maxLength={DOCS_SEARCH_PROMPT_MAX}
                    disabled={!isAdmin || saving}
                    className="font-mono text-xs"
                    value={form.prompt}
                    onChange={(e) => set("prompt", e.target.value)}
                  />
                  <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                    <div className="space-y-1">
                      <p>
                        <code className="font-mono">{"{language}"}</code> becomes the workspace language.{" "}
                        <code className="font-mono">{"{product}"}</code> becomes your product description, and a line
                        with only <code className="font-mono">{"{product}"}</code> is left out when the description is
                        empty.
                      </p>
                      <p>This line is always added after the prompt, so the reply can be read:</p>
                      <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-xs text-foreground">
                        {replyFormat}
                      </pre>
                      <p>If the reply has no query, the docs are searched with the customer's message alone.</p>
                    </div>
                    <span className="shrink-0 tabular-nums">
                      {form.prompt.length}/{DOCS_SEARCH_PROMPT_MAX}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </SettingsPage>
  );
}
