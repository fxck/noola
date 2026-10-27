import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Bot,
  ClipboardCheck,
  FlaskConical,
  MessageCircle,
  ScrollText,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { SettingsPage } from "@/components/settings-page";
import { type AiOverview, fetchAiOverview } from "@/lib/ai";
import { cn } from "@/lib/utils";

// The AI governance hub (Wave 5 item 22) — one read-only surface that packages the
// governable-AI story: which model answers, in whose voice, under what guardrails,
// with what human oversight, how it's evaluated, and where the audit trail lives.
// Every card links to the page that owns the knob; nothing mutates here.

const MODE_LABEL: Record<string, string> = {
  off: "Off",
  suggest_only: "Suggest only",
  auto: "Auto-send",
};

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-lg font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="text-micro text-muted-foreground">{label}</div>
    </div>
  );
}

function GovernCard({ icon: Icon, title, to, children }: {
  icon: typeof Bot;
  title: string;
  to: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
        <Link
          to={to}
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          Configure <ArrowRight className="size-3" />
        </Link>
      </div>
      <div className="mt-2.5 space-y-1.5 text-sm">{children}</div>
    </div>
  );
}

function Line({ label, value, tone }: { label: string; value: string; tone?: "warn" | "danger" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-right text-sm font-medium",
          tone === "danger" && "text-destructive",
          tone === "warn" && "text-amber-600 dark:text-amber-500",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function SettingsAiPage() {
  const [data, setData] = useState<AiOverview | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useRef(async () => {
    setLoadError(false);
    try {
      setData(await fetchAiOverview());
    } catch {
      setLoadError(true);
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  const status = loadError ? "error" : data === null ? "loading" : "ready";

  return (
    <SettingsPage
      active="ai"
      title="AI"
      description="One governed system: model, voice, guardrails, oversight, evaluation, audit."
      status={status}
      onRetry={() => void load()}
      errorTitle="Couldn't load the AI overview"
    >
      {data && (
              <div className="max-w-3xl px-6 pb-10 pt-4">
                {/* kill switch banner — the one state that must never hide in a card */}
                {data.policy.killSwitch && (
                  <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-destructive/40 bg-destructive/5 p-3.5 text-sm">
                    <ShieldAlert className="size-4 shrink-0 text-destructive" />
                    <span>
                      <span className="font-medium text-destructive">Kill switch is on</span> — all
                      auto-sending is paused; drafts still queue for review.
                    </span>
                    <Link to="/settings/autoreply" className="ml-auto text-xs font-medium text-primary underline-offset-4 hover:underline">
                      Manage
                    </Link>
                  </div>
                )}

                {/* 7-day activity strip */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <StatChip label="drafts · 7d" value={data.activity7d.drafts} />
                  <StatChip label="auto-sent · 7d" value={data.activity7d.autoSent} />
                  <StatChip label="held for review · 7d" value={data.activity7d.held} />
                  <StatChip label="agent runs · 7d" value={data.activity7d.agentRuns} />
                  <StatChip label="deflected · 7d" value={data.activity7d.deflected} />
                </div>

                {/* governance cards */}
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <GovernCard icon={Sparkles} title="Model" to="/settings/model">
                    <Line label="Provider" value={data.model.provider} />
                    <Line label="Model" value={data.model.model ?? "baseline"} />
                    <Line
                      label="Key"
                      value={data.model.hasKey ? "Your own key (BYO)" : "Managed baseline"}
                    />
                  </GovernCard>

                  <GovernCard icon={MessageCircle} title="Voice" to="/settings/persona">
                    <Line label="Persona" value={data.persona.configured ? "Configured" : "Default"} />
                    <Line label="Tone" value={data.persona.tone} />
                  </GovernCard>

                  <GovernCard icon={Bot} title="Autoreply & routing" to="/settings/autoreply">
                    <Line label="Mode" value={MODE_LABEL[data.policy.mode] ?? data.policy.mode} />
                    <Line
                      label="Kill switch"
                      value={data.policy.killSwitch ? "ON — sending paused" : "Off"}
                      tone={data.policy.killSwitch ? "danger" : undefined}
                    />
                    <Line
                      label="Confidence floor"
                      value={
                        data.policy.minConfidence != null
                          ? `${Math.round(data.policy.minConfidence * 100)}%`
                          : "No floor"
                      }
                    />
                    <Line
                      label="Channel overrides"
                      value={
                        data.policy.channelOverrides === 0
                          ? "None"
                          : `${data.policy.channelOverrides} channel${data.policy.channelOverrides === 1 ? "" : "s"}`
                      }
                    />
                  </GovernCard>

                  <GovernCard icon={ClipboardCheck} title="Approval queue" to="/queue">
                    <Line
                      label="Waiting for review"
                      value={String(data.queue.pending)}
                      tone={data.queue.pending > 0 ? "warn" : undefined}
                    />
                    <p className="text-xs text-muted-foreground">
                      Drafts the gate held — a human sends, edits, or dismisses each one.
                    </p>
                  </GovernCard>

                  <GovernCard icon={FlaskConical} title="Test bench" to="/simulations">
                    {data.lastEval ? (
                      <>
                        <Line label="Last eval" value={data.lastEval.label} />
                        <Line
                          label="Avg score"
                          value={data.lastEval.avgScore != null ? data.lastEval.avgScore.toFixed(2) : "—"}
                        />
                        <Line
                          label="Would auto-send"
                          value={`${Math.round(data.lastEval.autoSendRate * 100)}%`}
                        />
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No evals run yet — simulate the agent against past tickets before turning
                        anything up.
                      </p>
                    )}
                  </GovernCard>

                  <GovernCard icon={ScrollText} title="Audit trail" to="/settings/audit">
                    <Line label="Drafts traced · 7d" value={String(data.activity7d.drafts)} />
                    <Line
                      label="Public answers cite only"
                      value={data.policy.publicSourceKinds.join(", ")}
                    />
                    <p className="text-xs text-muted-foreground">
                      Every draft records its sources, scores, gate decision, and human outcome.
                    </p>
                  </GovernCard>
                </div>
              </div>
      )}
    </SettingsPage>
  );
}
