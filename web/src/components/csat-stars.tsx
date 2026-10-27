import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/** Five-star CSAT rating, filled to `rating` (1..5). Amber = the satisfaction signal. */
export function CsatStars({ rating, className }: { rating: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      role="img"
      aria-label={`Rated ${rating} out of 5`}
      title={`${rating} / 5`}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={cn(
            "size-3.5",
            i <= rating ? "fill-warning text-warning" : "fill-none text-muted-foreground/30",
          )}
          aria-hidden
        />
      ))}
    </span>
  );
}
