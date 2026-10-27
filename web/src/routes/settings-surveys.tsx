import { useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { toast } from "@/components/ui/toaster";
import { fetchSurveySettings, updateSurveySettings } from "@/lib/surveys";
import { Button } from "@/components/ui/button";
import { SettingsPage } from "@/components/settings-page";
import { Switch } from "@/components/ui/switch";

type Status = "loading" | "ready" | "error";

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <Switch checked={on} onCheckedChange={onToggle} />;
}

export function SettingsSurveysPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [csat, setCsat] = useState(false);
  const [nps, setNps] = useState(false);
  const [saving, setSaving] = useState(false);

  function load() {
    setStatus("loading");
    fetchSurveySettings()
      .then((s) => {
        setCsat(s.csatEnabled);
        setNps(s.npsEnabled);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  async function save() {
    setSaving(true);
    try {
      await updateSurveySettings({ csatEnabled: csat, npsEnabled: nps });
      toast.success("Survey settings saved.");
    } catch {
      toast.error("Couldn't save survey settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage
      active="surveys"
      title="Satisfaction surveys"
      description="When a ticket is resolved, automatically ask the customer for feedback on the conversation's own channel."
      status={status}
      onRetry={load}
      errorTitle="Couldn't load survey settings"
      actions={
        <Button size="sm" onClick={() => void save()} disabled={saving || status !== "ready"}>
          {saving ? <><Loader2 className="animate-spin motion-reduce:animate-none" /> Saving…</> : <><Check /> Save settings</>}
        </Button>
      }
    >
              <div className="max-w-2xl px-6 pb-10 pt-4">
              <div className="space-y-5 rounded-xl border bg-card p-6 shadow-sm">
                <label className="flex items-center justify-between gap-3">
                  <span>
                    <span className="block text-sm font-medium">Send CSAT on resolution</span>
                    <span className="block text-xs text-muted-foreground">
                      A 1–5 star rating request. Ratings roll up on the Analytics dashboard.
                    </span>
                  </span>
                  <Toggle on={csat} onToggle={() => setCsat((v) => !v)} />
                </label>

                <label className="flex items-center justify-between gap-3 border-t pt-5">
                  <span>
                    <span className="block text-sm font-medium">Send NPS on resolution</span>
                    <span className="block text-xs text-muted-foreground">
                      A 0–10 "how likely to recommend" question. Feeds the NPS tile on Analytics.
                    </span>
                  </span>
                  <Toggle on={nps} onToggle={() => setNps((v) => !v)} />
                </label>
              </div>
              </div>
    </SettingsPage>
  );
}
