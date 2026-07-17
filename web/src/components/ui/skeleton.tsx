import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * A calm loading placeholder — a pulsing muted block. Compose it to match the
 * shape of the content it stands in for (rows, avatars, text lines) so first
 * paint doesn't shift when data lands. Pulse is dropped under reduced-motion.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/**
 * Column-matched rows for a table/list first load — stand-ins that occupy the
 * same vertical rhythm as real rows, so the layout doesn't jump when data lands.
 */
export function RowsSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("divide-y", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}
