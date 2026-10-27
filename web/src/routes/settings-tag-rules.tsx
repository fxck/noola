import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Info, Plus, Trash2, ArrowUpRight, Sparkles } from "lucide-react";
import { SettingsPage } from "@/components/settings-page";
import { type TagConfig, fetchTagConfig, saveTagConfig } from "@/lib/settings";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";

// Auto-tagging rules — the keyword→tag table + the AI toggle. Every save full-replaces the rules and
// re-projects the managed 'autotag' Studio flows (one add_tags flow per rule + an ai_tag flow when
// AI is on). The Studio list shows those flows grouped under "Managed"; a tenant can fork one there
// to customize it freely. Editing the table here is the R2 "config, not a graph" surface.

interface EditRule {
  tag: string;
  keywordsText: string; // comma-separated, edited as text
  enabled: boolean;
}

function toEdit(c: TagConfig): EditRule[] {
  return c.rules.map((r) => ({ tag: r.tag, keywordsText: r.keywords.join(", "), enabled: r.enabled }));
}

export function SettingsTagRulesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const [aiEnabled, setAiEnabled] = useState(true);
  const [rules, setRules] = useState<EditRule[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoadError(false);
    try {
      const c = await fetchTagConfig();
      setAiEnabled(c.aiEnabled);
      setRules(toEdit(c));
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(nextRules: EditRule[], nextAi: boolean) {
    if (!isAdmin) return;
    setSaving(true);
    try {
      const c = await saveTagConfig({
        aiEnabled: nextAi,
        rules: nextRules
          .map((r) => ({
            tag: r.tag.trim(),
            keywords: r.keywordsText.split(",").map((k) => k.trim()).filter(Boolean),
            enabled: r.enabled,
          }))
          .filter((r) => r.tag), // drop blank-tag rows
      });
      setAiEnabled(c.aiEnabled);
      setRules(toEdit(c));
      toast.success("Auto-tagging saved.");
    } catch {
      toast.error("Couldn't save auto-tagging rules.");
    } finally {
      setSaving(false);
    }
  }

  const status = loadError ? "error" : rules === null ? "loading" : "ready";

  const setRule = (i: number, patch: Partial<EditRule>) =>
    setRules((rs) => (rs ? rs.map((r, j) => (j === i ? { ...r, ...patch } : r)) : rs));
  const addRule = () => setRules((rs) => [...(rs ?? []), { tag: "", keywordsText: "", enabled: true }]);

  return (
    <SettingsPage
      active="tag-rules"
      title="Auto-tagging"
      description="Tag new tickets automatically from their text — so the inbox is filterable from the first message."
      status={status}
      onRetry={() => void load()}
      errorTitle="Couldn't load auto-tagging rules"
    >
      {rules && (
        <div className="max-w-2xl space-y-5 px-6 pb-10 pt-4">
          {/* AI toggle */}
          <div className="flex items-start justify-between gap-4 rounded-xl border bg-card p-6 shadow-sm">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Sparkles className="size-4 text-primary" /> AI tagging
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                On top of the keyword rules below, ask your configured AI model to classify each new
                ticket into topic tags. On the built-in assistant (no provider key) this does nothing —
                the keyword rules still run.
              </p>
            </div>
            <Switch
              className="mt-0.5"
              checked={aiEnabled}
              disabled={saving || !isAdmin}
              onCheckedChange={(v) => {
                setAiEnabled(v);
                void save(rules, v);
              }}
            />
          </div>

          {/* Keyword rules */}
          <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Keyword rules</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  When a new ticket's subject or message contains any keyword, its tag is added.
                </p>
              </div>
            </div>

            <div className="space-y-2.5">
              {rules.length === 0 ? (
                <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
                  No keyword rules. New tickets won't be auto-tagged by keyword.
                </p>
              ) : (
                rules.map((r, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="grid flex-1 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2">
                      <Input
                        aria-label="Tag"
                        placeholder="tag"
                        value={r.tag}
                        disabled={!isAdmin}
                        onChange={(e) => setRule(i, { tag: e.target.value })}
                        onBlur={() => void save(rules, aiEnabled)}
                        className="font-medium"
                      />
                      <Input
                        aria-label="Keywords (comma-separated)"
                        placeholder="invoice, billing, charged"
                        value={r.keywordsText}
                        disabled={!isAdmin}
                        onChange={(e) => setRule(i, { keywordsText: e.target.value })}
                        onBlur={() => void save(rules, aiEnabled)}
                      />
                    </div>
                    <Switch
                      className="mt-2.5"
                      checked={r.enabled}
                      disabled={saving || !isAdmin}
                      aria-label={r.enabled ? "Enabled" : "Disabled"}
                      onCheckedChange={(v) => {
                        const next = rules.map((x, j) => (j === i ? { ...x, enabled: v } : x));
                        setRules(next);
                        void save(next, aiEnabled);
                      }}
                    />
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="mt-1 size-8 text-muted-foreground hover:text-destructive"
                        aria-label="Remove rule"
                        onClick={() => {
                          const next = rules.filter((_, j) => j !== i);
                          setRules(next);
                          void save(next, aiEnabled);
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                ))
              )}
            </div>

            {isAdmin && (
              <Button variant="outline" size="sm" onClick={addRule} disabled={saving}>
                <Plus /> Add rule
              </Button>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
            <p>
              These rules run as managed{" "}
              <Link to="/studio" className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline">
                Studio flows <ArrowUpRight className="size-3" />
              </Link>
              . To customize one beyond keywords — add a branch, notify a channel, chain an action —
              open it in Studio and choose <span className="font-medium text-foreground">Fork to customize</span>.
            </p>
          </div>
        </div>
      )}
    </SettingsPage>
  );
}
