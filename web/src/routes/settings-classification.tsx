import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Info, Plus, Trash2, ArrowUpRight, ShieldAlert, Hash, Smile } from "lucide-react";
import { SettingsPage } from "@/components/settings-page";
import {
  type ClassificationConfig,
  type SlackTriageAction,
  SLACK_TRIAGE_ACTIONS,
  fetchClassificationConfig,
  saveClassificationConfig,
} from "@/lib/settings";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Combobox } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toaster";

// Classification config (STUDIO-SEEDED-FLOWS #3+#4) — the three classifier maps that used to be frozen
// in code, now editable per tenant. All three are R2 "config, not a flow": a form here, no graph.
//   • Topics       — keyword→primary-topic table (the floor under AI topic classification)
//   • Slack triage — emoji→action map for in-Slack reaction triage
//   • Risk guardrails — ADDITIVE patterns on top of the built-in autoreply guardrails (tighten-only)

interface TopicEdit { topic: string; keywordsText: string; enabled: boolean }
interface ReactionEdit { emoji: string; action: SlackTriageAction }
interface RiskEdit { riskTag: string; keywordsText: string; enabled: boolean }

const ACTION_LABELS: Record<SlackTriageAction, string> = {
  close: "Close ticket",
  reopen: "Reopen ticket",
  snooze: "Snooze",
  assign_me: "Assign to me",
  unassign: "Unassign",
};

function fromConfig(c: ClassificationConfig): { topics: TopicEdit[]; reactions: ReactionEdit[]; risks: RiskEdit[] } {
  return {
    topics: c.topicRules.map((r) => ({ topic: r.topic, keywordsText: r.keywords.join(", "), enabled: r.enabled })),
    reactions: c.reactionMap.map((r) => ({ emoji: r.emoji, action: r.action })),
    risks: c.riskKeywords.map((r) => ({ riskTag: r.riskTag, keywordsText: r.keywords.join(", "), enabled: r.enabled })),
  };
}
const splitKeywords = (s: string): string[] => s.split(",").map((k) => k.trim()).filter(Boolean);

export function SettingsClassificationPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const [topics, setTopics] = useState<TopicEdit[] | null>(null);
  const [reactions, setReactions] = useState<ReactionEdit[]>([]);
  const [risks, setRisks] = useState<RiskEdit[]>([]);
  const [builtinRisk, setBuiltinRisk] = useState<string[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoadError(false);
    try {
      const c = await fetchClassificationConfig();
      const e = fromConfig(c);
      setTopics(e.topics);
      setReactions(e.reactions);
      setRisks(e.risks);
      setBuiltinRisk(c.builtinRiskTags ?? []);
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(nt: TopicEdit[], nr: ReactionEdit[], nk: RiskEdit[]) {
    if (!isAdmin) return;
    setSaving(true);
    try {
      const c = await saveClassificationConfig({
        topicRules: nt.map((r) => ({ topic: r.topic.trim(), keywords: splitKeywords(r.keywordsText), enabled: r.enabled })).filter((r) => r.topic),
        reactionMap: nr.map((r) => ({ emoji: r.emoji.trim().replace(/^:|:$/g, ""), action: r.action })).filter((r) => r.emoji && r.emoji !== "📤" && r.emoji !== "outbox_tray"),
        riskKeywords: nk.map((r) => ({ riskTag: r.riskTag, keywords: splitKeywords(r.keywordsText), enabled: r.enabled })).filter((r) => r.keywords.length),
      });
      const e = fromConfig(c);
      setTopics(e.topics);
      setReactions(e.reactions);
      setRisks(e.risks);
      setBuiltinRisk(c.builtinRiskTags ?? []);
      toast.success("Classification saved.");
    } catch {
      toast.error("Couldn't save classification settings.");
    } finally {
      setSaving(false);
    }
  }
  const saveAll = () => topics && void save(topics, reactions, risks);

  const status = loadError ? "error" : topics === null ? "loading" : "ready";
  const riskActionOpts = SLACK_TRIAGE_ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] }));
  const riskTagOpts = builtinRisk.map((t) => ({ value: t, label: t.replace(/_/g, " ") }));

  return (
    <SettingsPage
      active="classification"
      title="Classification"
      description="How incoming tickets are auto-classified — topics, reaction-triage shortcuts, and the safety guardrails that hold risky messages for a human."
      status={status}
      onRetry={() => void load()}
      errorTitle="Couldn't load classification settings"
    >
      {topics && (
        <div className="max-w-2xl space-y-5 px-6 pb-10 pt-4">
          {/* ── Topics ─────────────────────────────────────────── */}
          <section className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2">
              <Hash className="size-4 text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Topics</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Every ticket gets one primary topic. When a hosted AI model is configured it picks the
                  topic; these keyword rules are the always-on fallback — first matching rule wins, so
                  order them specific-first.
                </p>
              </div>
            </div>
            <RuleRows
              rows={topics}
              isAdmin={isAdmin}
              saving={saving}
              nameLabel="Topic"
              namePlaceholder="billing"
              keywordsPlaceholder="invoice, billing, charged"
              onChange={(next) => setTopics(next)}
              onCommit={(next) => void save(next, reactions, risks)}
            />
            {isAdmin && (
              <Button variant="outline" size="sm" disabled={saving} onClick={() => setTopics([...topics, { topic: "", keywordsText: "", enabled: true }])}>
                <Plus /> Add topic
              </Button>
            )}
          </section>

          {/* ── Reaction triage (Slack channels + Discord ops-mirror forum) ── */}
          <section className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2">
              <Smile className="size-4 text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Reaction triage</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  React on a message to triage its ticket — in a connected Slack channel, or on a mirrored
                  conversation in your Discord management forum. One shared map: emoji name (without colons)
                  or the emoji itself → action. 📤 is reserved for send-to-customer in Discord.
                </p>
              </div>
            </div>
            <div className="space-y-2.5">
              {reactions.length === 0 ? (
                <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
                  No reaction shortcuts. Emoji reactions won't triage tickets.
                </p>
              ) : (
                reactions.map((r, i) => {
                  const setR = (patch: Partial<ReactionEdit>) => setReactions(reactions.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <div className="flex flex-1 items-center gap-1.5">
                        <span className="text-muted-foreground">:</span>
                        <Input
                          aria-label="Emoji name"
                          placeholder="white_check_mark"
                          value={r.emoji}
                          disabled={!isAdmin}
                          onChange={(e) => setR({ emoji: e.target.value })}
                          onBlur={saveAll}
                          className="font-mono"
                        />
                        <span className="text-muted-foreground">:</span>
                      </div>
                      <div className="w-40 shrink-0">
                        <Combobox
                          value={r.action}
                          options={riskActionOpts}
                          onChange={(v) => {
                            const next = reactions.map((x, j) => (j === i ? { ...x, action: v as SlackTriageAction } : x));
                            setReactions(next);
                            void save(topics, next, risks);
                          }}
                        />
                      </div>
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          aria-label="Remove reaction"
                          onClick={() => {
                            const next = reactions.filter((_, j) => j !== i);
                            setReactions(next);
                            void save(topics, next, risks);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            {isAdmin && (
              <Button variant="outline" size="sm" disabled={saving} onClick={() => setReactions([...reactions, { emoji: "", action: "close" }])}>
                <Plus /> Add reaction
              </Button>
            )}
          </section>

          {/* ── Risk guardrails (additive) ─────────────────────── */}
          <section className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-amber-500" />
              <div>
                <p className="text-sm font-medium text-foreground">Risk guardrails</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Messages matching a guardrail are never auto-answered — they're held for a human. The
                  built-in guardrails always apply; you can only <span className="font-medium text-foreground">add</span> patterns
                  to tighten them, never remove one.
                </p>
              </div>
            </div>
            {builtinRisk.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/50 p-3">
                <span className="mr-1 text-xs font-medium text-muted-foreground">Always on:</span>
                {builtinRisk.map((t) => (
                  <Badge key={t} variant="muted" className="font-normal">{t.replace(/_/g, " ")}</Badge>
                ))}
              </div>
            )}
            <div className="space-y-2.5">
              {risks.length === 0 ? (
                <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
                  No custom patterns. Only the built-in guardrails above apply.
                </p>
              ) : (
                risks.map((r, i) => {
                  const setR = (patch: Partial<RiskEdit>) => setRisks(risks.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <div key={i} className="flex items-start gap-2">
                      <div className="w-44 shrink-0">
                        <Combobox
                          value={r.riskTag}
                          options={riskTagOpts}
                          onChange={(v) => {
                            const next = risks.map((x, j) => (j === i ? { ...x, riskTag: v } : x));
                            setRisks(next);
                            void save(topics, reactions, next);
                          }}
                        />
                      </div>
                      <Input
                        aria-label="Keywords (comma-separated)"
                        placeholder="wire transfer, dispute"
                        value={r.keywordsText}
                        disabled={!isAdmin}
                        onChange={(e) => setR({ keywordsText: e.target.value })}
                        onBlur={saveAll}
                        className="flex-1"
                      />
                      <Switch
                        className="mt-2.5"
                        checked={r.enabled}
                        disabled={saving || !isAdmin}
                        aria-label={r.enabled ? "Enabled" : "Disabled"}
                        onCheckedChange={(v) => {
                          const next = risks.map((x, j) => (j === i ? { ...x, enabled: v } : x));
                          setRisks(next);
                          void save(topics, reactions, next);
                        }}
                      />
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="mt-1 size-8 text-muted-foreground hover:text-destructive"
                          aria-label="Remove pattern"
                          onClick={() => {
                            const next = risks.filter((_, j) => j !== i);
                            setRisks(next);
                            void save(topics, reactions, next);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            {isAdmin && builtinRisk.length > 0 && (
              <Button variant="outline" size="sm" disabled={saving} onClick={() => setRisks([...risks, { riskTag: builtinRisk[0], keywordsText: "", enabled: true }])}>
                <Plus /> Add pattern
              </Button>
            )}
          </section>

          <div className="flex items-start gap-2 rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
            <p>
              These are configuration tables, not flows. For branching, multi-step logic build a flow in{" "}
              <Link to="/studio" className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline">
                Studio <ArrowUpRight className="size-3" />
              </Link>
              . Auto-tagging lives in its own <Link to="/settings/tag-rules" className="font-medium text-foreground hover:underline">Auto-tagging</Link> page.
            </p>
          </div>
        </div>
      )}
    </SettingsPage>
  );
}

// Shared keyword-rule rows (name + comma-keywords + enabled + delete) — used by the Topics section.
function RuleRows({
  rows, isAdmin, saving, nameLabel, namePlaceholder, keywordsPlaceholder, onChange, onCommit,
}: {
  rows: TopicEdit[];
  isAdmin: boolean;
  saving: boolean;
  nameLabel: string;
  namePlaceholder: string;
  keywordsPlaceholder: string;
  onChange: (next: TopicEdit[]) => void;
  onCommit: (next: TopicEdit[]) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
        No rules yet.
      </p>
    );
  }
  return (
    <div className="space-y-2.5">
      {rows.map((r, i) => {
        const setRow = (patch: Partial<TopicEdit>) => onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={i} className="flex items-start gap-2">
            <div className="grid flex-1 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2">
              <Input
                aria-label={nameLabel}
                placeholder={namePlaceholder}
                value={r.topic}
                disabled={!isAdmin}
                onChange={(e) => setRow({ topic: e.target.value })}
                onBlur={() => onCommit(rows)}
                className="font-medium"
              />
              <Input
                aria-label="Keywords (comma-separated)"
                placeholder={keywordsPlaceholder}
                value={r.keywordsText}
                disabled={!isAdmin}
                onChange={(e) => setRow({ keywordsText: e.target.value })}
                onBlur={() => onCommit(rows)}
              />
            </div>
            <Switch
              className="mt-2.5"
              checked={r.enabled}
              disabled={saving || !isAdmin}
              aria-label={r.enabled ? "Enabled" : "Disabled"}
              onCheckedChange={(v) => {
                const next = rows.map((x, j) => (j === i ? { ...x, enabled: v } : x));
                onChange(next);
                onCommit(next);
              }}
            />
            {isAdmin && (
              <Button
                variant="ghost"
                size="icon"
                className="mt-1 size-8 text-muted-foreground hover:text-destructive"
                aria-label="Remove rule"
                onClick={() => {
                  const next = rows.filter((_, j) => j !== i);
                  onChange(next);
                  onCommit(next);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
