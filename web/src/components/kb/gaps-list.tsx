import { Lightbulb, PenLine, X, Check } from "lucide-react";
import type { KnowledgeGap } from "@/lib/gaps";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The knowledge-loop worklist, scoped into the KB where its action lives:
 * questions the KB couldn't answer, most-asked first. Each gap can seed a new
 * article (title prefilled, gap auto-resolved on save), be marked resolved, or
 * dismissed. Rows follow the KB list anatomy — no cards, no chips.
 */
export function GapsList({
  gaps,
  onWrite,
  onTriage,
}: {
  gaps: KnowledgeGap[];
  onWrite: (gap: KnowledgeGap) => void;
  onTriage: (id: string, status: "resolved" | "dismissed") => void;
}) {
  if (gaps.length === 0) {
    return (
      <EmptyState
        icon={Lightbulb}
        title="No open gaps"
        description="When a customer question finds no good KB match, it lands here so you can close the loop."
      />
    );
  }
  return (
    <ul className="divide-y">
      {gaps.map((g) => (
        <li key={g.id} className="group flex items-start gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none lg:px-6">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-small font-medium leading-5" title={g.question}>
              {g.question}
            </p>
            <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
              <span className="tabular-nums">asked {g.occurrences}×</span>
              {" · "}
              {g.agreement === 0 ? "no KB match" : "weak match"}
              {" · "}
              last {new Date(g.lastSeen).toLocaleDateString()}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:opacity-100 motion-reduce:transition-none">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => onWrite(g)}
              title="Write a KB article that answers this"
            >
              <PenLine className="size-3.5" /> Write article
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => onTriage(g.id, "resolved")}
              title="Mark resolved"
              aria-label="Mark resolved"
            >
              <Check className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground"
              onClick={() => onTriage(g.id, "dismissed")}
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
