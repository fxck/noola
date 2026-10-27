import { Smile, Meh, Frown } from "lucide-react";
import { cn } from "@/lib/utils";

const MAP: Record<string, { label: string; icon: typeof Smile; cls: string }> = {
  positive: { label: "Positive", icon: Smile, cls: "text-success" },
  neutral: { label: "Neutral", icon: Meh, cls: "text-muted-foreground" },
  negative: { label: "Negative", icon: Frown, cls: "text-warning" },
};

/** Customer-sentiment chip (keyword-classified). Icon + label, semantic color. */
export function SentimentBadge({ sentiment, className }: { sentiment: string; className?: string }) {
  const m = MAP[sentiment] ?? MAP.neutral;
  const Icon = m.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", m.cls, className)}>
      <Icon className="size-3.5" /> {m.label}
    </span>
  );
}
