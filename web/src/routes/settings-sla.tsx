import { useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { toast } from "@/components/ui/toaster";
import { type SlaPolicyPatch, fetchSlaPolicy, updateSlaPolicy } from "@/lib/sla";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { SettingsPage } from "@/components/settings-page";
import { cn } from "@/lib/utils";

type Status = "loading" | "ready" | "error";

function hoursMins(total: number): string {
  if (total < 60) return `${total} min`;
  if (total % 60 === 0) return `${total / 60} h`;
  return `${Math.floor(total / 60)} h ${total % 60} min`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** minutes-past-midnight ⇄ "HH:MM" for the time inputs. */
function minToTime(m: number): string {
  const h = Math.floor(m / 60), mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
function timeToMin(v: string): number {
  const [h, m] = v.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function SettingsSlaPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [enabled, setEnabled] = useState(false);
  const [frMins, setFrMins] = useState(60);
  const [resMins, setResMins] = useState(1440);
  const [saving, setSaving] = useState(false);
  // Business hours
  const [bhEnabled, setBhEnabled] = useState(false);
  const [tzOffset, setTzOffset] = useState(0);
  const [workdays, setWorkdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [dayStart, setDayStart] = useState(540);
  const [dayEnd, setDayEnd] = useState(1020);

  function load() {
    setStatus("loading");
    fetchSlaPolicy()
      .then((p) => {
        setEnabled(p.enabled);
        setFrMins(p.firstResponseMins);
        setResMins(p.resolutionMins);
        setBhEnabled(p.businessHoursEnabled);
        setTzOffset(p.businessHours.tzOffsetMins);
        setWorkdays(p.businessHours.workdays);
        setDayStart(p.businessHours.dayStartMin);
        setDayEnd(p.businessHours.dayEndMin);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  function toggleDay(n: number) {
    setWorkdays((ds) => (ds.includes(n) ? ds.filter((d) => d !== n) : [...ds, n].sort((a, b) => a - b)));
  }

  async function save() {
    setSaving(true);
    try {
      const p: SlaPolicyPatch = {
        enabled,
        firstResponseMins: frMins,
        resolutionMins: resMins,
        businessHoursEnabled: bhEnabled,
        tzOffsetMins: tzOffset,
        workdays,
        dayStartMin: dayStart,
        dayEndMin: dayEnd,
      };
      await updateSlaPolicy(p);
      toast.success("SLA policy saved.");
    } catch {
      toast.error("Couldn't save the policy.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage
      active="sla"
      title="SLA policy"
      description="Set first-response and resolution targets, measured from when a ticket is opened."
      status={status}
      onRetry={load}
      errorTitle="Couldn't load your SLA policy"
      actions={
        <Button size="sm" onClick={() => void save()} disabled={saving || status !== "ready"}>
          {saving ? <><Loader2 className="animate-spin motion-reduce:animate-none" /> Saving…</> : <><Check /> Save policy</>}
        </Button>
      }
    >
              <div className="max-w-2xl px-6 pb-10 pt-4">
              <div className="space-y-6 rounded-xl border bg-card p-6 shadow-sm">
                {/* Enable */}
                <label className="flex items-center justify-between gap-3">
                  <span>
                    <span className="block text-sm font-medium">Enforce SLA</span>
                    <span className="block text-xs text-muted-foreground">
                      When off, no SLA badges appear and no breaches are tracked.
                    </span>
                  </span>
                  <Switch checked={enabled} onCheckedChange={(v) => setEnabled(v)} />
                </label>

                <div className={cn("grid gap-4 sm:grid-cols-2", !enabled && "opacity-50")}>
                  <div className="space-y-1.5">
                    <Label htmlFor="fr">First response (minutes)</Label>
                    <Input id="fr" type="number" min={1} value={frMins} disabled={!enabled}
                      onChange={(e) => setFrMins(Math.max(1, Number(e.target.value) || 1))} />
                    <p className="text-xs text-muted-foreground">= {hoursMins(frMins)}</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="res">Resolution (minutes)</Label>
                    <Input id="res" type="number" min={1} value={resMins} disabled={!enabled}
                      onChange={(e) => setResMins(Math.max(1, Number(e.target.value) || 1))} />
                    <p className="text-xs text-muted-foreground">= {hoursMins(resMins)}</p>
                  </div>
                </div>

                {/* Business hours — target clocks only tick during the working window */}
                <div className={cn("space-y-4 border-t pt-5", !enabled && "opacity-50")}>
                  <label className="flex items-center justify-between gap-3">
                    <span>
                      <span className="block text-sm font-medium">Count business hours only</span>
                      <span className="block text-xs text-muted-foreground">
                        SLA clocks pause outside working hours — a ticket opened Friday evening isn't
                        breached by Monday morning.
                      </span>
                    </span>
                    <Switch checked={bhEnabled} disabled={!enabled} onCheckedChange={(v) => setBhEnabled(v)} />
                  </label>

                  <div className={cn("space-y-4", !bhEnabled && "pointer-events-none opacity-50")}>
                    <div>
                      <Label className="mb-1.5 block">Working days</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {WEEKDAYS.map((label, n) => {
                          const on = workdays.includes(n);
                          return (
                            <button
                              key={n}
                              type="button"
                              disabled={!bhEnabled}
                              onClick={() => toggleDay(n)}
                              className={cn(
                                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                                on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="dstart">Day starts</Label>
                        <Input id="dstart" type="time" value={minToTime(dayStart)} disabled={!bhEnabled}
                          onChange={(e) => setDayStart(timeToMin(e.target.value))} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="dend">Day ends</Label>
                        <Input id="dend" type="time" value={minToTime(dayEnd)} disabled={!bhEnabled}
                          onChange={(e) => setDayEnd(timeToMin(e.target.value))} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="tz">UTC offset (hours)</Label>
                        <Input id="tz" type="number" min={-12} max={14} step={1} value={tzOffset / 60} disabled={!bhEnabled}
                          onChange={(e) => setTzOffset(Math.round((Number(e.target.value) || 0) * 60))} />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Fixed weekly schedule (no daylight-saving shifts). Times are in the workspace's
                      local wall clock set by the UTC offset.
                    </p>
                  </div>
                </div>
              </div>
              </div>
    </SettingsPage>
  );
}
