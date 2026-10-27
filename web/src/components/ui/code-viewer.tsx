import { lazy, Suspense } from "react";
import { Spinner } from "./spinner";

// A read-only (or editable) CodeMirror 6 document viewer — syntax highlighting, line
// numbers, wrapping, and search. The editor + language modes live in a lazily-loaded chunk
// (code-viewer-cm) so they never weigh on the main bundle; they download only when a viewer
// first mounts. Import THIS module everywhere; never the -cm one directly.

export interface CodeViewerProps {
  value: string;
  /** Language id (see viewerLanguage() to derive one from a MIME type / filename). */
  language?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** CSS height (the editor needs an explicit height; default fills its container). */
  height?: string | number;
}

const CodeViewerCM = lazy(() => import("./code-viewer-cm"));

/** Map a document's content type (or filename) to a viewer language id. Uploaded docs are
 *  markdown / html / plain text today; the extra cases cover future upload kinds. */
export function viewerLanguage(contentType?: string, filename?: string): string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("markdown")) return "markdown";
  if (ct.includes("html")) return "html";
  if (ct.includes("json")) return "json";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("csv")) return "plaintext";
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  const byExt: Record<string, string> = {
    md: "markdown", markdown: "markdown", mdx: "markdown",
    html: "html", htm: "html", json: "json", xml: "xml",
    yml: "yaml", yaml: "yaml", ts: "typescript", js: "javascript",
    css: "css", txt: "plaintext",
  };
  return byExt[ext] ?? "plaintext";
}

export function CodeViewer(props: CodeViewerProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-40 items-center justify-center text-muted-foreground">
          <Spinner /> <span className="ml-2 text-sm">Loading viewer…</span>
        </div>
      }
    >
      <CodeViewerCM {...props} />
    </Suspense>
  );
}
