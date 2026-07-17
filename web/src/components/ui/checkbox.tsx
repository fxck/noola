import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * A shared checkbox — square, accent-filled when on, with an indeterminate dash
 * for the partial (select-all header) case. One source of truth for the toggle
 * boxes previously hand-rolled per table.
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked, indeterminate, onCheckedChange, className, disabled, onClick, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : !!checked}
      disabled={disabled}
      // Callers pass onClick for stopPropagation (row-click tables); the toggle
      // must still fire — a spread {...props}.onClick would silently replace it.
      onClick={(e) => {
        onClick?.(e);
        onCheckedChange?.(!checked);
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors duration-150 ease-[var(--ease-out-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        checked || indeterminate
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background hover:border-muted-foreground/50",
        className,
      )}
      {...props}
    >
      {indeterminate ? (
        <Minus className="size-3" strokeWidth={3} />
      ) : checked ? (
        <Check className="size-3" strokeWidth={3} />
      ) : null}
    </button>
  ),
);
Checkbox.displayName = "Checkbox";
