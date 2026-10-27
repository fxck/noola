import { useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { useNerdMode } from "@/lib/nerd-mode";
import { deleteSource, type SourceRow } from "@/lib/sources";
import { SourceDetail } from "@/routes/sources";
import { sourceTitle, docNoun } from "@/components/sources/source-lib";

// A real, URL-addressable source page: /sources/$sourceId. Deep-linkable,
// shareable, and back-button-friendly — the routed replacement for the old
// state-only right pane. Shows the source's config + sync state + its ingested
// documents; delete confirms then returns to the list.
const routeApi = getRouteApi("/sources/$sourceId");

export function SourceDetailPage() {
  const { sourceId } = routeApi.useParams();
  const navigate = useNavigate();
  const { nerd } = useNerdMode();

  const [confirming, setConfirming] = useState<SourceRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const backToList = () => void navigate({ to: "/sources" });

  async function doDelete() {
    if (!confirming) return;
    setDeleting(true);
    try {
      await deleteSource(confirming.id);
      toast.success("Source removed.");
      void navigate({ to: "/sources" });
    } catch {
      toast.error("Couldn't remove that source. Please try again.");
      setDeleting(false);
      setConfirming(null);
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        <SourceDetail
          key={sourceId}
          sourceId={sourceId}
          nerd={nerd}
          onBack={backToList}
          onDelete={(s) => setConfirming(s)}
        />
      </div>

      <ConfirmDialog
        open={!!confirming}
        title="Delete source?"
        message={
          confirming
            ? `“${sourceTitle(confirming)}” and the ${confirming.doc_count} ingested ${docNoun(
                confirming,
              )} it added to your knowledge base will be permanently removed. This can't be undone.`
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
