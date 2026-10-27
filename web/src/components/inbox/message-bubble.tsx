import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  StickyNote, Bot, Sparkles, Languages, Paperclip, Download, ImageIcon, UserRound, Check, CheckCheck, Eye, TriangleAlert, Clock,
  MoreHorizontal, SendHorizonal, Pencil, Trash2,
} from "lucide-react";
import {
  type Message,
  type MessageMeta,
  type Attachment,
  type ScheduledReply,
  relativeTime,
  initials,
  downloadAttachment,
  fetchAttachmentBlob,
  formatBytes,
} from "@/lib/tickets";
import { type Note } from "@/lib/notes";
import { ChannelIcon } from "@/components/inbox/badges";
import { ArticleBody } from "@/components/editor/article-body";
import { slackToMarkdown, splitLinks } from "@/lib/markdown";
import { usePreferences } from "@/lib/preferences";
import { NoolaMark } from "@/components/noola-mark";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { avatarSrc } from "@/lib/avatar-upload";
import { formatDelay, localeName } from "@/lib/settings";
import { HoverPopover } from "@/components/live/hover-popover";
import { NerdStats, CopyId, compactNum, fmtMs, fmtScore, fmtTokens, type StatRow } from "@/components/live/nerd-stats";
import { estimateCost, fmtCost, isLocalModel, shortModel } from "@/lib/model-cost";
import { ImageLightbox } from "@/components/inbox/image-lightbox";
import { OriginalEmailDialog } from "@/components/inbox/original-email-dialog";
import { TraceDialog } from "@/components/inbox/trace-dialog";
import { useAuth } from "@/auth/auth";
import { cn } from "@/lib/utils";

// The thread's message-rendering family: customer/agent bubbles (with auto-translation display),
// internal notes, and the AI-answer receipt + its nerd-mode instrument breakdown. Extracted from
// thread-pane so the pane owns scroll/lifecycle and this file owns how a single entry renders.

/** Email delivery badge for an agent reply (0114): send-confidence beyond the "Seen" pixel —
 *  Sent → Delivered → Opened, or a Bounced / Marked-spam / Failed state. Renders only when a delivery
 *  head exists (email replies, including a widget reply that fell back to email). */
function DeliveryBadge({
  status,
  bounceKind,
  openedAt,
  viaEmailFallback,
  channel,
}: {
  status: string;
  bounceKind?: string | null;
  openedAt?: string | null;
  viaEmailFallback?: boolean;
  channel?: string | null;
}) {
  const via = viaEmailFallback ? " · by e-mail" : "";
  const discord = channel === "discord";
  let icon: ReactNode;
  let label: string;
  let title: string;
  let tone = "text-muted-foreground/80";
  if (status === "complained") {
    icon = <TriangleAlert className="size-3" />;
    label = "Marked spam";
    title = "The recipient marked this e-mail as spam";
    tone = "text-destructive";
  } else if (status === "bounced") {
    icon = <TriangleAlert className="size-3" />;
    label = "Bounced";
    title = `E-mail bounced${bounceKind ? ` (${bounceKind})` : ""} — it did not reach the recipient`;
    tone = "text-destructive";
  } else if (status === "failed") {
    icon = <TriangleAlert className="size-3" />;
    label = "Failed to send";
    title = discord ? "Discord didn't accept this message after repeated retries" : "The e-mail could not be handed off to the provider";
    tone = "text-destructive";
  } else if (status === "pending") {
    icon = <Clock className="size-3" />;
    label = "Sending…";
    title = "Queued for Discord - retrying until it's delivered";
  } else if (openedAt) {
    icon = <Eye className="size-3" />;
    label = "Opened";
    title = `Recipient opened the e-mail${via}`;
  } else if (status === "delivered") {
    icon = <CheckCheck className="size-3" />;
    label = "Delivered";
    title = `Delivered to the recipient's mail server${via}`;
  } else if (status === "sent") {
    icon = <Check className="size-3" />;
    label = "Sent";
    title = discord ? "Delivered to Discord" : `Handed off to the e-mail provider${via}`;
  } else {
    return null;
  }
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-medium", tone)} title={title}>
      {icon} {label}
    </span>
  );
}

/** Internal note in the thread — agent-only, visually distinct from customer/agent
 *  messages (never dispatched to a channel). Full-width, warning-tinted card. */
export function NoteBubble({
  note,
  canEdit,
  canDelete,
  sendDelay,
  onSend,
  onEdit,
  onDelete,
}: {
  note: Note;
  canEdit: boolean;
  canDelete: boolean;
  /** The workspace's send delay in seconds. */
  sendDelay: number;
  /** Absent when the ticket can't take a reply, e.g. while it is closed or marked spam. */
  onSend?: (sendNow: boolean) => Promise<void>;
  /** Resolves true when the new text is saved. */
  onEdit: (body: string) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) {
  // Notes can carry files too (e.g. a screenshot posted in a Discord mirror thread) — same inline
  // image / file-chip treatment as a message.
  const atts = note.attachments ?? [];
  const { linkPreviews, sendMode } = usePreferences();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const embedAtts = atts.filter((a) => a.embed_url);
  const imageAtts = atts.filter((a) => !a.embed_url && isImageAttachment(a));
  const fileAtts = atts.filter((a) => !a.embed_url && !isImageAttachment(a));
  const hideBody = linkPreviews && onlyPreviewedLinks(note.body, embedAtts);
  const canSend = !!onSend && !note.sending;
  const delayLabel = formatDelay(sendDelay);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    setDraft(note.body);
    setEditing(true);
  }

  function saveEdit() {
    const body = draft.trim();
    if (!body || busy) return;
    if (body === note.body) {
      setEditing(false);
      return;
    }
    void run(async () => {
      if (await onEdit(body)) setEditing(false);
    });
  }

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
          {note.edited_at && (
            <span className="font-normal normal-case text-muted-foreground" title={new Date(note.edited_at).toLocaleString()}>
              · edited
            </span>
          )}
          {note.sending && (
            <span className="inline-flex items-center gap-1 font-normal normal-case text-muted-foreground">
              · <Clock className="size-3" /> Sending…
            </span>
          )}
          {!editing && (canSend || canEdit || canDelete) && (
            <div className="-my-1 ml-auto">
              <Menu
                width={208}
                trigger={(open, toggle) => (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-6 text-muted-foreground hover:text-foreground [&_svg]:size-3.5", open && "bg-muted text-foreground")}
                    onClick={toggle}
                    disabled={busy}
                    title="Note actions"
                    aria-label="Note actions"
                    aria-haspopup="menu"
                    aria-expanded={open}
                  >
                    <MoreHorizontal />
                  </Button>
                )}
              >
                {canSend && (
                  <MenuItem
                    icon={SendHorizonal}
                    label={sendDelay > 0 && sendMode === "delayed" ? `Send to customer in ${delayLabel}` : "Send to customer"}
                    onSelect={() => void run(() => onSend!(sendMode === "now"))}
                  />
                )}
                {canSend && sendDelay > 0 && (
                  sendMode === "now" ? (
                    <MenuItem icon={Clock} label={`Send in ${delayLabel}`} onSelect={() => void run(() => onSend!(false))} />
                  ) : (
                    <MenuItem icon={SendHorizonal} label="Send now" onSelect={() => void run(() => onSend!(true))} />
                  )
                )}
                {canSend && (canEdit || canDelete) && <MenuSeparator />}
                {canEdit && <MenuItem icon={Pencil} label="Edit" onSelect={startEdit} />}
                {canDelete && <MenuItem icon={Trash2} label="Delete" destructive onSelect={() => setConfirmDelete(true)} />}
              </Menu>
            </div>
          )}
        </div>
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              autoFocus
              autoGrow
              aria-label="Edit note"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  saveEdit();
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              disabled={busy}
              className="bg-background"
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={saveEdit} disabled={busy || !draft.trim()}>
                {busy && <Spinner className="size-4 text-background" />}
                Save
              </Button>
            </div>
          </div>
        ) : (
          !hideBody && <ArticleBody markdown={note.body} className={cn(BUBBLE_MD, "break-words")} messageLinks />
        )}
        {embedAtts.length > 0 && <LinkPreviews atts={embedAtts} className="mt-2" />}
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
        {imageAtts.length > 0 && <ImageAttachments atts={imageAtts} className="mt-2" />}
        {fileAtts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {fileAtts.map((a) => (
              <AttachmentChip key={a.id} a={a} />
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this note?"
        message={
          note.origin === "discord"
            ? "The message in the Discord thread is deleted too. This can't be undone."
            : "This can't be undone."
        }
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() =>
          void run(async () => {
            await onDelete();
            setConfirmDelete(false);
          })
        }
        onCancel={() => setConfirmDelete(false)}
      />
    </li>
  );
}

// Markdown bodies (notes, agent replies, Discord and Slack messages) at chat scale.
const BUBBLE_MD =
  "text-sm leading-relaxed [&_p]:mb-2 [&_p]:leading-relaxed [&_p:last-child]:mb-0 " +
  "[&_ol]:mb-2 [&_ul]:mb-2 [&_ol:last-child]:mb-0 [&_ul:last-child]:mb-0 " +
  "[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold";

/** A message body as its channel writes it: markdown for agents, Discord and Slack, plain text otherwise. Links are clickable in both. */
function MessageText({ text, isAgent, channel }: { text: string; isAgent: boolean; channel?: string | null }) {
  if (isAgent || channel === "discord") return <ArticleBody markdown={text} className={BUBBLE_MD} messageLinks />;
  if (channel === "slack") return <ArticleBody markdown={slackToMarkdown(text)} className={BUBBLE_MD} messageLinks />;
  return (
    <span className="whitespace-pre-wrap">
      {splitLinks(text).map((p, i) =>
        p.url ? (
          <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </span>
  );
}

/** A single customer/agent message bubble. Renders the agent-facing text (with the auto-translation
 *  "translated from X" badge + show-original toggle when a translation is present) and, for AI/auto
 *  messages, the AiReceipt. */
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
  // divergent name = a different-looking person). But a message from a DIFFERENT person — a community
  // member who joined a Discord/forum thread — carries its own per-message `author_name`; those must
  // keep their own identity. They aren't always tagged `author_kind==="community"` (non-OP forum
  // repliers arrive as plain customers), so canonicalizing on `!isCommunity` alone collapsed every
  // thread reply onto the OP. Gate on the per-message author actually MATCHING the ticket contact:
  // only then is it safe to swap in the canonical identity.
  const distinctAuthor = !!message.author_name && message.author_name !== contactName;
  const useCanonicalContact = !isCommunity && !!contactName && !distinctAuthor;
  const authorName = useCanonicalContact ? contactName : message.author_name || contactName;
  const customerAvatarUrl = useCanonicalContact ? contactAvatarUrl : message.author_avatar_url;

  // Auto-translation: `body` is always the verbatim stored text; `translation.text` is its
  // other-language counterpart. `agentFacing` picks which the agent reads by default. The toggle
  // swaps between them; the badge names the source language.
  const tr = message.meta?.translation ?? null;
  const [showOriginal, setShowOriginal] = useState(false);
  // "View original" dialog: the untouched inbound email (raw HTML/quote/headers), lazy-fetched.
  const [showOriginalEmail, setShowOriginalEmail] = useState(false);
  const shownText = tr ? (tr.agentFacing === "text" ? (showOriginal ? message.body : tr.text) : (showOriginal ? tr.text : message.body)) : message.body;
  const badge = tr
    ? tr.agentFacing === "text"
      ? `Translated from ${localeName(tr.from)}`
      : `Sent in ${localeName(tr.to)}`
    : null;

  // Attachments: images render inline as thumbnails; everything else keeps the quiet file chip.
  const atts = message.attachments ?? [];
  const { linkPreviews } = usePreferences();
  const embedAtts = atts.filter((a) => a.embed_url);
  const imageAtts = atts.filter((a) => !a.embed_url && isImageAttachment(a));
  const fileAtts = atts.filter((a) => !a.embed_url && !isImageAttachment(a));
  const hideBody = linkPreviews && onlyPreviewedLinks(shownText, embedAtts);

  return (
    <li className={cn("flex gap-3", isAgent && "flex-row-reverse")}>
      {isAgent ? (
        isAi ? (
          // AI answers wear the Noola mark — the same brand avatar the widget shows for the
          // assistant — not agent initials ("AG").
          <span
            className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted"
            aria-hidden
          >
            <NoolaMark className="size-5" />
          </span>
        ) : message.author_avatar_url ? (
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
        {!hideBody && (
          <div
            className={cn(
              "break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
              isAgent
                ? "rounded-tr-md bg-accent text-foreground"
                : "rounded-tl-md bg-muted/60 text-foreground",
            )}
          >
            <MessageText text={shownText} isAgent={isAgent} channel={message.channel_type} />
          </div>
        )}
        {embedAtts.length > 0 && <LinkPreviews atts={embedAtts} className={cn(isAgent && "justify-end")} />}
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
          {!isAgent && message.meta?.to && <span title="The address this e-mail was sent to">to {message.meta.to}</span>}
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
          {isAgent && message.delivery_status && (
            <DeliveryBadge
              status={message.delivery_status}
              bounceKind={message.bounce_kind}
              openedAt={message.opened_at}
              viaEmailFallback={message.channel_type === "widget"}
              channel={message.channel_type}
            />
          )}
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
        {!isAgent && message.has_original && (
          <div className="px-1 text-micro text-muted-foreground/80">
            <button
              type="button"
              onClick={() => setShowOriginalEmail(true)}
              className="underline-offset-2 hover:text-foreground hover:underline"
              title="View the untouched e-mail as it arrived — full HTML, quoted history, and headers"
            >
              View original
            </button>
          </div>
        )}
        {showOriginalEmail && (
          <OriginalEmailDialog
            ticketId={message.ticket_id}
            messageId={message.id}
            onClose={() => setShowOriginalEmail(false)}
          />
        )}
        {imageAtts.length > 0 && <ImageAttachments atts={imageAtts} className={cn(isAgent && "justify-end")} />}
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

/** A reply that waits out the workspace's send delay, with a countdown and the controls to cancel it or send it at once. */
export function PendingReplyBubble({
  reply,
  authorAvatarUrl,
  onCancel,
  onSendNow,
}: {
  reply: ScheduledReply;
  authorAvatarUrl?: string | null;
  onCancel: () => Promise<void>;
  onSendNow: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const left = useSecondsUntil(reply.status === "scheduled" ? reply.sendAt : null);
  const sending = reply.status === "sending" || left === 0;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-row-reverse gap-3">
      {authorAvatarUrl ? (
        <Avatar
          name={reply.authorName || "Agent"}
          image={avatarSrc(authorAvatarUrl)}
          className="mt-0.5 size-7 shrink-0 text-micro opacity-60"
        />
      ) : (
        <span
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-micro font-semibold text-primary/70"
          aria-hidden
        >
          {initials(reply.authorName || "Agent")}
        </span>
      )}
      <div className="flex min-w-0 max-w-[82%] flex-col items-end gap-1">
        <div className="break-words rounded-2xl rounded-tr-md border border-dashed border-border bg-accent/40 px-3.5 py-2.5 text-sm leading-relaxed text-muted-foreground">
          <ArticleBody markdown={reply.body} className={BUBBLE_MD} messageLinks />
        </div>
        <div className="flex flex-row-reverse flex-wrap items-center gap-1.5 px-1 text-micro text-muted-foreground/80">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock className="size-3" />
            {sending ? "Sending…" : `Sending in ${countdownLabel(left)}`}
          </span>
          {reply.source === "discord_promote" && (
            <span className="rounded-full border px-1.5 py-px font-medium" title="Promoted from the Discord mirror thread">
              from Discord
            </span>
          )}
          {reply.source === "note" && (
            <span className="rounded-full border px-1.5 py-px font-medium" title="From an internal note on this ticket">
              from a note
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-micro"
            disabled={busy || reply.status === "sending"}
            onClick={() => void run(onSendNow)}
          >
            Send now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-micro text-muted-foreground"
            disabled={busy || reply.status === "sending"}
            onClick={() => void run(onCancel)}
          >
            Cancel
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Whole seconds until `iso`, re-rendered every second until it reaches 0. Null `iso` gives 0. */
function useSecondsUntil(iso: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  const left = iso ? Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000)) : 0;
  // A retry moves `sendAt`, and the clock stops ticking at 0, so a new target needs a fresh now.
  useEffect(() => setNow(Date.now()), [iso]);
  useEffect(() => {
    if (left === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [left, now]);
  return left;
}

function countdownLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** True when the text is only links whose previews are shown, as with a GIF from Discord's /gif. */
function onlyPreviewedLinks(text: string, embeds: Attachment[]): boolean {
  if (!embeds.length) return false;
  const previewed = new Set(embeds.map((a) => a.embed_url));
  return text.split(/\s+/).filter(Boolean).every((word) => previewed.has(word.replace(/^<|>$/g, "")));
}

/** GIFs and images that a message links to, or the links themselves when the member turned previews off. */
function LinkPreviews({ atts, className }: { atts: Attachment[]; className?: string }) {
  const { linkPreviews } = usePreferences();
  const images = linkPreviews ? atts.filter(isImageAttachment) : [];
  const videos = linkPreviews ? atts.filter((a) => a.content_type.startsWith("video/")) : [];
  const links = atts.filter((a) => !images.includes(a) && !videos.includes(a));
  return (
    <>
      {images.length > 0 && <ImageAttachments atts={images} className={className} />}
      {videos.length > 0 && (
        <div className={cn("flex flex-wrap gap-2", className)}>
          {videos.map((a) => (
            <PreviewVideo key={a.id} a={a} />
          ))}
        </div>
      )}
      {links.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5", className)}>
          {links.map((a) => (
            <PreviewLink key={a.id} url={a.embed_url!} />
          ))}
        </div>
      )}
    </>
  );
}

/** A GIF, which Discord serves as a short silent video, playing on a loop like it does in Discord. */
function PreviewVideo({ a }: { a: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchAttachmentBlob(a.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [a.id]);
  if (failed) return <PreviewLink url={a.embed_url!} />;
  if (!url) return <div className="h-40 w-56 rounded-lg border border-border/60 bg-muted/40 motion-safe:animate-pulse" aria-hidden />;
  return (
    <video
      src={url}
      autoPlay
      loop
      muted
      playsInline
      title={a.embed_url ?? a.filename}
      onError={() => setFailed(true)}
      className="block max-h-72 max-w-full rounded-lg border border-border/60"
    />
  );
}

function PreviewLink({ url }: { url: string }) {
  if (!/^https?:\/\//i.test(url)) return <span className="text-micro text-muted-foreground">{url}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 truncate rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-micro text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {url}
    </a>
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

/** The inline image grid for a bubble/note, plus the lightbox it opens into. Owns the ONE
 *  id→objectURL cache the thumbnails and the full-size viewer share, so opening an image
 *  reuses the bytes its thumbnail already fetched instead of re-hitting the authed serve
 *  route. All minted URLs are revoked here (on unmount) — the single owner, so nothing leaks. */
function ImageAttachments({ atts, className }: { atts: Attachment[]; className?: string }) {
  const urlsRef = useRef<Record<string, string>>({});
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [openAt, setOpenAt] = useState<number | null>(null);
  const capped = atts.length > 1;

  const resolveUrl = useCallback((id: string, url: string) => {
    // First writer wins — a raced second fetch's URL is revoked instead of orphaned.
    if (urlsRef.current[id]) {
      URL.revokeObjectURL(url);
      return;
    }
    urlsRef.current[id] = url;
    setUrls((prev) => ({ ...prev, [id]: url }));
  }, []);

  // A rendered message is a stable set — revoke every URL once, when the block unmounts
  // (thread scroll-recycle / navigation away).
  useEffect(
    () => () => {
      for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u);
      urlsRef.current = {};
    },
    [],
  );

  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)}>
        {atts.map((a, i) => (
          <AttachmentImage
            key={a.id}
            a={a}
            capped={capped}
            url={urls[a.id] ?? null}
            onResolveUrl={resolveUrl}
            onOpen={() => setOpenAt(i)}
          />
        ))}
      </div>
      {openAt != null && (
        <ImageLightbox
          images={atts}
          index={openAt}
          urls={urls}
          onIndexChange={setOpenAt}
          onResolveUrl={resolveUrl}
          onClose={() => setOpenAt(null)}
        />
      )}
    </>
  );
}

/** An image attachment shown inline under the bubble. The serve route is Bearer-authed
 *  (and downloads-only), so a plain <img src> can't reach it — fetch the bytes with the
 *  token and display via an object URL held in the parent's shared cache. Click opens the
 *  in-app lightbox (not a raw blob tab); any failure falls back to the downloadable chip. */
function AttachmentImage({
  a,
  capped,
  url,
  onResolveUrl,
  onOpen,
}: {
  a: Attachment;
  capped: boolean;
  url: string | null;
  onResolveUrl: (id: string, url: string) => void;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (url) return; // already in the shared cache — no refetch
    let cancelled = false;
    fetchAttachmentBlob(a.id)
      .then((blob) => {
        if (!cancelled) onResolveUrl(a.id, URL.createObjectURL(blob));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [a.id, url, onResolveUrl]);

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
    <button
      type="button"
      onClick={onOpen}
      title={`${a.filename} · ${formatBytes(a.size_bytes)} — view`}
      className="block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/60 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    >
      <img
        src={url}
        alt={a.filename}
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn("block max-w-full object-contain", capped ? "max-h-48" : "max-h-72")}
      />
    </button>
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
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const [traceOpen, setTraceOpen] = useState(false);

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
              <AiReceiptStats
                meta={meta}
                cost={cost}
                local={local}
                onViewTrace={isAdmin ? () => setTraceOpen(true) : undefined}
              />
            </div>
          ) : null
        }
      >
        {line}
      </HoverPopover>
      {traceOpen && meta?.traceId && <TraceDialog traceId={meta.traceId} onClose={() => setTraceOpen(false)} />}
    </div>
  );
}

/** Nerd expansion of the AI-answer receipt: the full instrument breakdown. */
function AiReceiptStats({
  meta,
  cost,
  local,
  onViewTrace,
}: {
  meta: MessageMeta;
  cost: number | null;
  local: boolean;
  onViewTrace?: () => void;
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
          <span className="flex min-w-0 items-center gap-2">
            <CopyId value={meta.traceId} className="min-w-0 text-muted-foreground" />
            {onViewTrace && (
              <button type="button" onClick={onViewTrace} className="shrink-0 text-primary hover:underline">
                View trace
              </button>
            )}
          </span>
        </div>
      )}
    </NerdStats>
  );
}
