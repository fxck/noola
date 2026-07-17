import { api, API_URL, getToken, type ApiError } from "@/lib/api";

// Sources client — the browser side of the document-ingestion pipeline.
// A source document is uploaded as raw text; the server stores it, extracts,
// chunks, and indexes it. Tenant is server-authoritative from the session token.

export interface SourceDocument {
  id: string;
  filename: string;
  content_type: string;
  char_count: number;
  chunk_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  /** Last successful (re)ingest, for the nerd sync line — optional. */
  last_synced_at?: string | null;
  /** Most recent ingest error, if the last run failed — optional. */
  last_error?: string | null;
}

/** A retrieved passage — one chunk of a document, with its source id for citation. */
export interface ChunkHit {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
}

// The server accepts text formats only (the extractor handles plain/markdown/html).
// We map by extension first, then fall back to the browser-reported type.
const EXT_TYPE: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
};
export const ACCEPT_ATTR = ".txt,.md,.markdown,.html,.htm,text/plain,text/markdown,text/html";

export function contentTypeFor(file: File): string {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (EXT_TYPE[ext]) return EXT_TYPE[ext];
  if (file.type.startsWith("text/")) return file.type;
  return "text/plain";
}

/** The raw stored text of an uploaded document — backs the document viewer. */
export interface DocumentContent {
  filename: string;
  content_type: string;
  content: string;
}

export async function fetchDocuments(): Promise<SourceDocument[]> {
  return (await api<{ documents: SourceDocument[] }>("/documents")).documents;
}

/** A single document's metadata (backs the routed /documents/$id viewer). */
export async function fetchDocument(id: string): Promise<SourceDocument> {
  return (await api<{ document: SourceDocument }>(`/documents/${id}`)).document;
}

/** A document's raw stored text (for the viewer). Returns filename + content type + body. */
export async function fetchDocumentContent(id: string): Promise<DocumentContent> {
  return api<DocumentContent>(`/documents/${id}/content`);
}

export async function searchChunks(q: string): Promise<ChunkHit[]> {
  return (await api<{ chunks: ChunkHit[] }>(`/documents/search?q=${encodeURIComponent(q)}`)).chunks;
}

/**
 * Upload one file as a source document. Runs on XHR (not fetch) so callers can
 * observe real request-body progress via the optional `onProgress` (0–100);
 * the original single-arg signature keeps working. Errors carry the same
 * `{ status, detail }` shape as `api()` throws.
 */
export async function uploadDocument(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<SourceDocument> {
  const content = await file.text();
  const body = JSON.stringify({ filename: file.name, contentType: contentTypeFor(file), content });
  return new Promise<SourceDocument>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fail = (status: number, detail?: string) => {
      const err = new Error(`HTTP ${status}`) as ApiError;
      err.status = status;
      if (detail) err.detail = detail;
      reject(err);
    };
    xhr.open("POST", `${API_URL}/documents`);
    xhr.setRequestHeader("content-type", "application/json");
    const token = getToken();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve((JSON.parse(xhr.responseText) as { document: SourceDocument }).document);
        } catch {
          fail(xhr.status, "Malformed server response");
        }
      } else {
        let detail: string | undefined;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: unknown };
          if (typeof parsed.error === "string") detail = parsed.error;
        } catch {
          /* non-JSON error body — leave detail unset */
        }
        fail(xhr.status, detail);
      }
    };
    xhr.onerror = () => fail(0);
    xhr.send(body);
  });
}

export async function deleteDocument(id: string): Promise<void> {
  await api(`/documents/${id}`, { method: "DELETE" });
}
