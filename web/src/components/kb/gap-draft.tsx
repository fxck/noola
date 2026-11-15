import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Copy, FilePlus2, Sparkles, X } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { GAP_DRAFT_NOTES_MAX, GAP_DRAFT_ROUNDS_MAX, draftGap, isDocsGap, matchCollection, updateKnowledgeGap, type GapDraft, type GapDraftRound, type KnowledgeGap } from "@/lib/gaps";
import { createArticle, createCollection, type KbCollection } from "@/lib/kb";
import { ArticleBody } from "@/components/editor/article-body";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { DEFAULT_COLLECTION_COLOR } from "./collection-common";

function draftError(err: unknown): string {
  const e = err as ApiError;
  if (e.status === 404) return "This gap no longer exists.";
  if (e.detail === "draft_failed") return e.serverMessage ?? "The model couldn't write a draft. Please try again.";
  return "Couldn't draft with AI. Please try again.";
}

/** Finds the suggested collection, or creates it. Null means uncategorized. */
async function collectionFor(gap: KnowledgeGap, collections: KbCollection[]): Promise<string | null> {
  const name = gap.collection?.trim();
  if (!name) return null;
  const existing = matchCollection(name, collections);
  if (existing) return existing.id;
  try {
    return (await createCollection({ name, color: DEFAULT_COLLECTION_COLOR, position: collections.length })).id;
  } catch {
    toast.error(`Couldn't create the “${name}” collection, so the article is uncategorized.`);
    return null;
  }
}

export function GapDraftPanel({
  gap,
  collections,
  onClose,
}: {
  gap: KnowledgeGap;
  collections: KbCollection[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const docs = isDocsGap(gap.kind);
  const [notes, setNotes] = useState("");
  // Every revision sends the drafting so far: each note and the open questions that came back, so answers keep their questions.
  const [rounds, setRounds] = useState<GapDraftRound[]>([]);
  const [draft, setDraft] = useState<GapDraft | null>(null);
  const [busy, setBusy] = useState<"drafting" | "creating" | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // The collection made for this gap, so a retry after a failed create reuses it.
  const madeCollection = useRef<string | null>(null);

  useEffect(() => {
    if (busy !== "drafting") return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  async function run() {
    setBusy("drafting");
    const note = notes.trim();
    try {
      const next = await draftGap(gap.id, {
        notes: note || undefined,
        rounds: rounds.length ? rounds : undefined,
        previous: draft ? { title: draft.title, body: draft.body } : undefined,
      });
      setDraft(next);
      setRounds([...rounds, { notes: note, openQuestions: next.openQuestions }]);
      setNotes("");
    } catch (err) {
      toast.error(draftError(err));
    } finally {
      setBusy(null);
    }
  }

  async function createDraftArticle() {
    if (!draft) return;
    setBusy("creating");
    try {
      const collectionId = madeCollection.current ?? (await collectionFor(gap, collections));
      madeCollection.current = collectionId;
      const article = await createArticle(draft.title, draft.body, collectionId, { status: "draft", visibility: "ai" });
      // The article exists even if resolving fails, so the gap stays open for triage.
      await updateKnowledgeGap(gap.id, { status: "resolved", resolvedArticleId: article.id }).catch(() => {});
      toast.success("Draft article created.");
      void navigate({ to: "/kb/$articleId/edit", params: { articleId: article.id } });
    } catch {
      toast.error("Couldn't create the article. Please try again.");
      setBusy(null);
    }
  }

  const copyDraft = () =>
    void navigator.clipboard.writeText(`# ${draft?.title ?? ""}\n\n${draft?.body ?? ""}`).then(
      () => toast.success("Draft copied as Markdown."),
      () => toast.error("Couldn't copy the draft."),
    );

  return (
    <section className="mt-4 space-y-3 rounded-lg border bg-card p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-3.5 text-muted-foreground" />
          {docs ? "Draft the docs change with AI" : "Draft the article with AI"}
        </h3>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground" onClick={onClose} aria-label="Close" disabled={busy !== null}>
          <X className="size-3.5" />
        </Button>
      </div>

      {draft && (
        <div className="space-y-3 border-b pb-3">
          <h4 className="text-base font-semibold tracking-tight text-balance">{draft.title}</h4>
          <ArticleBody markdown={draft.body} />
          {draft.openQuestions.length > 0 && (
            <div className="rounded-lg border border-warning/25 bg-warning/5 px-3 py-2">
              <p className="text-xs font-semibold text-warning">Confirm before publishing</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
                {draft.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {docs ? (
              <Button size="sm" className="gap-1.5" onClick={copyDraft} disabled={busy !== null}>
                <Copy className="size-3.5" /> Copy
              </Button>
            ) : (
              <Button size="sm" className="gap-1.5" onClick={() => void createDraftArticle()} disabled={busy !== null}>
                {busy === "creating" ? <Spinner className="size-3.5" /> : <FilePlus2 className="size-3.5" />}
                Create draft article
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {rounds.some((r) => r.notes) && (
          <div className="text-xs text-muted-foreground">
            <p className="font-medium">Your notes so far</p>
            <ol className="mt-0.5 list-decimal space-y-0.5 pl-4">
              {rounds.filter((r) => r.notes).map((r, i) => (
                <li key={i} className="whitespace-pre-wrap break-words">{r.notes}</li>
              ))}
            </ol>
          </div>
        )}
        <Textarea
          rows={2}
          autoGrow
          maxLength={GAP_DRAFT_NOTES_MAX}
          disabled={busy !== null || rounds.length >= GAP_DRAFT_ROUNDS_MAX}
          aria-label={draft ? "What to change" : "Notes for the draft"}
          placeholder={draft ? "What to change, for example: shorter, and add the CLI command" : "Optional notes, for example: focus on the CLI steps"}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={draft ? "outline" : "default"} className="gap-1.5" onClick={() => void run()} disabled={busy !== null || rounds.length >= GAP_DRAFT_ROUNDS_MAX}>
            {busy === "drafting" ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />}
            {draft ? "Revise" : "Draft"}
          </Button>
          {rounds.length >= GAP_DRAFT_ROUNDS_MAX && <span className="text-xs text-muted-foreground">That's the most revisions for one draft.</span>}
          {busy === "drafting" && (
            <span className="text-xs text-muted-foreground" aria-live="polite">
              Drafting from the conversations and sources. This can take up to a minute ({elapsed}s).
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
