import { Fragment, useEffect, useState, type ReactNode } from "react";
import { StickyNote, Bot, Sparkles, Languages, Paperclip, Download, ImageIcon, UserRound } from "lucide-react";
import {
  type Message,
  type MessageMeta,
  type Attachment,
  relativeTime,
  initials,
  downloadAttachment,
  fetchAttachmentBlob,
  formatBytes,
} from "@/lib/tickets";
import { type Note } from "@/lib/notes";
import { ChannelIcon } from "@/components/inbox/badges";
import { ArticleBody } from "@/components/editor/article-body";
import { Avatar } from "@/components/ui/avatar";
import { avatarSrc } from "@/lib/avatar-upload";
import { localeName } from "@/lib/settings";
import { HoverPopover } from "@/components/live/hover-popover";
import { NerdStats, CopyId, compactNum, fmtMs, fmtScore, fmtTokens, type StatRow } from "@/components/live/nerd-stats";
import { estimateCost, fmtCost, isLocalModel, shortModel } from "@/lib/model-cost";
import { cn } from "@/lib/utils";

// The thread's message-rendering family: customer/agent bubbles (with auto-translation display),
// internal notes, and the AI-answer receipt + its nerd-mode instrument breakdown. Extracted from
// thread-pane so the pane owns scroll/lifecycle and this file owns how a single entry renders.

/** Internal note in the thread — agent-only, visually distinct from customer/agent
 *  messages (never dispatched to a channel). Full-width, warning-tinted card. */
export function NoteBubble({ note }: { note: Note }) {
  return (
    <li>
      <div className="rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-2.5">
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-micro font-medium uppercase tracking-wide text-warning">
          <StickyNote className="size-3.5" /> Internal note
          {note.author_name && (
            <span className="font-normal normal-case text-muted-foreground">· {note.author_name}</span>
          )}
          <span className="font-normal normal-case text-muted-foreground">
            · {relativeTime(note.created_at)}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">{note.body}</p>
        {note.mentioned_names.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-micro text-muted-foreground">
            <span>Looped in:</span>
            {note.mentioned_names.map((n) => (
              <span key={n} className="rounded-full bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                @{n}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/** A single customer/agent message bubble. Renders the agent-facing text (with the auto-translation
 *  "translated from X" badge + show-original toggle when a translation is present) and, for AI/auto
 *  messages, the AiReceipt. */
// Agent-side replies are authored markdown (composer, macros, AI drafts) — render
// them as real structure at chat scale. Customer text stays verbatim pre-wrap.
const BUBBLE_MD =
  "text-sm leading-relaxed [&_p]:mb-2 [&_p]:leading-relaxed [&_p:last-child]:mb-0 " +
  "[&_ol]:mb-2 [&_ul]:mb-2 [&_ol:last-child]:mb-0 [&_ul:last-child]:mb-0 " +
  "[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold";

export function MessageBubble({
  message,
  showChannel = false,
  contactName = null,
  contactAvatarUrl = null,
}: {
  message: Message;
  showChannel?: boolean;
  /** The conversation's canonical contact — customer bubbles carry this identity. */
  contactName?: string | null;
  contactAvatarUrl?: string | null;
}) {
  const isAgent = message.author_type === "agent";
  // AI receipt shows only for genuine AI/autoreply messages — a translation-only meta must not
  // trigger it (it has no model/cost fields). Autoreply always stamps a `kind`.
  const isAi = message.meta?.kind != null || message.auto === true;
  const isCommunity = message.author_kind === "community";
  // Customer identity: the ticket's OWN contact renders with the CANONICAL name + avatar (the same the
  // ticket row and contact page use), so a Discord-MERGED contact looks identical everywhere — not
  // "PA" on green here and "PB" on purple there (initials + color are hashed off the name string, so a
  // divergent name = a different-looking person). A DISTINCT community participant keeps its own
  // per-message author, so a multi-poster thread still shows different people.
  const useCanonicalContact = !isCommunity && !!contactName;
  const authorName = useCanonicalContact ? contactName : message.author_name || contactName;
  const customerAvatarUrl = useCanonicalContact ? contactAvatarUrl : message.author_avatar_url;

  // Auto-translation: `body` is always the verbatim stored text; `translation.text` is its
  // other-language counterpart. `agentFacing` picks which the agent reads by default. The toggle
  // swaps between them; the badge names the source language.
  const tr = message.meta?.translation ?? null;
  const [showOriginal, setShowOriginal] = useState(false);
  const shownText = tr ? (tr.agentFacing === "text" ? (showOriginal ? message.body : tr.text) : (showOriginal ? tr.text : message.body)) : message.body;
  const badge = tr
    ? tr.agentFacing === "text"
      ? `Translated from ${localeName(tr.from)}`
      : `Sent in ${localeName(tr.to)}`
    : null;

  // Attachments: images render inline as thumbnails; everything else keeps the quiet file chip.
  const atts = message.attachments ?? [];
  const imageAtts = atts.filter(isImageAttachment);
  const fileAtts = atts.filter((a) => !isImageAttachment(a));

  return (
    <li className={cn("flex gap-3", isAgent && "flex-row-reverse")}>
      {isAgent ? (
        message.author_avatar_url ? (
          <Avatar
            name={message.author_name || "Agent"}
            image={avatarSrc(message.author_avatar_url)}
            className="mt-0.5 size-7 shrink-0 text-micro"
          />
        ) : (
          <span
            className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-micro font-semibold text-primary"
            aria-hidden
          >
            {initials(message.author_name || "Agent")}
          </span>
        )
      ) : authorName || customerAvatarUrl ? (
        <Avatar name={authorName || "Customer"} image={avatarSrc(customerAvatarUrl)} className="mt-0.5 size-7 shrink-0 text-micro" />
      ) : (
        <span
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground/60"
          aria-hidden
        >
          <UserRound className="size-3.5" />
        </span>
      )}
      <div className={cn("flex min-w-0 max-w-[82%] flex-col gap-1", isAgent && "items-end")}>
        <div
          className={cn(
            "break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
            isAgent
              ? "rounded-tr-md bg-accent text-foreground"
              : "whitespace-pre-wrap rounded-tl-md bg-muted/60 text-foreground",
          )}
        >
          {isAgent ? <ArticleBody markdown={shownText} className={BUBBLE_MD} /> : shownText}
        </div>
        {/* one quiet meta line UNDER the bubble — time, plus the Auto marker for
            AI-sent replies and a channel glyph only when the conversation spans
            channels (the omnichannel case is Noola's own thing worth marking) */}
        <div
          className={cn(
            "flex items-center gap-1.5 px-1 text-micro text-muted-foreground/80",
            isAgent && "flex-row-reverse",
          )}
        >
          <span>{relativeTime(message.created_at)}</span>
          {message.auto && (
            <span
              className="inline-flex items-center gap-0.5 font-medium text-primary"
              title="Sent automatically by the AI"
            >
              <Bot className="size-3" /> Auto
            </span>
          )}
          {isCommunity && (
            <span
              className="inline-flex items-center gap-0.5 font-medium text-primary"
              title="Answered by a community responder in Discord"
            >
              Community
            </span>
          )}
          {showChannel && message.channel_type && <ChannelIcon channel={message.channel_type} className="size-3" />}
        </div>
        {tr && (
          <div className={cn("flex items-center gap-1.5 text-micro text-muted-foreground", isAgent && "flex-row-reverse")}>
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-1.5 py-0.5 font-medium text-primary">
              <Languages className="size-2.5" />
              {badge}
            </span>
            <button
              type="button"
              onClick={() => setShowOriginal((v) => !v)}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              {showOriginal ? "Show translation" : "Show original"}
            </button>
          </div>
        )}
        {imageAtts.length > 0 && (
          <div className={cn("flex flex-wrap gap-2", isAgent && "justify-end")}>
            {imageAtts.map((a) => (
              <AttachmentImage key={a.id} a={a} capped={imageAtts.length > 1} />
            ))}
          </div>
        )}
        {fileAtts.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", isAgent && "justify-end")}>
            {fileAtts.map((a) => (
              <AttachmentChip key={a.id} a={a} />
            ))}
          </div>
        )}
        {isAi && <AiReceipt message={message} align={isAgent ? "end" : "start"} />}
      </div>
    </li>
  );
}

// Image attachments render inline. SVG is deliberately EXCLUDED: the serve route forces
// content-disposition: attachment precisely so uploaded SVG/HTML can't execute in-origin,
// and opening a same-origin blob: SVG document in a new tab would reopen that hole.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
function isImageAttachment(a: Attachment): boolean {
  const ct = a.content_type.toLowerCase();
  if (ct === "image/svg+xml") return false;
  if (ct.startsWith("image/")) return true;
  // No usable mime (older rows / generic uploads) — sniff the extension.
  if (!ct || ct === "application/octet-stream") return IMAGE_EXT.test(a.filename);
  return false;
}

/** An image attachment shown inline under the bubble. The serve route is Bearer-authed
 *  (and downloads-only), so a plain <img src> can't reach it — fetch the bytes with the
 *  token and display via an object URL, revoked on unmount. Click opens full size in a
 *  new tab; any failure falls back to the downloadable chip. */
function AttachmentImage({ a, capped }: { a: Attachment; capped: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let obj: string | null = null;
    fetchAttachmentBlob(a.id)
      .then((blob) => {
        if (cancelled) return;
        obj = URL.createObjectURL(blob);
        setUrl(obj);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [a.id]);

  if (failed) return <AttachmentChip a={a} />;
  if (!url)
    return (
      <div
        className={cn(
          "rounded-lg border border-border/60 bg-muted/40 motion-safe:animate-pulse",
          capped ? "h-32 w-40" : "h-40 w-56",
        )}
        title={a.filename}
        aria-hidden
      />
    );
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`${a.filename} · ${formatBytes(a.size_bytes)} — open full size`}
      className="block max-w-full overflow-hidden rounded-lg border border-border/60"
    >
      <img
        src={url}
        alt={a.filename}
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn("block max-w-full object-contain", capped ? "max-h-48" : "max-h-72")}
      />
    </a>
  );
}

/** A downloadable attachment chip under a message. The serve route is authed, so a click fetches the
 *  bytes with the Bearer and triggers a browser download (no navigable href). */
function AttachmentChip({ a }: { a: Attachment }) {
  const [busy, setBusy] = useState(false);
  const isImage = a.content_type.startsWith("image/");
  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      await downloadAttachment(a.id, a.filename);
    } catch {
      /* swallow — the chip stays; the agent can retry */
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={`Download ${a.filename}`}
      className="group inline-flex max-w-[15rem] items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-accent disabled:opacity-60"
    >
      {isImage ? <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="truncate font-medium">{a.filename}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(a.size_bytes)}</span>
      <Download className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

/**
 * The AI-answer receipt — a compact, always-visible "what did that cost" line
 * under an AI/auto message: model · Δtok in→out · ~$cost · N sources · latency.
 * Reads secondary + monospace so it never competes with the reply itself. In
 * nerd mode it expands into the full instrument breakdown (confidence, agreement,
 * cited kinds, trace id). Every field is optional — degrade gracefully.
 */
function AiReceipt({ message, align }: { message: Message; align: "start" | "end" }) {
  const meta = message.meta ?? null;

  const model = meta?.model ?? null;
  const tokensIn = meta?.tokensIn ?? null;
  const tokensOut = meta?.tokensOut ?? null;
  const hasTokens = tokensIn != null || tokensOut != null;
  const cost = estimateCost(model, tokensIn, tokensOut);
  const local = isLocalModel(model);
  const sources = meta?.sources ?? null;
  const latency = meta?.latencyMs ?? null;

  // Compact chips — only the ones we actually have data for.
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
        <span className="text-muted-foreground/75">→</span>
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

  const line = (
    <>
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
        <span className="text-muted-foreground">auto reply</span>
      )}
      <span className="text-muted-foreground/40">· est.</span>
    </>
  );

  // Subtle inline receipt; the full instrument breakdown pops on hover/focus in
  // a floating card — never a block shoved into the middle of the conversation.
  return (
    <div className={cn("flex w-full", align === "end" ? "justify-end" : "justify-start")}>
      <HoverPopover
        align={align}
        triggerClassName={cn(
          "flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-micro leading-none tabular-nums text-muted-foreground transition-colors hover:text-foreground/70",
          align === "end" ? "justify-end" : "justify-start",
        )}
        content={
          meta ? (
            <div className="rounded-xl bg-popover/95 p-px shadow-2xl shadow-black/40 ring-1 ring-border/60 backdrop-blur-sm">
              <AiReceiptStats meta={meta} cost={cost} local={local} />
            </div>
          ) : null
        }
      >
        {line}
      </HoverPopover>
    </div>
  );
}

/** Nerd expansion of the AI-answer receipt: the full instrument breakdown. */
function AiReceiptStats({
  meta,
  cost,
  local,
}: {
  meta: MessageMeta;
  cost: number | null;
  local: boolean;
}) {
  const rows: StatRow[] = [];
  rows.push({ label: "model", value: meta.model, title: meta.model });
  if (meta.confidence != null) rows.push({ label: "confidence", value: fmtScore(meta.confidence) });
  rows.push({
    label: "agreement",
    value: meta.sources ? `${meta.agreement}/${meta.sources}` : `${meta.agreement}`,
  });
  if (meta.tokensIn != null || meta.tokensOut != null)
    rows.push({
      label: "tokens",
      value: `${fmtTokens(meta.tokensIn)} in · ${fmtTokens(meta.tokensOut)} out`,
    });
  rows.push({
    label: "est. cost",
    value: local ? "$0 · local" : cost != null ? `~${fmtCost(cost)}` : "~$?",
    title: "estimated from public list prices",
  });
  if (meta.latencyMs != null) rows.push({ label: "latency", value: fmtMs(meta.latencyMs) });
  rows.push({ label: "sources", value: `${meta.sources}` });

  return (
    <NerdStats title="ai answer" rows={rows} className="w-full max-w-sm">
      {(meta.citedKinds?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          <span className="text-muted-foreground">kinds</span>
          {(meta.citedKinds ?? []).map((k) => (
            <span
              key={k}
              className="rounded border border-border px-1 py-px text-micro text-muted-foreground"
            >
              {k}
            </span>
          ))}
        </div>
      )}
      {meta.traceId && (
        <div className="flex items-center justify-between gap-2 pt-1 text-muted-foreground">
          <span>trace</span>
          <CopyId value={meta.traceId} className="text-muted-foreground" />
        </div>
      )}
    </NerdStats>
  );
}
