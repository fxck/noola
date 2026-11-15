import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Loader2, RotateCcw, Save } from "lucide-react";
import { useAuth } from "@/auth/auth";
import type { ApiError } from "@/lib/api";
import {
  SPAM_PROMPT_MAX,
  SPAM_RULES_MAX,
  type SpamSettingsResponse,
  fetchSpamSettings,
  saveSpamSettings,
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
  aiEnabled: boolean;
  rules: string;
  prompt: string;
}

function toForm(r: SpamSettingsResponse): Form {
  return { aiEnabled: r.settings.aiEnabled, rules: r.settings.rules, prompt: r.settings.prompt ?? r.defaultPrompt };
}

const LINK = "font-medium text-foreground underline-offset-4 hover:underline";

export function SettingsSpamPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState<Form | null>(null);
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [replyFormat, setReplyFormat] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function apply(r: SpamSettingsResponse) {
    const f = toForm(r);
    setForm(f);
    setSaved(f);
    setDefaultPrompt(r.defaultPrompt);
    setReplyFormat(r.replyFormat);
  }

  function load() {
    setStatus("loading");
    fetchSpamSettings()
      .then((r) => { apply(r); setStatus("ready"); })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  const dirty = form != null && JSON.stringify(form) !== JSON.stringify(saved);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  function saveError(err: unknown) {
    toast.error((err as ApiError).status === 403 ? "Only admins can change spam detection." : "Couldn't save spam detection.");
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const prompt = form.prompt.trim();
      apply(await saveSpamSettings({
        aiEnabled: form.aiEnabled,
        rules: form.rules,
        prompt: prompt && prompt !== defaultPrompt.trim() ? form.prompt : null,
      }));
      toast.success("Spam detection saved.");
    } catch (err) {
      saveError(err);
    } finally {
      setSaving(false);
    }
  }

  // Saves only the prompt, so unsaved edits to the other fields stay in the form.
  async function resetPrompt() {
    setSaving(true);
    try {
      const r = await saveSpamSettings({ prompt: null });
      const f = toForm(r);
      setSaved(f);
      setForm((cur) => (cur ? { ...cur, prompt: f.prompt } : f));
      setDefaultPrompt(r.defaultPrompt);
      setReplyFormat(r.replyFormat);
      toast.success("Prompt reset to default.");
    } catch (err) {
      saveError(err);
    } finally {
      setSaving(false);
    }
  }

  const customSaved = saved != null && saved.prompt !== defaultPrompt;

  return (
    <SettingsPage
      active="spam"
      title="Spam detection"
      description="How the AI spots spam and outreach in new emails."
      status={status}
      onRetry={load}
      errorTitle="Couldn't load spam detection settings"
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
                <p className="text-sm font-medium text-foreground">Check new emails with AI</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Only checks emails from senders your team doesn't know yet, with the General model from{" "}
                  <Link to="/settings/model" className={LINK}>
                    AI &amp; Model
                  </Link>
                  . Spam and outreach pitches are hidden in the Spam folder, where Not spam restores them.
                </p>
              </div>
              <Switch
                className="mt-0.5"
                aria-label="Check new emails with AI"
                checked={form.aiEnabled}
                disabled={!isAdmin || saving}
                onCheckedChange={(v) => set("aiEnabled", v)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="spam-rules">Extra rules</Label>
              <Textarea
                id="spam-rules"
                rows={3}
                maxLength={SPAM_RULES_MAX}
                disabled={!isAdmin || saving}
                placeholder="Hackathon and student partnership emails are legit."
                value={form.rules}
                onChange={(e) => set("rules", e.target.value)}
              />
              <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                <p>Tell the AI what counts as spam or as legit for your team.</p>
                <span className="shrink-0 tabular-nums">
                  {form.rules.length}/{SPAM_RULES_MAX}
                </span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Blocking repeat spammers is set under{" "}
              <Link to="/settings/integrations" className={LINK}>
                Blocked senders
              </Link>
              .
            </p>

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
                    <Label htmlFor="spam-prompt">Edit the whole prompt</Label>
                    {isAdmin && (customSaved || form.prompt !== defaultPrompt) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 px-2"
                        disabled={saving}
                        onClick={() => void resetPrompt()}
                      >
                        <RotateCcw className="size-3.5" />
                        Reset to default
                      </Button>
                    )}
                  </div>
                  <Textarea
                    id="spam-prompt"
                    autoGrow
                    rows={8}
                    spellCheck={false}
                    maxLength={SPAM_PROMPT_MAX}
                    disabled={!isAdmin || saving}
                    className="font-mono text-xs"
                    value={form.prompt}
                    onChange={(e) => set("prompt", e.target.value)}
                  />
                  <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                    <div className="space-y-1">
                      <p>
                        <code className="font-mono">{"{company}"}</code> becomes the workspace name. A line with only{" "}
                        <code className="font-mono">{"{product}"}</code> becomes the product description from{" "}
                        <Link to="/settings/docs-search" className={LINK}>
                          Docs search
                        </Link>
                        , and is left out when that description is empty.
                      </p>
                      <p>The extra rules and then these lines are always added after the prompt, so the answer can be read:</p>
                      <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-xs text-foreground">
                        {replyFormat}
                      </pre>
                    </div>
                    <span className="shrink-0 tabular-nums">
                      {form.prompt.length}/{SPAM_PROMPT_MAX}
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
