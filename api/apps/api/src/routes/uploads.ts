import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { withTenant } from "@repo/db";
import { tenanted } from "../http/tenant.js";
import { putBuffer, getObject } from "../storage.js";
import { createAttachment, getAttachmentForServe } from "../attachments.js";

// Avatar uploads for people (contacts) and the signed-in account. The browser sends a small,
// client-resized image as a base64 data URL; the API stores the bytes in object-storage and
// records an API-relative serve path (/avatar/<uuid>.<ext>) on the contact or the user. Serving
// is a PUBLIC GET (an <img> can't carry a Bearer) scoped to the avatar keyspace, uuid-named so a
// key isn't guessable and can't traverse into other objects.

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2MB — the client resizes to well under this.

// Message attachments are larger, arbitrary files — capped, and sent as a base64 data URL like the
// avatar path (server-mediated, so it works regardless of storage browser-reachability). The route
// bodyLimit is raised to fit a base64-encoded file (~1.35× the raw bytes) plus the JSON envelope.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB raw
const ATTACHMENT_BODY_LIMIT = 26 * 1024 * 1024; // base64 + envelope headroom
const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/i;

export default async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  // ---- Upload an avatar (authed) — own account, or a contact via contactId ----
  app.post(
    "/uploads/avatar",
    tenanted(async (tenantId, req, reply) => {
      const userId = req.session?.userId;
      if (!userId) return reply.code(401).send({ error: "unauthorized" });
      const body = (req.body ?? {}) as { image?: string; contactId?: string };
      const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(body.image ?? "");
      if (!m) return reply.code(400).send({ error: "image must be a base64 data URL" });
      const contentType = m[1].toLowerCase();
      const ext = MIME_EXT[contentType];
      if (!ext) return reply.code(400).send({ error: "unsupported image type" });
      const bytes = Buffer.from(m[2], "base64");
      if (bytes.byteLength === 0) return reply.code(400).send({ error: "empty image" });
      if (bytes.byteLength > MAX_AVATAR_BYTES) return reply.code(413).send({ error: "image too large" });

      const name = `${randomUUID()}.${ext}`;
      await putBuffer(`avatars/${name}`, bytes, contentType);
      const avatarUrl = `/avatar/${name}`;

      if (body.contactId) {
        const ok = await withTenant(tenantId, async (c) => {
          const r = await c.query(`UPDATE contacts SET avatar_url = $2, updated_at = now() WHERE id = $1`, [
            body.contactId,
            avatarUrl,
          ]);
          return (r.rowCount ?? 0) > 0;
        });
        if (!ok) return reply.code(404).send({ error: "contact not found" });
      } else {
        await withTenant(tenantId, async (c) => {
          await c.query(`UPDATE users SET avatar_url = $2 WHERE id = $1`, [userId, avatarUrl]);
        });
      }
      return { avatarUrl };
    }),
  );

  // ---- Upload a message attachment (authed) — pending until a reply claims it --
  app.post(
    "/uploads/attachment",
    { bodyLimit: ATTACHMENT_BODY_LIMIT },
    tenanted(async (tenantId, req, reply) => {
      const userId = req.session?.userId ?? null;
      const body = (req.body ?? {}) as { file?: string; filename?: string; ticketId?: string };
      if (!body.ticketId) return reply.code(400).send({ error: "ticketId is required" });
      const m = DATA_URL.exec(body.file ?? "");
      if (!m) return reply.code(400).send({ error: "file must be a base64 data URL" });
      const contentType = m[1].toLowerCase();
      const bytes = Buffer.from(m[2], "base64");
      if (bytes.byteLength === 0) return reply.code(400).send({ error: "empty file" });
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: "file too large (max 15MB)" });

      // Keep only a safe basename — no path separators, bounded length.
      const safe = (body.filename ?? "file").replace(/^.*[\\/]/, "").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
      const storageKey = `attachments/${tenantId}/${randomUUID()}-${safe}`;
      await putBuffer(storageKey, bytes, contentType);

      try {
        const row = await createAttachment(tenantId, {
          ticketId: body.ticketId,
          uploadedBy: userId,
          filename: safe,
          contentType,
          sizeBytes: bytes.byteLength,
          storageKey,
        });
        return { attachment: row };
      } catch (err) {
        // A bad ticketId trips the composite FK — surface it as a 404 rather than a 500.
        if ((err as { code?: string }).code === "23503") return reply.code(404).send({ error: "ticket not found" });
        throw err;
      }
    }),
  );

  // ---- Serve a message attachment (authed; tenant-scoped) ---------------------
  // Served as an attachment download (never inline) so an uploaded HTML/SVG can't execute in-origin.
  app.get(
    "/attachments/:id/download",
    tenanted(async (tenantId, req, reply) => {
      const { id } = req.params as { id: string };
      const meta = await getAttachmentForServe(tenantId, id);
      if (!meta) return reply.code(404).send({ error: "not found" });
      const obj = await getObject(meta.storage_key);
      if (!obj) return reply.code(404).send({ error: "not found" });
      return reply
        .type(meta.content_type || obj.contentType)
        .header("content-disposition", `attachment; filename="${meta.filename.replace(/"/g, "")}"`)
        .send(obj.body);
    }),
  );

  // ---- Serve an avatar (public; scoped + traversal-proof) ---------------------
  app.get("/avatar/*", async (req, reply) => {
    const rel = (req.params as { "*"?: string })["*"] ?? "";
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/i.test(rel)) {
      return reply.code(404).send({ error: "not found" });
    }
    const obj = await getObject(`avatars/${rel}`);
    if (!obj) return reply.code(404).send({ error: "not found" });
    return reply
      .type(obj.contentType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(obj.body);
  });
}
