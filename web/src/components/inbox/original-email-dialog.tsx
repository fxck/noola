import { useEffect, useState } from "react";
import { X, Mail } from "lucide-react";
import { fetchMessageOriginal, type OriginalEmail } from "@/lib/tickets";
import { cn } from "@/lib/utils";

// "View original" — shows the untouched inbound email exactly as it arrived (before quote-stripping):
// the raw HTML (rendered in a script-less sandboxed iframe so customer markup can't execute), or the
// plaintext, plus a collapsible technical-headers block. Lazy-fetches on open so the heavy HTML never
// rides the thread's message list. Reuses the app's `.motion-overlay` / `.motion-pop` dialog idiom.

// The curated headers we render, in reading order, with friendly labels. `authResults` is the raw
// Authentication-Results line (DKIM/SPF/DMARC verdicts) — shown verbatim for deliverability triage.
const HEADER_ROWS: { key: string; label: string }[] = [
  { key: "from", label: "From" },
  { key: "to", label: "To" },
  { key: "cc", label: "Cc" },
  { key: "replyTo", label: "Reply-To" },
  { key: "date", label: "Date" },
  { key: "subject", label: "Subject" },
  { key: "messageId", label: "Message-ID" },
  { key: "inReplyTo", label: "In-Reply-To" },
  { key: "references", label: "References" },
  { key: "returnPath", label: "Return-Path" },
  { key: "authResults", label: "Authentication" },
];

export function OriginalEmailDialog({
  ticketId,
  messageId,
  onClose,
}: {
  ticketId: string;
  messageId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<OriginalEmail | null>(null);
  const [error, setError] = useState(false);
  // Which body to show when both an HTML and a plaintext part exist. Defaults to the rich HTML.
  const [mode, setMode] = useState<"html" | "text">("html");

  useEffect(() => {
    let cancelled = false;
    fetchMessageOriginal(ticketId, messageId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setMode(d.html ? "html" : "text");
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [ticketId, messageId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const headers = data?.headers ?? null;
  const headerEntries = headers ? HEADER_ROWS.filter((r) => headers[r.key]?.trim()) : [];
  // Plaintext fallback body: the original text part, else the stripped quote (better than nothing).
  const plain = data?.text ?? data?.quoted ?? "";
  const hasHtml = !!data?.html;

  return (
    <div
      className="motion-overlay fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Original email"
      onClick={onClose}
    >
      <div
        className="motion-pop my-auto flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <Mail className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">Original email</h2>
              <p className="text-micro text-muted-foreground">The untouched message as it arrived, before quote-stripping.</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {hasHtml && plain && (
              <div className="flex overflow-hidden rounded-md border text-micro">
                <button
                  type="button"
                  onClick={() => setMode("html")}
                  className={cn("px-2 py-1 font-medium transition-colors", mode === "html" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  HTML
                </button>
                <button
                  type="button"
                  onClick={() => setMode("text")}
                  className={cn("border-l px-2 py-1 font-medium transition-colors", mode === "text" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  Plain text
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {error ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">Couldn't load the original message.</p>
          ) : !data ? (
            <div className="px-5 py-8">
              <div className="mx-auto h-4 w-40 rounded bg-muted/60 motion-safe:animate-pulse" />
            </div>
          ) : (
            <>
              {headerEntries.length > 0 && (
                <details className="border-b bg-muted/20 px-5 py-2.5 text-xs [&_summary]:cursor-pointer">
                  <summary className="font-medium text-muted-foreground select-none">Headers</summary>
                  <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
                    {headerEntries.map((r) => (
                      <div key={r.key} className="contents">
                        <dt className="text-muted-foreground">{r.label}</dt>
                        <dd className="break-all font-mono text-foreground/90">{headers![r.key]}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}

              {mode === "html" && hasHtml ? (
                // Sandboxed WITHOUT allow-scripts / allow-same-origin: customer HTML renders (styles,
                // images) but no script executes and it can't touch the app origin — no XSS surface.
                <iframe
                  title="Original email body"
                  sandbox=""
                  srcDoc={data.html ?? ""}
                  className="min-h-[55vh] w-full flex-1 bg-white"
                />
              ) : plain ? (
                <pre className="whitespace-pre-wrap break-words px-5 py-4 font-sans text-sm leading-relaxed text-foreground">{plain}</pre>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-muted-foreground">No original content was captured.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
