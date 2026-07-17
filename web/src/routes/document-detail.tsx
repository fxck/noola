import { useEffect, useState } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, FileText, Copy, Check } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toaster";
import { CodeViewer, viewerLanguage } from "@/components/ui/code-viewer";
import { useNerdMode } from "@/lib/nerd-mode";
import { ApiError } from "@/lib/api";
import { fetchDocument, fetchDocumentContent, type SourceDocument, type DocumentContent } from "@/lib/documents";
import { cn } from "@/lib/utils";

// A routed, deep-linkable viewer for an uploaded document's raw stored text:
// /documents/$id. Renders the content in a read-only CodeMirror viewer (syntax
// highlighting, line numbers, wrapping, search) with the file's language inferred from
// its content type. Documents live under Sources → the shell keeps that nav active.
const routeApi = getRouteApi("/documents/$id");

export function DocumentDetailPage() {
  const { id } = routeApi.useParams();
  const navigate = useNavigate();
  const { nerd } = useNerdMode();

  const [doc, setDoc] = useState<SourceDocument | null>(null);
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notfound" | "error">("loading");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setState("loading");
    Promise.all([fetchDocument(id), fetchDocumentContent(id)])
      .then(([d, c]) => {
        if (!alive) return;
        setDoc(d);
        setContent(c);
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setState((e as ApiError)?.status === 404 ? "notfound" : "error");
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const back = () => void navigate({ to: "/sources" });

  async function copyAll() {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard.");
    }
  }

  const title = doc?.filename ?? content?.filename ?? "Document";
  const lang = viewerLanguage(content?.content_type ?? doc?.content_type, title);

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* ── entity header (§3): back · glyph · title · quiet meta · actions ── */}
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          <Link
            to="/sources"
            aria-label="Back to sources"
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-8 shrink-0 text-muted-foreground")}
          >
            <ChevronLeft className="size-4" />
          </Link>
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">{title}</h1>
          {state === "ready" && doc && (
            <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
              <span>{doc.content_type}</span>
              <span className="text-muted-foreground/40">·</span>
              <span className="tabular-nums">{doc.char_count.toLocaleString()} chars</span>
              {nerd && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="tabular-nums">
                    {doc.chunk_count} chunk{doc.chunk_count === 1 ? "" : "s"}
                  </span>
                </>
              )}
              {/* indexed is the norm — only an abnormal state earns color (§4) */}
              {doc.status !== "indexed" && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-destructive">{doc.status}</span>
                </>
              )}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center">
            {state === "ready" && (
              <Button variant="outline" size="sm" onClick={() => void copyAll()} className="h-8 gap-1.5 text-xs">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </div>
        </header>

        {/* Body */}
        <div className="min-h-0 flex-1 px-4 pb-4">
          {state === "loading" && (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Spinner /> <span className="ml-2 text-sm">Loading document…</span>
            </div>
          )}
          {state === "notfound" && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium">Document not found</p>
              <p className="text-sm text-muted-foreground">It may have been deleted or belongs to another workspace.</p>
              <Button variant="outline" size="sm" onClick={back} className="mt-2">Back to sources</Button>
            </div>
          )}
          {state === "error" && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium">Couldn't load this document</p>
              <p className="text-sm text-muted-foreground">The content service may be unavailable. Try again in a moment.</p>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/documents/$id", params: { id }, replace: true })} className="mt-2">Retry</Button>
            </div>
          )}
          {state === "ready" && content && (
            <div className="h-full">
              <CodeViewer value={content.content} language={lang} readOnly height="100%" />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
