import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { type Attachment, downloadAttachment, fetchAttachmentBlob, formatBytes } from "@/lib/tickets";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Full-viewport image viewer for a message's inline image attachments. Opens on a
 * thumbnail click (see `AttachmentImage`) and lets the agent step through every image
 * in the SAME bubble with ←/→ or the on-screen arrows — the raw-blob-in-a-new-tab
 * behaviour never gave them that.
 *
 * Object URLs are OWNED BY THE PARENT (`ImageAttachments`) and shared with the inline
 * thumbnails: the full-size view reuses the bytes the thumbnail already fetched instead
 * of hitting the Bearer-authed serve route a second time. When a URL isn't in the shared
 * cache yet (thumbnail still loading, or off-screen), we fetch it and hand it back via
 * `onResolveUrl` so it lands in that one cache — which is also the one place they're
 * revoked, so nothing here leaks.
 */
export function ImageLightbox({
  images,
  index,
  urls,
  onIndexChange,
  onResolveUrl,
  onClose,
}: {
  images: Attachment[];
  index: number;
  /** Shared id→objectURL cache, minted+revoked by the parent. */
  urls: Record<string, string>;
  onIndexChange: (next: number) => void;
  /** Store a freshly-fetched objectURL into the shared cache (parent owns its lifecycle). */
  onResolveUrl: (id: string, url: string) => void;
  onClose: () => void;
}) {
  const current = images[index];
  const url = current ? (urls[current.id] ?? null) : null;
  const panelRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  const prev = useCallback(() => onIndexChange((index - 1 + images.length) % images.length), [index, images.length, onIndexChange]);
  const next = useCallback(() => onIndexChange((index + 1) % images.length), [index, images.length, onIndexChange]);

  // Resolve the viewed image on demand — usually a cache hit (the thumbnail already
  // fetched it); only a genuinely un-fetched image triggers a request. The URL goes into
  // the parent cache, so this effect never revokes anything itself.
  useEffect(() => {
    if (!current || urls[current.id]) return;
    let cancelled = false;
    fetchAttachmentBlob(current.id)
      .then((blob) => {
        if (!cancelled) onResolveUrl(current.id, URL.createObjectURL(blob));
      })
      .catch(() => {
        /* leave the spinner; Esc/arrows still work, and the chip download is the fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [current, urls, onResolveUrl]);

  // Keyboard: Esc closes, ←/→ navigate, Tab is trapped inside the modal chrome.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && images.length > 1) {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight" && images.length > 1) {
        e.preventDefault();
        next();
      } else if (e.key === "Tab") {
        const focusable = panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [images.length, prev, next, onClose]);

  // Move focus into the dialog on open; restore it to the trigger on close.
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => restore?.focus?.();
  }, []);

  if (!current) return null;

  async function onDownload() {
    if (downloading || !current) return;
    setDownloading(true);
    try {
      await downloadAttachment(current.id, current.filename);
    } catch {
      /* swallow — the agent can retry; the modal stays put */
    } finally {
      setDownloading(false);
    }
  }

  const many = images.length > 1;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={current.filename}
      className="motion-overlay fixed inset-0 z-[70] flex flex-col bg-black/80 outline-none backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Chrome: caption + counter on the left, download + close on the right. */}
      <div
        className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 text-sm text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium" title={current.filename}>
            {current.filename}
          </span>
          <span className="shrink-0 text-white/60">{formatBytes(current.size_bytes)}</span>
          {many && (
            <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs tabular-nums text-white/80">
              {index + 1} / {images.length}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-white hover:bg-white/15 hover:text-white"
            onClick={onDownload}
            disabled={downloading}
          >
            <Download className="size-4" /> Download
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-white hover:bg-white/15 hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Stage: the image fits the viewport (object-contain), centered. A click on the
          image must NOT close — only the surrounding backdrop does. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
        {many && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute left-3 top-1/2 z-10 size-10 -translate-y-1/2 rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            aria-label="Previous image"
          >
            <ChevronLeft className="size-5" />
          </Button>
        )}
        {url ? (
          <img
            src={url}
            alt={current.filename}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
          />
        ) : (
          <div
            className={cn("size-40 rounded-lg bg-white/5 motion-safe:animate-pulse")}
            onClick={(e) => e.stopPropagation()}
            aria-hidden
          />
        )}
        {many && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-3 top-1/2 z-10 size-10 -translate-y-1/2 rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            aria-label="Next image"
          >
            <ChevronRight className="size-5" />
          </Button>
        )}
      </div>
    </div>
  );
}
