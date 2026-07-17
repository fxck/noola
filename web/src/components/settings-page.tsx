import { type ReactNode } from "react";
import { SettingsRail, type SettingsSection } from "@/components/settings-rail";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/error-state";

// The one settings-page shell — the scaffold all 20 settings routes share instead of each
// re-stitching AppShell + SettingsRail + the scroll container + h-12 header + the
// loading/error/ready state triad by hand. A page supplies its rail key, title, an optional
// header actions slot (Save/CTA), an optional description, and its load `status`; the body
// renders only when `ready` (spinner / retryable ErrorState otherwise). The header + rail stay
// visible through load so the surface never blanks.

export function SettingsPage({
  active,
  title,
  description,
  actions,
  status = "ready",
  onRetry,
  errorTitle,
  children,
}: {
  active: SettingsSection;
  title: ReactNode;
  /** Quiet one-liner under the header describing the surface. */
  description?: ReactNode;
  /** Right-aligned header slot — the Save button / primary CTA. */
  actions?: ReactNode;
  status?: "loading" | "error" | "ready";
  /** Retry handler for the error state (wired to the page's `load`). */
  onRetry?: () => void;
  errorTitle?: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <SettingsRail active={active} />
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <header className="flex h-12 shrink-0 items-center gap-2 px-6">
            <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
            {actions != null && <div className="ml-auto flex items-center gap-2">{actions}</div>}
          </header>
          {description != null && (
            <p className="px-6 text-small text-muted-foreground">{description}</p>
          )}
          {status === "loading" ? (
            <div className="grid flex-1 place-items-center py-10">
              <Spinner />
            </div>
          ) : status === "error" ? (
            <ErrorState title={errorTitle ?? "Couldn't load these settings"} onRetry={onRetry} />
          ) : (
            children
          )}
        </div>
      </div>
    </>
  );
}
