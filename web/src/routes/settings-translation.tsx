import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { SettingsPage } from "@/components/settings-page";
import {
  type TranslationSettings,
  WORKSPACE_LANGUAGES,
  fetchTranslationSettings,
  saveTranslationSettings,
} from "@/lib/settings";
import { Label } from "@/components/ui/label";
import { PopoverSelect } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";

// Input-mirroring trigger for PopoverSelect in settings forms (matches ui/input.tsx).
const SELECT_TRIGGER =
  "my-0 h-9 w-full justify-between rounded-md border border-input bg-background px-3 py-1 text-sm font-normal shadow-sm hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed";

// Translation settings — the workspace's own language + the auto-translate master switch. Language
// DETECTION and the analytics breakdown run regardless of this switch; it only governs whether the
// model bridges foreign messages (customer → agent) and replies (agent → customer).
export function SettingsTranslationPage() {
  const [settings, setSettings] = useState<TranslationSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoadError(false);
    try {
      setSettings(await fetchTranslationSettings());
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(next: TranslationSettings) {
    setSaving(true);
    const prev = settings;
    setSettings(next); // optimistic
    try {
      const saved = await saveTranslationSettings({
        workspaceLocale: next.workspaceLocale,
        autoTranslate: next.autoTranslate,
      });
      setSettings(saved);
      toast.success("Translation settings saved.");
    } catch {
      setSettings(prev); // roll back
      toast.error("Couldn't save translation settings.");
    } finally {
      setSaving(false);
    }
  }

  const status = loadError ? "error" : !settings ? "loading" : "ready";

  return (
    <SettingsPage
      active="translation"
      title="Translation"
      description="Detect each customer's language and, optionally, bridge the conversation both ways."
      status={status}
      onRetry={() => void load()}
      errorTitle="Couldn't load translation settings"
    >
      {settings && (
        <div className="max-w-2xl px-6 pb-10 pt-4">
          <div className="space-y-5 rounded-xl border bg-card p-6 shadow-sm">
            {/* Workspace language — the label wraps the trigger so clicking it opens the menu */}
            <div className="space-y-1.5">
              <Label className="flex flex-col gap-1.5">
                <span>Workspace language</span>
                <PopoverSelect
                  value={settings.workspaceLocale}
                  align="start"
                  disabled={saving}
                  options={WORKSPACE_LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
                  onChange={(v) => {
                    if (v !== null) void save({ ...settings, workspaceLocale: v });
                  }}
                  buttonClassName={SELECT_TRIGGER}
                />
              </Label>
              <p className="text-xs text-muted-foreground">
                The language your team works in. Messages in any other language are the ones that
                get translated.
              </p>
            </div>

            {/* Auto-translate toggle */}
            <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Auto-translate conversations</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Translate foreign customer messages for agents, and translate agent replies back
                  into the customer's language on send.
                </p>
              </div>
              <Switch
                className="mt-0.5"
                checked={settings.autoTranslate}
                disabled={saving}
                onCheckedChange={() => void save({ ...settings, autoTranslate: !settings.autoTranslate })}
              />
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-primary" />
              <p>
                Translation uses your configured{" "}
                <span className="font-medium text-foreground">AI &amp; Model</span> provider. On the
                built-in assistant (no provider key), detection and the language breakdown still
                work, but messages are shown in their original language — nothing is ever
                mistranslated.
              </p>
            </div>
          </div>
        </div>
      )}
    </SettingsPage>
  );
}
