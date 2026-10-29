import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, ShieldAlert, Sparkles, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { fetchTrace, isTraceGone, traceOutcomeLabel, type TraceDetail, type TraceSource } from "@/lib/traces";
import { relativeTime } from "@/lib/tickets";
import { estimateCost, fmtCost, isLocalModel, shortModel } from "@/lib/model-cost";
import { CopyId, compactNum, fmtMs, fmtScore } from "@/components/live/nerd-stats";
import { cn } from "@/lib/utils";

// One AI trace for an admin: what the customer wrote, what the model wrote word for word, and what Noola did with it.
// It renders in a portal, so it covers the hover popover that the AI message's receipt opens from.

const ACTIONS: Record<string, string> = {
  sent: "Sent the reply.",
  ondemand_sent: "Sent the reply.",
  sent_with_handoff: "Sent the reply, then handed over to a teammate.",
  no_reply_needed: "Sent nothing (no reply needed).",
  no_reply_suggested: "Sent nothing and suggested to the team that no reply is needed.",
  note_only: "Left a note for the team and handed over.",
  handoff: "Handed over to a teammate without a reply.",
  handoff_requested: "Sent nothing, because the customer asked for a person.",
  suggest_only: "Held the reply for review (suggest only).",
  weak_retrieval: "Held the reply for review: low corroboration.",
  low_confidence: "Held the reply for review: low confidence.",
  thread_cap: "Held the reply: this conversation reached its auto-reply limit.",
  rate_limited: "Held the reply: the hourly auto-reply limit was reached.",
  ondemand_rate_limited: "Held the reply: the hourly limit for on-demand answers was reached.",
  ondemand_disabled: "Sent nothing, because on-demand answers are off.",
  claimed_elsewhere: "Sent nothing, because another answer already covered this message.",
  kill: "Sent nothing, because the AI is switched off.",
  channel_skipped: "Sent nothing, because AI replies are off on this channel.",
};

const HUMAN_OUTCOMES: Record<string, string> = {
  edited: "Edited, then sent",
  sent_as_is: "Sent as is",
  discarded: "Discarded",
  thumbs_up: "Thumbs up",
  thumbs_down: "Thumbs down",
};

const DECISION_SOURCES: Record<string, string> = {
  ambient: "autoreply",
  on_demand: "on demand",
};

// The gate reason is the more specific one, since the decision for a reply with a handoff records plain "sent".
function actionReason(t: TraceDetail): { outcome: string | null; reason: string | null } {
  const last = t.decisions[t.decisions.length - 1];
  return t.gateReason ? { outcome: t.gateOutcome, reason: t.gateReason } : { outcome: last?.outcome ?? null, reason: last?.reason ?? null };
}

/** A sentence for what Noola did with the draft. */
function describeAction(t: TraceDetail): string {
  const problem = t.parsed.kind === "malformed" ? t.parsed.problem : null;
  const { outcome, reason } = actionReason(t);
  if (!reason) {
    return problem
      ? `Nothing recorded a decision. The answer tags are malformed (${problem}).`
      : "Nothing recorded a decision, as for Draft with AI or a widget answer without tags.";
  }
  if (reason === "malformed_output") return `Held for review: malformed tags${problem ? ` (${problem})` : ""}.`;
  if (reason.startsWith("guardrail")) {
    const tags = reason.split(":")[1];
    return `Held the reply: guardrail${tags ? ` (${tags})` : ""}.`;
  }
  return ACTIONS[reason] ?? [outcome, reason].filter(Boolean).join(": ");
}

// A well-formed note block, a well-formed self-closing tag, or a broken piece of a tag, read like the server's parser.
// A broken opening piece stops at the line's end, so an unclosed tag can't paint the rest of the draft.
const TAG = /<internal>([\s\S]*?)<\/internal>|<no_reply\s*\/>|<handoff\s*\/>|<\s*\/?\s*(?:internal|no_reply|handoff)\b[^<>\n]*>?|\b(?:internal|no_reply|handoff)\s*\/?\s*>/gi;
// The server reads tags case-sensitively, so a differently cased tag that TAG still matches shows as broken.
const NOTE_BLOCK = /^<internal>[\s\S]*<\/internal>$/;
const SELF_CLOSING = /^<(no_reply|handoff)\s*\/>$/;

function highlightTags(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TAG)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined && NOTE_BLOCK.test(m[0])) {
      out.push(
        <span key={at} className="rounded bg-warning/10">
          <span className="font-semibold text-warning">{"<internal>"}</span>
          {m[1]}
          <span className="font-semibold text-warning">{"</internal>"}</span>
        </span>,
      );
    } else if (SELF_CLOSING.test(m[0])) {
      out.push(
        <span key={at} className="rounded bg-primary/15 px-0.5 font-semibold text-primary">
          {m[0]}
        </span>,
      );
    } else {
      out.push(
        <span key={at} title="A broken tag" className="rounded bg-destructive/10 px-0.5 font-semibold text-destructive">
          {m[0]}
        </span>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const SOURCE_LINK = "min-w-0 flex-1 truncate text-primary underline-offset-2 hover:underline";

// Each source opens what it was: the article, the resolved ticket, the docs page, or the uploaded document.
function SourceTitle({ s }: { s: TraceSource }) {
  const label = s.title || s.id;
  if (s.kind === "kb") return <Link to="/kb/$articleId" params={{ articleId: s.id }} className={SOURCE_LINK} title={label}>{label}</Link>;
  if (s.kind === "thread") return <Link to="/tickets/$ticketId" params={{ ticketId: s.id }} className={SOURCE_LINK} title={label}>{label}</Link>;
  if (s.url) return <a href={s.url} target="_blank" rel="noreferrer" className={SOURCE_LINK} title={s.url}>{label}</a>;
  if (s.documentId) return <Link to="/documents/$id" params={{ id: s.documentId }} className={SOURCE_LINK} title={label}>{label}</Link>;
  return <span className="min-w-0 flex-1 truncate text-foreground" title={label}>{label}</span>;
}

const SOURCE_KINDS: Record<string, string> = { kb: "article", thread: "conversation", document: "document" };
const FOUND_BY: Record<string, string> = { query: "AI query", message: "Message", both: "Both" };

// A source that only one of the two searches found scores at most 1/61 in the api's fusion.
const ONE_SEARCH_MAX = 1 / 61 + 1e-9;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function sourcesSummary(sources: TraceSource[]): string {
  const parts: string[] = [];
  const docs = sources.filter((s) => s.kind === "document");
  if (docs.length) parts.push(`${plural(docs.length, "passage")} from ${plural(new Set(docs.map((s) => s.documentId ?? s.url ?? s.title)).size, "document")}`);
  const articles = sources.filter((s) => s.kind === "kb").length;
  if (articles) parts.push(plural(articles, "article"));
  const threads = sources.filter((s) => s.kind === "thread").length;
  if (threads) parts.push(plural(threads, "past conversation"));
  return parts.join(", ");
}

const RANK_CELL = "w-14 shrink-0 text-right font-mono tabular-nums";

function SourceList({ sources }: { sources: TraceSource[] }) {
  const ranked = sources.some((s) => s.keywordRank != null || s.meaningRank != null);
  const withQuery = sources.some((s) => s.foundBy != null);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{sourcesSummary(sources)}</p>
      <div className="flex items-center gap-2 border-b pb-1 text-micro text-muted-foreground">
        <span className="flex-1">Source</span>
        {ranked ? (
          <>
            <span className={RANK_CELL} title="Where the keyword search ranked it">Keyword</span>
            <span className={RANK_CELL} title="Where the meaning search ranked it">Meaning</span>
          </>
        ) : (
          <span className="w-32 shrink-0 text-right">Match</span>
        )}
        {withQuery && <span className={RANK_CELL} title="Which search text found it">Found by</span>}
      </div>
      <ul className="space-y-2">
        {sources.map((s, i) => (
          <li key={`${s.kind}:${s.id}:${i}`} className="text-xs">
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="shrink-0 rounded border border-border px-1 py-px font-mono text-micro text-muted-foreground">
                  {SOURCE_KINDS[s.kind] ?? s.kind}
                </span>
                <SourceTitle s={s} />
              </div>
              {ranked ? (
                <>
                  <span className={RANK_CELL}>{s.keywordRank != null ? `#${s.keywordRank}` : "—"}</span>
                  <span className={RANK_CELL}>{s.meaningRank != null ? `#${s.meaningRank}` : "—"}</span>
                </>
              ) : (
                <span className="w-32 shrink-0 text-right text-muted-foreground">
                  {s.score > ONE_SEARCH_MAX ? "both searches" : s.score > 0 ? "one search" : "—"}
                </span>
              )}
              {withQuery && (
                <span
                  className={cn(RANK_CELL, "font-sans text-muted-foreground")}
                  title={s.foundBy === "both" ? "The ranks are from the search text that scored it higher" : undefined}
                >
                  {s.foundBy ? FOUND_BY[s.foundBy] : "—"}
                </span>
              )}
            </div>
            {(s.passage != null || s.excerpt) && (
              <p className="mt-0.5 line-clamp-2 text-muted-foreground">
                {s.passage != null && <span className="text-foreground">Passage {s.passage + 1}{s.passages ? ` of ${s.passages}` : ""}</span>}
                {s.passage != null && s.excerpt && " · "}
                {s.excerpt}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TraceDialog({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<"gone" | "failed" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrace(null);
    setError(null);
    fetchTrace(traceId)
      .then((t) => !cancelled && setTrace(t))
      .catch((e) => !cancelled && setError(isTraceGone(e) ? "gone" : "failed"));
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="motion-overlay fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="AI trace"
      onClick={onClose}
    >
      <div
        className="motion-pop my-auto flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">AI trace</h2>
              <p className="text-micro text-muted-foreground">What the model wrote for this draft, and what Noola did with it.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {error === "gone" ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              This trace no longer exists. It may have passed the retention period.
            </p>
          ) : error ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">Couldn't load this trace.</p>
          ) : !trace ? (
            <div className="px-5 py-8">
              <div className="mx-auto h-4 w-40 rounded bg-muted/60 motion-safe:animate-pulse" />
            </div>
          ) : (
            <TraceBody t={trace} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TraceBody({ t }: { t: TraceDetail }) {
  const local = isLocalModel(t.model);
  const cost = estimateCost(t.model, t.tokensIn, t.tokensOut);
  const action = actionReason(t);
  const { tone } = traceOutcomeLabel(action.outcome, action.reason);
  const sources = [...t.sources].sort((a, b) => a.rank - b.rank);

  return (
    <div className="space-y-5 px-5 py-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <Fact label="Ran">
          <span title={new Date(t.createdAt).toLocaleString()}>{relativeTime(t.createdAt)}</span>
        </Fact>
        <Fact label="Model">
          <span title={t.model}>{shortModel(t.model)}</span>
        </Fact>
        <Fact label="Tokens">
          {t.tokensIn == null && t.tokensOut == null ? "—" : `${compactNum(t.tokensIn ?? 0)} in · ${compactNum(t.tokensOut ?? 0)} out`}
        </Fact>
        <Fact label="Latency">{fmtMs(t.latencyMs)}</Fact>
        <Fact label="Est. cost">
          <span title="estimated from public list prices">{local ? "$0 · local" : cost != null ? `~${fmtCost(cost)}` : "~$?"}</span>
        </Fact>
        {t.confidence != null && <Fact label="Confidence">{fmtScore(t.confidence)}</Fact>}
        {t.humanOutcome && <Fact label="Agent verdict">{HUMAN_OUTCOMES[t.humanOutcome] ?? t.humanOutcome}</Fact>}
        {t.riskTags.length > 0 && <Fact label="Risk tags">{t.riskTags.join(", ")}</Fact>}
      </dl>

      <Section title="Customer wrote">
        <p className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 px-3 py-2 text-sm text-foreground">
          {t.query || <span className="text-muted-foreground">(empty)</span>}
        </p>
      </Section>

      {t.searchQuery && (
        <Section title="Searched the docs as">
          <p className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 px-3 py-2 text-sm text-foreground">{t.searchQuery}</p>
        </Section>
      )}

      <Section title="Model's raw output">
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
          {t.draft ? highlightTags(t.draft) : <span className="text-muted-foreground">(empty)</span>}
        </pre>
      </Section>

      <Section title="What Noola did">
        <p className={cn("flex items-start gap-1.5 text-sm", tone === "held" ? "text-warning" : tone === "sent" ? "text-success" : "text-muted-foreground")}>
          {tone === "held" ? <ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> : <Bot className="mt-0.5 size-3.5 shrink-0" />}
          <span className="text-foreground">{describeAction(t)}</span>
        </p>
        {t.parsed.kind === "ok" && t.parsed.reply && (
          <ParsedBlock label="Reply">{t.parsed.reply}</ParsedBlock>
        )}
        {t.parsed.kind === "ok" && t.parsed.note && (
          <ParsedBlock label="Note for the team">{t.parsed.note}</ParsedBlock>
        )}
        {t.decisions.length > 0 && (
          <div className="space-y-1 pt-1 font-mono text-micro">
            {t.decisions.map((d, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                <span className="text-foreground">{traceOutcomeLabel(d.outcome, d.reason).label}</span>
                <span>· {DECISION_SOURCES[d.source] ?? d.source}</span>
                <span title={new Date(d.createdAt).toLocaleString()}>· {relativeTime(d.createdAt)}</span>
                {d.sentMessageId && (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    · sent message <CopyId value={d.sentMessageId} />
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Sources">
        {sources.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sources were retrieved.</p>
        ) : (
          <SourceList sources={sources} />
        )}
      </Section>

      <div className="flex items-center gap-2 border-t pt-3 font-mono text-micro text-muted-foreground">
        <span>trace</span>
        <CopyId value={t.id} />
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-foreground">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function ParsedBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-micro font-medium text-muted-foreground">{label}</div>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground">{children}</p>
    </div>
  );
}
