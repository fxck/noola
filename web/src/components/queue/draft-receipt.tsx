import { Fragment, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { MessageMeta } from "@/lib/tickets";
import { compactNum, fmtMs } from "@/components/live/nerd-stats";
import { estimateCost, fmtCost, isLocalModel, shortModel } from "@/lib/model-cost";
import { cn } from "@/lib/utils";

/**
 * The compact "what did that cost" receipt for a queued draft — the same look as
 * the in-thread AiReceipt: model · tok in→out · ~cost · N sources · latency, in
 * muted monospace. Every field is optional; degrade gracefully when meta is null.
 */
export function DraftReceipt({ meta, className }: { meta: MessageMeta | null; className?: string }) {
  const model = meta?.model ?? null;
  const tokensIn = meta?.tokensIn ?? null;
  const tokensOut = meta?.tokensOut ?? null;
  const hasTokens = tokensIn != null || tokensOut != null;
  const cost = estimateCost(model, tokensIn, tokensOut);
  const local = isLocalModel(model);
  const sources = meta?.sources ?? null;
  const latency = meta?.latencyMs ?? null;

  const chips: ReactNode[] = [];
  if (model)
    chips.push(
      <span key="model" title={model} className="max-w-[11rem] truncate text-foreground/70">
        {shortModel(model)}
      </span>,
    );
  if (hasTokens)
    chips.push(
      <span key="tok" title="tokens in → out (est.)">
        {compactNum(tokensIn ?? 0)}
        <span className="text-muted-foreground/50">→</span>
        {compactNum(tokensOut ?? 0)} tok
      </span>,
    );
  if (local) chips.push(<span key="cost" title="deterministic baseline — runs locally">$0 · local</span>);
  else if (cost != null)
    chips.push(
      <span key="cost" title="estimated cost (public list prices)">
        ~{fmtCost(cost)}
      </span>,
    );
  else if (hasTokens)
    chips.push(
      <span key="cost" title="unknown model — cost not estimated">
        ~$?
      </span>,
    );
  if (sources != null)
    chips.push(
      <span key="src">
        {sources} {sources === 1 ? "source" : "sources"}
      </span>,
    );
  if (latency != null) chips.push(<span key="lat">{fmtMs(latency)}</span>);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-micro leading-none tabular-nums text-muted-foreground",
        className,
      )}
      title="AI draft — an estimated receipt for the model's work"
    >
      <Sparkles className="size-2.5 shrink-0 text-primary/60" aria-hidden />
      {chips.length > 0 ? (
        chips.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
            )}
            {c}
          </Fragment>
        ))
      ) : (
        <span className="text-muted-foreground/70">draft</span>
      )}
      <span className="text-muted-foreground/40">· est.</span>
    </div>
  );
}

/** The reason a draft is waiting, as a small tone-coded chip. */
export function ReasonChip({ reason }: { reason: string }) {
  const weak = reason === "weak_retrieval";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-medium leading-none",
        weak
          ? "border-warning/25 bg-warning/10 text-warning"
          : "border-primary/25 bg-primary/10 text-primary",
      )}
      title={
        weak
          ? "Wanted to auto-send, but retrieval didn't corroborate the answer — held for a human."
          : "Suggest-only mode: a grounded draft prepared for an agent to review."
      }
    >
      {weak ? "Held · low corroboration" : "Suggested"}
    </span>
  );
}
