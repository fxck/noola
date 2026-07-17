import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveApiKey } from "../apikeys.js";
import {
  scimListUsers,
  scimGetUser,
  scimProvisionUser,
  scimDeactivateUser,
  scimPatchDeactivates,
  scimListGroups,
  scimGetGroup,
  scimCreateGroup,
  scimPatchGroup,
  scimDeleteGroup,
} from "../scim.js";

// SCIM v2 provisioning endpoints (Wave 5). Auth = an api key with the 'scim' scope, sent as the IdP's
// Bearer token — resolved pre-context to the tenant (org id). SCIM errors use the RFC 7644 error
// schema. Registered as a public lane (the scope check IS the gate). Users only; no Groups yet.

const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

function scimError(reply: FastifyReply, status: number, detail: string) {
  return reply.code(status).header("content-type", "application/scim+json").send({
    schemas: [SCIM_ERROR_SCHEMA],
    detail,
    status: String(status),
  });
}

export default async function scimRoutes(app: FastifyInstance): Promise<void> {
  // Resolve the SCIM bearer → tenant. The IdP sends Authorization: Bearer <api-key>; the key must
  // carry the 'scim' scope. Returns the org id (== tenant) or writes a SCIM error and returns null.
  async function requireScim(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const resolved = await resolveApiKey(bearer);
    if (!resolved) {
      scimError(reply, 401, "invalid or missing SCIM token");
      return null;
    }
    if (!resolved.scopes.includes("scim")) {
      scimError(reply, 403, "token missing 'scim' scope");
      return null;
    }
    return resolved.tenantId;
  }

  app.get("/scim/v2/Users", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const filter = (req.query as { filter?: string } | undefined)?.filter;
    const list = await scimListUsers(orgId, filter);
    return reply.header("content-type", "application/scim+json").send(list);
  });

  app.get("/scim/v2/Users/:id", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const user = await scimGetUser(orgId, (req.params as { id: string }).id);
    if (!user) return scimError(reply, 404, "user not found");
    return reply.header("content-type", "application/scim+json").send(user);
  });

  app.post("/scim/v2/Users", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const body = (req.body ?? {}) as { userName?: string; displayName?: string; name?: { formatted?: string }; roles?: Array<{ value?: string }> };
    if (!body.userName) return scimError(reply, 400, "userName is required");
    const user = await scimProvisionUser(orgId, {
      userName: body.userName,
      displayName: body.displayName || body.name?.formatted,
      role: body.roles?.[0]?.value,
    });
    return reply.code(201).header("content-type", "application/scim+json").send(user);
  });

  // Deactivation. An IdP sends either PATCH { Operations:[{op:replace, value:{active:false}}] } or a
  // DELETE — both map to removing the workspace membership.
  app.patch("/scim/v2/Users/:id", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const id = (req.params as { id: string }).id;
    if (!scimPatchDeactivates(req.body)) {
      // We only model the active=false transition; echo the current resource for anything else.
      const user = await scimGetUser(orgId, id);
      if (!user) return scimError(reply, 404, "user not found");
      return reply.header("content-type", "application/scim+json").send(user);
    }
    const res = await scimDeactivateUser(orgId, id);
    if (!res.ok) return scimError(reply, res.status ?? 400, res.error ?? "deactivate failed");
    const user = await scimGetUser(orgId, id);
    // After removal the user is gone from the roster; report inactive per SCIM convention.
    return reply.header("content-type", "application/scim+json").send(
      user ?? { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], id, active: false, meta: { resourceType: "User" } },
    );
  });

  app.delete("/scim/v2/Users/:id", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const res = await scimDeactivateUser(orgId, (req.params as { id: string }).id);
    if (!res.ok) return scimError(reply, res.status ?? 400, res.error ?? "delete failed");
    return reply.code(204).send();
  });

  // ---- Groups (0092): IdP groups ↔ teams ------------------------------------
  app.get("/scim/v2/Groups", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const filter = (req.query as { filter?: string } | undefined)?.filter;
    const list = await scimListGroups(orgId, filter);
    return reply.header("content-type", "application/scim+json").send(list);
  });

  app.get("/scim/v2/Groups/:id", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const group = await scimGetGroup(orgId, (req.params as { id: string }).id);
    if (!group) return scimError(reply, 404, "group not found");
    return reply.header("content-type", "application/scim+json").send(group);
  });

  app.post("/scim/v2/Groups", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const body = (req.body ?? {}) as { displayName?: string; members?: Array<{ value?: string }> };
    if (!body.displayName?.trim()) return scimError(reply, 400, "displayName is required");
    const group = await scimCreateGroup(orgId, { displayName: body.displayName, members: body.members });
    if ("conflict" in group) return scimError(reply, 409, "group displayName already exists");
    return reply.code(201).header("content-type", "application/scim+json").send(group);
  });

  app.patch("/scim/v2/Groups/:id", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const group = await scimPatchGroup(orgId, (req.params as { id: string }).id, req.body);
    if (!group) return scimError(reply, 404, "group not found");
    return reply.header("content-type", "application/scim+json").send(group);
  });

  // PUT = full replace (some IdPs use it instead of PATCH): displayName + members verbatim.
  app.put("/scim/v2/Groups/:id", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { displayName?: string; members?: Array<{ value?: string }> };
    const ops = {
      Operations: [
        ...(body.displayName ? [{ op: "replace", path: "displayName", value: body.displayName }] : []),
        { op: "replace", path: "members", value: body.members ?? [] },
      ],
    };
    const group = await scimPatchGroup(orgId, id, ops);
    if (!group) return scimError(reply, 404, "group not found");
    return reply.header("content-type", "application/scim+json").send(group);
  });

  app.delete("/scim/v2/Groups/:id", async (req, reply) => {
    const orgId = await requireScim(req, reply);
    if (!orgId) return;
    const gone = await scimDeleteGroup(orgId, (req.params as { id: string }).id);
    if (!gone) return scimError(reply, 404, "group not found");
    return reply.code(204).send();
  });
}
