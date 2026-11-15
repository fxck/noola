import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { useAuth } from "@/auth/auth";
import type { ApiError } from "@/lib/api";
import { type GapSettings, fetchGapSettings, saveGapSettings } from "@/lib/settings";
import { SettingsPage } from "@/components/settings-page";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";

const LINK = "font-medium text-foreground underline-offset-4 hover:underline";

export function SettingsGapsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const [settings, setSettings] = useState<GapSettings | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);

  function load() {
    setStatus("loading");
    fetchGapSettings()
      .then((r) => {
        setSettings(r.settings);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  async function save(next: GapSettings) {
    const prev = settings;
    setSettings(next);
    setSaving(true);
    try {
      setSettings((await saveGapSettings(next)).settings);
      toast.success(next.enabled ? "Knowledge gap review is on." : "Knowledge gap review is off.");
    } catch (err) {
      setSettings(prev);
      const e = err as ApiError;
      toast.error(
        e.status === 403
          ? "Only admins can change knowledge gaps."
          : e.detail === "needs_hosted_model"
            ? e.serverMessage ?? "The review needs a hosted model. Connect one in AI & Model."
            : "Couldn't save knowledge gaps.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage
      active="gaps"
      title="Knowledge gaps"
      description="Find the questions in closed conversations that your docs and help articles miss."
      status={status}
      onRetry={load}
      errorTitle="Couldn't load knowledge gap settings"
      actions={!isAdmin && settings && <span className="text-xs text-muted-foreground">Only admins can change these settings.</span>}
    >
      {settings && (
        <div className="max-w-2xl px-6 pb-10 pt-4">
          <div className="space-y-5 rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
              <div className="min-w-0 space-y-1.5">
                <p className="text-sm font-medium text-foreground">Review closed conversations</p>
                <p className="text-xs text-muted-foreground">
                  About 10 minutes after a conversation closes, the General model from{" "}
                  <Link to="/settings/model" className={LINK}>
                    AI &amp; Model
                  </Link>{" "}
                  reads it. Each reusable question that your docs or help articles miss becomes a gap, and repeats of
                  one question join the same gap. Turning it on also reviews the conversations closed in the last 180
                  days.
                </p>
                <p className="text-xs text-muted-foreground">A review costs about 2 cents per conversation with Sonnet.</p>
              </div>
              <Switch
                className="mt-0.5"
                aria-label="Review closed conversations"
                checked={settings.enabled}
                disabled={!isAdmin || saving}
                onCheckedChange={(v) => void save({ enabled: v })}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              The gaps are listed under{" "}
              <Link to="/kb" search={{ collection: "gaps" }} className={LINK}>
                Gaps
              </Link>{" "}
              in the knowledge base, split into docs to improve and articles to write.
            </p>

            <div className="flex items-start gap-2 rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-primary" />
              <p>The review needs a hosted model, so no conversations are reviewed on the managed baseline.</p>
            </div>
          </div>
        </div>
      )}
    </SettingsPage>
  );
}
