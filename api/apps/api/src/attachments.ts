import { randomUUID } from "node:crypto";
import { withTenant } from "@repo/db";
import { putBuffer } from "./storage.js";

// Message attachments — the DB seam over message_attachments (migration 0061). Upload creates a
// "pending" row (message_id NULL); the reply CLAIMS the pending rows onto its message. The thread
// read hydrates each message's attachments; serving streams the bytes back through an authed route.
// Bytes live in object-storage (storage.ts); this module only touches the metadata rows.

export interface AttachmentRow {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface AttachmentServe {
  storage_key: string;
  filename: string;
  content_type: string;
}

/** Record a freshly-uploaded (pending) attachment against a ticket. Returns the public metadata. */
export async function createAttachment(
  tenantId: string,
  a: { ticketId: string; uploadedBy: string | null; filename: string; contentType: string; sizeBytes: number; storageKey: string },
): Promise<AttachmentRow> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO message_attachments (tenant_id, ticket_id, uploaded_by, filename, content_type, size_bytes, storage_key)
       VALUES (current_tenant(), $1, $2, $3, $4, $5, $6)
       RETURNING id, filename, content_type, size_bytes`,
      [a.ticketId, a.uploadedBy, a.filename, a.contentType, a.sizeBytes, a.storageKey],
    );
    return r.rows[0] as AttachmentRow;
  });
}

/** Persist inbound-channel attachments (Discord) directly onto an already-inserted message — one row
 *  per file, best-effort post-commit (mirrors the reply route's claim pattern). Phase 1 stores the
 *  source CDN url as the storage_key + filename/size so the bubble can render/link; streaming the
 *  bytes into object-storage is a noted follow-up. */
export async function persistInboundAttachments(
  tenantId: string,
  ticketId: string,
  messageId: string,
  files: { url: string; filename: string; contentType: string; size: number }[],
): Promise<void> {
  if (files.length === 0) return;
  await withTenant(tenantId, async (c) => {
    for (const f of files) {
      await c.query(
        `INSERT INTO message_attachments (tenant_id, ticket_id, message_id, uploaded_by, filename, content_type, size_bytes, storage_key)
         VALUES (current_tenant(), $1, $2, NULL, $3, $4, $5, $6)`,
        [ticketId, messageId, f.filename || "file", f.contentType || "application/octet-stream", f.size || 0, f.url],
      );
    }
  });
}

/** Store raw inbound file bytes (email attachments) as OWNED objects: putBuffer into
 *  object-storage, then a claimed row (message_id set) per file — unlike
 *  persistInboundAttachments, which passes a source CDN url through. Best-effort per file:
 *  one failed upload skips that file, the rest still land. */
export async function persistBufferAttachments(
  tenantId: string,
  ticketId: string,
  messageId: string,
  files: { filename: string; contentType: string; data: Buffer }[],
): Promise<number> {
  let stored = 0;
  for (const f of files) {
    if (!f.data?.byteLength) continue;
    const safe = (f.filename || "file").replace(/^.*[\\/]/, "").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
    const contentType = f.contentType || "application/octet-stream";
    try {
      const storageKey = `attachments/${tenantId}/${randomUUID()}-${safe}`;
      await putBuffer(storageKey, f.data, contentType);
      await withTenant(tenantId, async (c) => {
        await c.query(
          `INSERT INTO message_attachments (tenant_id, ticket_id, message_id, uploaded_by, filename, content_type, size_bytes, storage_key)
           VALUES (current_tenant(), $1, $2, NULL, $3, $4, $5, $6)`,
          [ticketId, messageId, safe, contentType, f.data.byteLength, storageKey],
        );
      });
      stored++;
    } catch {
      /* best-effort per file */
    }
  }
  return stored;
}

/** Claim pending attachments (message_id NULL) onto a message — only ones on the SAME ticket, so a
 *  caller can't attach files from another ticket. Runs post-ingest (best-effort, its own txn).
 *  Returns the claimed rows' storage info (for outbound email inclusion). */
export async function claimAttachments(
  tenantId: string,
  ticketId: string,
  messageId: string,
  ids: string[],
): Promise<AttachmentServe[]> {
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE message_attachments
          SET message_id = $2
        WHERE id = ANY($3::uuid[]) AND ticket_id = $1 AND message_id IS NULL
        RETURNING storage_key, filename, content_type`,
      [ticketId, messageId, ids],
    );
    return r.rows as AttachmentServe[];
  });
}

/** All attachments for a set of messages, grouped by message_id (for the thread read). */
export async function attachmentsForTicket(
  tenantId: string,
  ticketId: string,
): Promise<Map<string, AttachmentRow[]>> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT message_id, id, filename, content_type, size_bytes
         FROM message_attachments
        WHERE ticket_id = $1 AND message_id IS NOT NULL
        ORDER BY created_at ASC`,
      [ticketId],
    );
    const by = new Map<string, AttachmentRow[]>();
    for (const row of r.rows as (AttachmentRow & { message_id: string })[]) {
      const list = by.get(row.message_id) ?? [];
      list.push({ id: row.id, filename: row.filename, content_type: row.content_type, size_bytes: row.size_bytes });
      by.set(row.message_id, list);
    }
    return by;
  });
}

/** Storage info for serving one attachment (RLS scopes it to the caller's tenant). null if absent. */
export async function getAttachmentForServe(tenantId: string, id: string): Promise<AttachmentServe | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT storage_key, filename, content_type FROM message_attachments WHERE id = $1`,
      [id],
    );
    return r.rowCount ? (r.rows[0] as AttachmentServe) : null;
  });
}
