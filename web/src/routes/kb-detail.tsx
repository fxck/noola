import { useEffect, useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/error-state";
import { toast } from "@/components/ui/toaster";
import { useNerdMode } from "@/lib/nerd-mode";
import { deleteArticle, fetchArticle, type KbArticle } from "@/lib/kb";
import { updateKnowledgeGap } from "@/lib/gaps";
import { ArticleDetail, ArticleEditor } from "@/routes/kb";

// A real, URL-addressable KB article page: /kb/$articleId. Deep-linkable,
// shareable, and back-button-friendly — the routed replacement for the old
// state-only side pane. View ⇄ inline edit; delete confirms then returns to the list.
const routeApi = getRouteApi("/kb/$articleId");

export function KbArticlePage() {
  const { articleId } = routeApi.useParams();
  const navigate = useNavigate();
  const { nerd } = useNerdMode();

  const [confirming, setConfirming] = useState<KbArticle | null>(null);
  const [deleting, setDeleting] = useState(false);

  const backToList = () => void navigate({ to: "/kb" });

  async function doDelete() {
    if (!confirming) return;
    setDeleting(true);
    try {
      await deleteArticle(confirming.id);
      toast.success("Article deleted.");
      void navigate({ to: "/kb" });
    } catch {
      toast.error("Couldn't delete that article. Please try again.");
      setDeleting(false);
      setConfirming(null);
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        <ArticleDetail
          key={articleId}
          articleId={articleId}
          nerd={nerd}
          onBack={backToList}
          onEdit={(a) => void navigate({ to: "/kb/$articleId/edit", params: { articleId: a.id } })}
          onDelete={(a) => setConfirming(a)}
        />
      </div>

      <ConfirmDialog
        open={!!confirming}
        title="Delete article?"
        message={
          confirming
            ? `“${confirming.title || "This article"}” will be permanently removed. This can't be undone.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}

// ── /kb/new — routed article creation (deep-linkable, back-button-friendly) ──
const newRouteApi = getRouteApi("/kb/new");

export function KbNewPage() {
  const navigate = useNavigate();
  const { collection, title, gap } = newRouteApi.useSearch();
  return (
    // Fullscreen document mode — writing gets the whole viewport (Medium/Paper),
    // no nav rail; the editor's own top bar carries back/save.
    <div className="flex h-dvh flex-col bg-background">
      <ArticleEditor
        initial={null}
        defaultCollectionId={collection && collection !== "none" && collection !== "gaps" ? collection : null}
        initialTitle={title}
        onCancel={() => void navigate({ to: "/kb" })}
        onSaved={(saved) => {
          toast.success("Article created.");
          // Seeded from a knowledge gap → the new article closes it.
          if (gap) {
            void updateKnowledgeGap(gap, { status: "resolved", resolvedArticleId: saved.id }).catch(
              () => {}, // non-fatal — the gap stays open for manual triage
            );
          }
          void navigate({ to: "/kb/$articleId", params: { articleId: saved.id } });
        }}
        onError={(msg) => toast.error(msg)}
      />
    </div>
  );
}

// ── /kb/$articleId/edit — routed editing; loads the article, returns to detail ──
const editRouteApi = getRouteApi("/kb/$articleId/edit");

export function KbEditPage() {
  const { articleId } = editRouteApi.useParams();
  const navigate = useNavigate();
  const [article, setArticle] = useState<KbArticle | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setState("loading");
    void (async () => {
      try {
        const a = await fetchArticle(articleId);
        if (live) {
          setArticle(a);
          setState("ready");
        }
      } catch {
        if (live) setState("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [articleId, reloadKey]);

  const back = () => void navigate({ to: "/kb/$articleId", params: { articleId } });

  return (
    // Fullscreen document mode — same frame as /kb/new so the transition is seamless.
    <div className="flex h-dvh flex-col bg-background">
      {state === "loading" ? (
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      ) : state === "error" || !article ? (
        <div className="grid flex-1 place-items-center">
          <ErrorState
            title="Couldn't load this article"
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </div>
      ) : (
        <ArticleEditor
          initial={article}
          onCancel={back}
          onSaved={() => {
            toast.success("Article saved.");
            back();
          }}
          onError={(msg) => toast.error(msg)}
        />
      )}
    </div>
  );
}
