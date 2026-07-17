import { forwardRef, useCallback, useLayoutEffect, useRef, type MutableRefObject, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Invalid state — red border + ring (pair with <Field error>). */
  error?: boolean;
  /** Grow to fit content (no inner scrollbar) instead of a fixed row box — for code / long-text
   *  fields where a cramped 3-row window hides most of what you typed. Capped at `maxHeight` px,
   *  after which it scrolls. */
  autoGrow?: boolean;
  /** Cap for autoGrow before an inner scrollbar appears. Default 384. */
  maxHeight?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, autoGrow, maxHeight = 384, value, onChange, onInput, ...props }, ref) => {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const setRefs = useCallback(
      (el: HTMLTextAreaElement | null) => {
        innerRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as MutableRefObject<HTMLTextAreaElement | null>).current = el;
      },
      [ref],
    );
    const resize = useCallback(() => {
      const el = innerRef.current;
      if (!el || !autoGrow) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    }, [autoGrow, maxHeight]);
    // Re-fit on every value change (controlled) and after mount, so pre-filled content shows in full.
    useLayoutEffect(() => {
      resize();
    }, [resize, value]);

    return (
      <textarea
        ref={setRefs}
        value={value}
        onChange={(e) => {
          onChange?.(e);
          resize();
        }}
        onInput={(e) => {
          onInput?.(e);
          resize();
        }}
        aria-invalid={error || undefined}
        className={cn(
          "flex min-h-16 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          autoGrow && "overflow-y-auto",
          error && "border-destructive focus-visible:ring-destructive",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";
