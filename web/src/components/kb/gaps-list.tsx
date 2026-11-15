import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Check, ChevronLeft, Copy, FileText, PenLine, RotateCcw, Sparkles, X } from "lucide-react";
import {
  REVIEW_KIND_LABELS,
  isDocsGap,
  matchCollection,
  type GapStatus,
  type GapSummary,
  type KnowledgeGap,
} from "@/lib/gaps";
import type { KbArticle, KbCollection } from "@/lib/kb";
import { relativeTime } from "@/lib/tickets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CollectionDot } from "./collection-common";
import { GapDraftPanel } from "./gap-draft";

// The KB's gap worklist: docs gaps grouped by the page to change, article gaps grouped by the collection to write into.

export type GapTab = "docs" | "articles";

export const gapTab = (g: KnowledgeGap): GapTab => (isDocsGap(g.kind) ? "docs" : "articles");

export interface GapGroup {
  key: string;
  label: string;
  /** The docs page, for a docs group. */
  href: string | null;
  /** The existing collection, for an article group. */
  collection: KbCollection | null;
  /** A suggested collection that the KB doesn't have yet. */
  isNew: boolean;
  gaps: KnowledgeGap[];
}

/** The page path without the host, so a header stays short. The root page shows its host. */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return path ? path + u.hash : u.host;
  } catch {
    return url;
  }
}

/** Groups keep the order of their most-asked gap, and the gaps without a page or collection come last. */
export function groupGaps(gaps: KnowledgeGap[], tab: GapTab, collections: KbCollection[]): GapGroup[] {
  const groups = new Map<string, GapGroup>();
  let rest: GapGroup | null = null;
  for (const g of gaps) {
    const name = tab === "docs" ? g.pageUrl?.trim() : g.collection?.trim();
    if (!name) {
      rest ??= { key: "", label: tab === "docs" ? "No page yet" : "No collection suggested", href: null, collection: null, isNew: false, gaps: [] };
      rest.gaps.push(g);
      continue;
    }
    const key = tab === "docs" ? name : name.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      const collection = tab === "articles" ? matchCollection(name, collections) : null;
      group = {
        key,
        label: tab === "docs" ? pagePath(name) : collection?.name ?? name,
        href: tab === "docs" ? name : null,
        collection,
        isNew: tab === "articles" && !collection,
        gaps: [],
      };
      groups.set(key, group);
    }
    group.gaps.push(g);
  }
  return rest ? [...groups.values(), rest] : [...groups.values()];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The newest suggestion and suggested title, since the newest conversation knows the most. */
export function gapSuggestion(g: KnowledgeGap): { suggestion: string | null; title: string | null } {
  return {
    suggestion: g.questions.find((q) => q.suggestion?.trim())?.suggestion ?? null,
    title: g.questions.find((q) => q.title?.trim())?.title ?? null,
  };
}

export function GapsSummary({ summary }: { summary: GapSummary }) {
  if (summary.reviewed === 0) return null;
  const { answered } = summary.questions;
  const { account_issue, feedback, no_question } = summary.conversations;
  const parts = [
    answered > 0 && `${plural(answered, "question")} already answered by your sources`,
    account_issue > 0 && plural(account_issue, "account issue"),
    feedback > 0 && `${feedback} feedback`,
    no_question > 0 && `${no_question} without a question`,
  ].filter(Boolean);
  return (
    <p className="px-4 py-2 text-xs text-muted-foreground lg:px-6">
      Reviewed {plural(summary.reviewed, "conversation")}
      {parts.length > 0 && ` · ${parts.join(", ")}`}
    </p>
  );
}

export function GapsList({
  groups,
  selectedId,
  onSelect,
}: {
  groups: GapGroup[];
  selectedId: string | null;
  onSelect: (gap: KnowledgeGap) => void;
}) {
  return (
    <div>
      {groups.map((group) => (
        <section key={group.key}>
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/90 px-4 py-2 backdrop-blur lg:px-6">
            {group.href ? (
              <a
                href={group.href}
                target="_blank"
                rel="noreferrer"
                title={group.href}
                className="flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-wide hover:underline"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{group.label}</span>
                <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-wide">
                {group.collection && <CollectionDot color={group.collection.color} />}
                <span className={cn("truncate", group.key === "" && "text-muted-foreground")}>{group.label}</span>
              </span>
            )}
            {group.isNew && (
              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-micro" title="This collection doesn't exist yet">
                New
              </Badge>
            )}
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{group.gaps.length}</span>
          </div>
          <ul className="divide-y divide-border/50">
            {group.gaps.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => onSelect(g)}
                  aria-current={selectedId === g.id ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors active:bg-muted lg:px-6",
                    selectedId === g.id ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <span className="line-clamp-2 text-sm font-medium leading-5">{g.question}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    <span className="tabular-nums">{plural(g.occurrences, "conversation")}</span>
                    {g.kind === "docs_missing" && " · Missing"}
                    {g.kind === "docs_unclear" && " · Unclear"}
                    {` · last asked ${relativeTime(g.lastSeen)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const LINK = "text-primary underline-offset-2 hover:underline";

export function GapDetail({
  gap: g,
  collections,
  articles,
  onBack,
  onWrite,
  onCopy,
  onTriage,
}: {
  gap: KnowledgeGap;
  collections: KbCollection[];
  articles: KbArticle[];
  /** Shown below the wide layout, where the detail replaces the list. */
  onBack?: () => void;
  onWrite: () => void;
  onCopy: (text: string) => void;
  onTriage: (status: GapStatus) => void;
}) {
  const docs = isDocsGap(g.kind);
  const { suggestion, title } = gapSuggestion(g);
  const collection = matchCollection(g.collection, collections);
  const articleId = g.questions.find((q) => q.articleId)?.articleId ?? null;
  const article = articleId ? articles.find((a) => a.id === articleId) : undefined;
  const resolvedId = g.status === "resolved" ? g.resolvedArticleId : null;
  const resolvedBy = resolvedId ? articles.find((a) => a.id === resolvedId) : undefined;
  const [drafting, setDrafting] = useState(false);

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      {onBack && (
        <Button variant="ghost" size="sm" className="-ml-2 mb-2 gap-1 text-muted-foreground xl:hidden" onClick={onBack}>
          <ChevronLeft className="size-4" /> Gaps
        </Button>
      )}
      <span className="text-micro font-medium uppercase tracking-wide text-muted-foreground/70">
        {REVIEW_KIND_LABELS[g.kind]}
      </span>
      <h2 className="mt-1 text-xl font-semibold tracking-tight text-balance">{g.question}</h2>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {plural(g.occurrences, "conversation")} · first asked {relativeTime(g.firstSeen)} · last asked {relativeTime(g.lastSeen)}
        {g.status !== "open" && ` · ${g.status === "resolved" ? "Resolved" : "Dismissed"}`}
      </p>

      <div className="mt-3 space-y-1.5 text-sm">
        {docs ? (
          g.pageUrl ? (
            <a href={g.pageUrl} target="_blank" rel="noreferrer" title={g.pageUrl} className={cn(LINK, "inline-flex max-w-full items-center gap-1.5")}>
              <FileText className="size-3.5 shrink-0" />
              <span className="truncate">{pagePath(g.pageUrl)}</span>
              <ArrowUpRight className="size-3.5 shrink-0" />
            </a>
          ) : (
            <p className="text-muted-foreground">No docs page relates to this yet.</p>
          )
        ) : g.collection ? (
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">Collection</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium text-foreground/80">
              {collection && <CollectionDot color={collection.color} />}
              {collection?.name ?? g.collection}
            </span>
            {!collection && <Badge variant="outline">New collection</Badge>}
          </p>
        ) : null}
        {articleId && (
          <p>
            <span className="text-muted-foreground">Help article to change: </span>
            <Link to="/kb/$articleId" params={{ articleId }} className={LINK}>
              {article?.title ?? "Open the article"}
            </Link>
          </p>
        )}
        {resolvedId && (
          <p>
            <span className="text-muted-foreground">Resolved by </span>
            <Link to="/kb/$articleId" params={{ articleId: resolvedId }} className={LINK}>
              {resolvedBy?.title ?? "an article"}
            </Link>
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {g.status === "open" && (
          <>
            <Button size="sm" variant={docs ? "outline" : "default"} className="gap-1.5" onClick={onWrite}>
              <PenLine className="size-3.5" /> Write article
            </Button>
            {suggestion && (
              <Button size="sm" variant={docs ? "default" : "outline"} className="gap-1.5" onClick={() => onCopy(suggestion)}>
                <Copy className="size-3.5" /> Copy suggestion
              </Button>
            )}
            {!drafting && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDrafting(true)}>
                <Sparkles className="size-3.5" /> Draft with AI
              </Button>
            )}
          </>
        )}
        {g.status !== "open" && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onTriage("open")}>
            <RotateCcw className="size-3.5" /> Reopen
          </Button>
        )}
        {g.status !== "resolved" && (
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => onTriage("resolved")}>
            <Check className="size-3.5" /> Mark resolved
          </Button>
        )}
        {g.status !== "dismissed" && (
          <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={() => onTriage("dismissed")}>
            <X className="size-3.5" /> Dismiss
          </Button>
        )}
      </div>

      {drafting && g.status === "open" && (
        <GapDraftPanel gap={g} collections={collections} onClose={() => setDrafting(false)} />
      )}

      <section className="mt-6 space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground">Suggestion</h3>
        {title && (
          <p className="text-sm">
            <span className="text-muted-foreground">Article title: </span>
            <span className="font-medium">{title}</span>
          </p>
        )}
        {suggestion ? (
          <p className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 px-3 py-2 text-sm">{suggestion}</p>
        ) : (
          <p className="text-sm text-muted-foreground">The review left no suggestion.</p>
        )}
      </section>

      <section className="mt-6 space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground">Conversations</h3>
        <ul className="divide-y rounded-lg border">
          {g.questions.map((q) => (
            <li key={q.id} className="space-y-1 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <Link
                  to="/tickets/$ticketId"
                  params={{ ticketId: q.ticketId }}
                  className={cn(LINK, "min-w-0 truncate text-sm font-medium")}
                  title={q.subject ?? undefined}
                >
                  {q.subject || "Untitled conversation"}
                </Link>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={new Date(q.createdAt).toLocaleString()}>
                  {new Date(q.createdAt).toLocaleDateString()}
                </span>
              </div>
              <p className="break-words text-sm">{q.question}</p>
              <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">Team answered: </span>
                {q.answer || "No answer recorded."}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
