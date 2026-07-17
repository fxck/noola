import { useSyncExternalStore, type JSX } from "react";
import { AlertTriangle, Check, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────
   Sonner-style toast store.

   Module-scoped state (no React context, no provider): a plain
   array of toasts + a Set of listeners. `toast(...)` mutates the
   array and calls `emit()`; `<Toaster/>` subscribes through
   `useSyncExternalStore`. Mount <Toaster/> once near the app root.
   ───────────────────────────────────────────────────────────── */

export type ToastKind = "ok" | "error" | "info";

export interface ToastOptions {
  kind?: ToastKind;
  duration?: number;
}

export interface ToastItem {
  id: string;
  message: string;
  kind: ToastKind;
  duration: number;
  /** True once dismissal starts — the toast plays its exit transition before it's actually
   *  removed from the array (two-phase dismiss), so it slides out instead of blinking away. */
  leaving?: boolean;
}

const DEFAULT_DURATION = 3800;
const EXIT_MS = 180; // must match the exit transition duration below

let toasts: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToastItem[] {
  return toasts;
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function scheduleTimer(id: string, duration: number): void {
  clearTimer(id);
  if (!Number.isFinite(duration) || duration <= 0) return;
  timers.set(
    id,
    setTimeout(() => dismiss(id), duration),
  );
}

// Two-phase dismiss: flip the toast to `leaving` (which triggers its exit transition), then remove
// it from the array once the transition has played. Idempotent — a second dismiss (auto-timer +
// click) on an already-leaving toast is a no-op.
function dismiss(id: string): void {
  const t = toasts.find((x) => x.id === id);
  if (!t || t.leaving) return;
  clearTimer(id);
  toasts = toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x));
  emit();
  setTimeout(() => remove(id), EXIT_MS);
}

function remove(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function add(message: string, opts?: ToastOptions): string {
  const id = crypto.randomUUID?.() ?? String(Date.now() + Math.random());
  const item: ToastItem = {
    id,
    message,
    kind: opts?.kind ?? "ok",
    duration: opts?.duration ?? DEFAULT_DURATION,
  };
  toasts = [...toasts, item];
  emit();
  scheduleTimer(id, item.duration);
  return id;
}

/* Pause-on-hover of the whole stack: clear every running timer on
   mouseenter, restart each toast's timer (full duration) on mouseleave. */
function pauseAll(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function resumeAll(): void {
  for (const t of toasts) if (!t.leaving) scheduleTimer(t.id, t.duration);
}

type SugarOptions = Omit<ToastOptions, "kind">;

interface ToastFn {
  (message: string, opts?: ToastOptions): string;
  success: (message: string, opts?: SugarOptions) => string;
  error: (message: string, opts?: SugarOptions) => string;
  info: (message: string, opts?: SugarOptions) => string;
  dismiss: (id: string) => void;
}

export const toast = ((message: string, opts?: ToastOptions): string =>
  add(message, opts)) as ToastFn;

toast.success = (message, opts) => add(message, { ...opts, kind: "ok" });
toast.error = (message, opts) => add(message, { ...opts, kind: "error" });
toast.info = (message, opts) => add(message, { ...opts, kind: "info" });
toast.dismiss = (id) => dismiss(id);

/* ─────────────────────────────────────────────────────────────
   Rendering
   ───────────────────────────────────────────────────────────── */

function KindIcon({ kind }: { kind: ToastKind }): JSX.Element {
  if (kind === "error") return <AlertTriangle className="size-4 text-destructive" />;
  if (kind === "info") return <Info className="size-4 text-muted-foreground" />;
  return <Check className="size-4 text-primary" />;
}

function borderForKind(kind: ToastKind): string {
  if (kind === "error") return "border-destructive/30";
  if (kind === "info") return "border-border";
  return "border-primary/25";
}

export function Toaster(): JSX.Element {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <div
      aria-live="polite"
      onMouseEnter={pauseAll}
      onMouseLeave={resumeAll}
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          data-leaving={t.leaving ? "" : undefined}
          onClick={() => dismiss(t.id)}
          className={cn(
            "motion-pop pointer-events-auto flex max-w-sm cursor-pointer items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-sm text-foreground shadow-lg",
            // Exit: slide out toward the corner it lives in + fade, ease-out. Interruptible CSS
            // transition (not a keyframe); the enter is the .motion-pop pop. Reduced-motion → snap.
            "transition-[opacity,transform] duration-[180ms] ease-out motion-reduce:transition-none",
            "data-[leaving]:translate-x-2 data-[leaving]:scale-95 data-[leaving]:opacity-0",
            borderForKind(t.kind),
          )}
        >
          <KindIcon kind={t.kind} />
          <span className="min-w-0 break-words">{t.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(t.id);
            }}
            className="ml-1 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
