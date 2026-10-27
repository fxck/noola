import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one form modal — a centered scale-in dialog built on the shared
 * `.motion-overlay` / `.motion-pop` classes (reduced-motion safe), the same idiom
 * ConfirmDialog / CollectionDialog already standardize on. This is the canonical
 * "New … / Edit …" surface for the list-first add/edit pattern (F6): the list is the
 * resting state, a header "New …" reveals this, and editing a row reuses it pre-filled.
 *
 * Owns only the chrome — overlay, header (title + description + close), a scrollable
 * body, and a Cancel/Submit footer. The caller supplies the fields and wires the
 * submit. Escape, overlay-click, and the X all close (gated by `busy`). The body is a
 * real <form>, so Enter submits from a text input. The submit stays neutral ink
 * (amber is reserved for the ONE marquee "New …" CTA in the surface header).
 */
export function FormDialog({
  open,
  title,
  description,
  onClose,
  onSubmit,
  submitLabel = "Save",
  cancelLabel = "Cancel",
  submitDisabled,
  busy,
  size = "md",
  footer,
  children,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  onSubmit?: () => void;
  submitLabel?: ReactNode;
  cancelLabel?: string;
  submitDisabled?: boolean;
  busy?: boolean;
  /** `md` for short forms; `lg` for the longer macro/routing editors. */
  size?: "md" | "lg";
  /** Replace the default Cancel/Submit footer entirely (e.g. a destructive extra action). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  // Escape closes (unless mid-save), matching the app's popovers/dialogs.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div
      className="motion-overlay fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
      onClick={() => !busy && onClose()}
    >
      <form
        className={cn(
          "motion-pop my-auto flex w-full flex-col overflow-hidden rounded-xl border bg-card shadow-lg",
          size === "lg" ? "max-w-xl" : "max-w-md",
        )}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mr-1.5 size-8 shrink-0"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="max-h-[70vh] min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {children}
        </div>

        {footer ?? (
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3.5">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {cancelLabel}
            </Button>
            <Button type="submit" size="sm" disabled={busy || submitDisabled}>
              {submitLabel}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
