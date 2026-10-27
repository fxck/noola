import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// The one form-field wrapper — label + control + hint/error, laid out on a consistent rhythm.
// The foundation the ~26 settings pages (and every form dialog) share instead of re-stacking a
// bare <Label> + control + hand-rolled helper text. Pass the control as children; Field owns the
// label association (its generated id is handed back via the render-prop form, or set `htmlFor`
// yourself). `error` supersedes `hint` and turns the message destructive — pair it with the
// control's own `error` prop for the red ring.

export interface FieldProps {
  label?: ReactNode;
  /** Associates the label with a control you give a matching `id`. Omit to use the
   *  render-prop form `{(id) => <Input id={id} />}` which wires it automatically. */
  htmlFor?: string;
  /** Quiet helper text below the control. Hidden when `error` is set. */
  hint?: ReactNode;
  /** Error message below the control (destructive). Takes precedence over `hint`. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode | ((id: string) => ReactNode);
}

export function Field({ label, htmlFor, hint, error, required, className, children }: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const describedById = `${id}-desc`;
  const message = error ?? hint;
  return (
    <div className={cn("space-y-1.5", className)}>
      {label != null && (
        <Label htmlFor={id}>
          {label}
          {required && (
            <span className="ml-0.5 text-destructive" aria-hidden="true">
              *
            </span>
          )}
        </Label>
      )}
      {typeof children === "function" ? children(id) : children}
      {message != null && (
        <p
          id={describedById}
          className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}
        >
          {message}
        </p>
      )}
    </div>
  );
}
