import { Fragment, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { BroadcastChannel, BroadcastChatPreview } from "@/lib/broadcasts";
import { cn } from "@/lib/utils";

// Chat apps render **bold** and autolink URLs — so a degraded broadcast (image → "alt: url",
// button → "**label**: url", via the send-path mdFromBlocks) shows as bold text + a tappable
// link, NOT raw asterisks. This lightweight renderer mirrors that so the bubble is faithful to
// "as delivered", not a raw-markdown dump. Bold spans and bare URLs only — the derivation emits
// nothing richer.
const URL_RE = /(https?:\/\/[^\s]+)/g;

function linkify(text: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    URL_RE.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 break-all">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function renderChatText(text: string): ReactNode[] {
  // Split on **bold** spans, keeping the captured group; odd indices are the bold content.
  return text.split(/\*\*(.+?)\*\*/g).map((chunk, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold">{linkify(chunk)}</strong>
    ) : (
      <Fragment key={i}>{linkify(chunk)}</Fragment>
    ),
  );
}

/**
 * Chat-channel preview — the non-email sibling of EmailPreview: a chat-bubble
 * mock of what a recipient's app shows (the driver's `plain` form), captioned
 * with the channel, plus a collapsed raw-markup view of the channel's actual
 * wire format (Slack mrkdwn, Telegram HTML, …). The server owns the transforms
 * (preview-render's `chat`); this component only frames what came back.
 */
export function ChatPreview({
  chat,
  channel,
  channelLabel,
  refreshing = false,
  failed = false,
  className,
}: {
  /** The per-channel forms from preview-render; null = nothing rendered yet. */
  chat: BroadcastChatPreview | null;
  /** The chosen delivery channel — picks the raw form and names the caption. */
  channel: Exclude<BroadcastChannel, "email">;
  /** Display name for the caption ("as delivered to Slack"). */
  channelLabel: string;
  /** A newer render is in flight — the stale bubble dims instead of flashing empty. */
  refreshing?: boolean;
  /** The last render attempt failed (kept quiet while a stale render still shows). */
  failed?: boolean;
  className?: string;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const plain = chat?.plain ?? "";
  const raw = chat?.[channel] ?? "";

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <span className="text-xs font-medium text-muted-foreground">Preview</span>
        {refreshing && (
          <Loader2 className="size-3 animate-spin text-muted-foreground/60 motion-reduce:animate-none" />
        )}
        {failed && chat != null && (
          <span className="text-xs text-muted-foreground">Couldn't refresh the preview.</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 pt-1">
        {chat == null && failed ? (
          <div className="grid h-40 place-items-center rounded-xl border border-dashed">
            <p className="max-w-xs px-6 text-center text-sm text-muted-foreground">
              The preview couldn't be rendered. Adjust the content or check your connection to try
              again.
            </p>
          </div>
        ) : chat == null ? (
          <div className="h-40 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        ) : (
          <>
            {/* the bubble mock — sender-side (left) with the app-agnostic shape */}
            <div
              className={cn(
                "w-fit max-w-[85%] rounded-2xl rounded-tl-sm border bg-card px-3.5 py-2.5 shadow-sm transition-opacity duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
                refreshing ? "opacity-60" : "opacity-100",
              )}
            >
              {plain.trim() ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{renderChatText(plain)}</p>
              ) : (
                <p className="text-sm text-muted-foreground">Write a message to preview it.</p>
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">as delivered to {channelLabel}</p>

            {/* the wire format, collapsed — what the driver actually sends */}
            <button
              type="button"
              aria-expanded={showRaw}
              onClick={() => setShowRaw((v) => !v)}
              className="mt-3 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showRaw ? "Hide raw markup" : "View raw markup"}
            </button>
            {showRaw && (
              <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
                {raw.trim() || "(empty)"}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
