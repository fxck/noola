import { randomUUID } from "node:crypto";
import { authPool } from "@repo/db";
import { listMembers, resolveMember, countOwners } from "./members.js";
import { listTeams, getTeam, createTeam, updateTeam, deleteTeam, DuplicateTeamError, type Team } from "./teams.js";
import { projectMember, unprojectMember, mapMemberRole } from "./projection.js";

// Wave 5: SCIM v2 (RFC 7644) — the Users subset an identity provider (Okta/Azure AD/OneLogin) uses to
// auto-provision and deprovision workspace members. Backed by the better-auth member roster; token-
// gated via an api-key 'scim' scope (the bearer the IdP sends). Service-level (no user session), so it
// writes the member tables directly — the same direct-authPool pattern as invite-link redemption. A
// provisioned user authenticates via SSO (no password account); membership IS the provisioning unit.
// Honest subset: Users (list/filter/get/create/deactivate) + Groups (0092: list/filter/get/
// create/patch-members/replace/delete) mapped onto teams — a provisioned group IS a team, its
// members are team_members. Nested-group semantics aren't modeled.

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

export interface ScimUser {
  schemas: string[];
  id: string;
  userName: string;
  name: { formatted: string };
  displayName: string;
  active: boolean;
  emails: { value: string; primary: boolean }[];
  roles: { value: string }[];
  meta: { resourceType: "User" };
}

export interface ScimListResponse {
  schemas: string[];
  totalResults: number;
  itemsPerPage: number;
  startIndex: number;
  Resources: ScimUser[];
}

function toScim(m: { userId: string; email: string; name: string; role: string }): ScimUser {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: m.userId,
    userName: m.email,
    name: { formatted: m.name || m.email },
    displayName: m.name || m.email,
    active: true,
    emails: [{ value: m.email, primary: true }],
    roles: [{ value: m.role }],
    meta: { resourceType: "User" },
  };
}

/** List members as SCIM users. Supports the common `userName eq "x"` dedup filter IdPs send before
 *  a create; other filters are ignored (returns the full roster). */
export async function scimListUsers(orgId: string, filter?: string): Promise<ScimListResponse> {
  const members = await listMembers(orgId);
  let resources = members.map(toScim);
  const m = filter?.match(/userName\s+eq\s+"([^"]+)"/i);
  if (m) {
    const email = m[1].toLowerCase();
    resources = resources.filter((r) => r.userName.toLowerCase() === email);
  }
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: resources.length,
    itemsPerPage: resources.length,
    startIndex: 1,
    Resources: resources,
  };
}

export async function scimGetUser(orgId: string, userId: string): Promise<ScimUser | null> {
  const m = (await listMembers(orgId)).find((x) => x.userId === userId);
  return m ? toScim(m) : null;
}

/**
 * Provision a user: find-or-create the better-auth user by email, then ensure org membership +
 * its app-side projection. Idempotent — a repeat call for an existing member is a no-op returning
 * the same resource (the IdP re-syncs freely).
 */
export async function scimProvisionUser(
  orgId: string,
  input: { userName: string; displayName?: string; role?: string },
): Promise<ScimUser> {
  const email = input.userName.trim().toLowerCase();
  const name = input.displayName?.trim() || email;
  const role = mapMemberRole(input.role || "member");

  const ex = await authPool.query(`SELECT id FROM "user" WHERE lower(email) = $1 LIMIT 1`, [email]);
  let userId: string;
  if (ex.rowCount) {
    userId = ex.rows[0].id as string;
  } else {
    userId = randomUUID();
    await authPool.query(
      `INSERT INTO "user"(id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, true, now(), now())`,
      [userId, name, email],
    );
  }
  await authPool.query(
    `INSERT INTO "member"(id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, $4, now())
     ON CONFLICT ("organizationId", "userId") DO NOTHING`,
    [randomUUID(), orgId, userId, role],
  );
  await projectMember(orgId, userId, email, name, role);
  return toScim({ userId, email, name, role });
}

/**
 * Deprovision a user: remove the org membership + its projection (the assignee FK is ON DELETE SET
 * NULL, so their tickets are simply unassigned). Guards the last owner. This is what an IdP's
 * "deactivate" (PATCH active=false) or DELETE maps to — the user loses workspace access.
 */
export async function scimDeactivateUser(
  orgId: string,
  userId: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const m = await resolveMember(orgId, userId);
  if (!m) return { ok: false, status: 404, error: "user not found" };
  if (m.role === "owner" && (await countOwners(orgId)) <= 1) {
    return { ok: false, status: 400, error: "cannot deactivate the last owner" };
  }
  await authPool.query(`DELETE FROM "member" WHERE "organizationId" = $1 AND "userId" = $2`, [orgId, userId]);
  await unprojectMember(orgId, userId);
  return { ok: true };
}

/** Whether a SCIM PATCH body sets active=false (the deprovision signal). RFC 7644 §3.5.2 Operations. */
export function scimPatchDeactivates(body: unknown): boolean {
  const b = body as { Operations?: Array<{ op?: string; path?: string; value?: unknown }> } | undefined;
  for (const op of b?.Operations ?? []) {
    const isReplace = (op.op ?? "").toLowerCase() === "replace";
    if (!isReplace) continue;
    // { path: "active", value: false } OR { value: { active: false } }
    if (op.path === "active" && op.value === false) return true;
    const v = op.value as { active?: unknown } | undefined;
    if (v && typeof v === "object" && v.active === false) return true;
  }
  return false;
}

// ---- Groups (0092) — SCIM Groups mapped onto teams ---------------------------

const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

export interface ScimGroup {
  schemas: string[];
  id: string;
  displayName: string;
  members: { value: string; display?: string }[];
  meta: { resourceType: "Group" };
}

function toScimGroup(t: Team, names: Map<string, string>): ScimGroup {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: t.id,
    displayName: t.name,
    members: t.memberIds.map((id) => ({ value: id, ...(names.has(id) ? { display: names.get(id) } : {}) })),
    meta: { resourceType: "Group" },
  };
}

async function memberNames(orgId: string): Promise<Map<string, string>> {
  const roster = await listMembers(orgId);
  return new Map(roster.map((m) => [m.userId, m.name || m.email]));
}

export async function scimListGroups(orgId: string, filter?: string): Promise<ScimListResponse> {
  const names = await memberNames(orgId);
  let resources = (await listTeams(orgId)).map((t) => toScimGroup(t, names));
  const m = filter?.match(/displayName\s+eq\s+"([^"]+)"/i);
  if (m) {
    const want = m[1].toLowerCase();
    resources = resources.filter((g) => g.displayName.toLowerCase() === want);
  }
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: resources.length,
    itemsPerPage: resources.length,
    startIndex: 1,
    Resources: resources as unknown as ScimUser[],
  };
}

export async function scimGetGroup(orgId: string, id: string): Promise<ScimGroup | null> {
  const t = await getTeam(orgId, id).catch(() => null);
  return t ? toScimGroup(t, await memberNames(orgId)) : null;
}

/** Only ids that are actually workspace members make it onto the team — an IdP syncing a
 *  group faster than its users provisions simply converges on the next sync. */
async function validMemberIds(orgId: string, ids: string[]): Promise<string[]> {
  const roster = new Set((await listMembers(orgId)).map((m) => m.userId));
  return [...new Set(ids)].filter((id) => roster.has(id));
}

export async function scimCreateGroup(
  orgId: string,
  input: { displayName: string; members?: { value?: string }[] },
): Promise<ScimGroup | { conflict: true }> {
  const memberIds = await validMemberIds(orgId, (input.members ?? []).map((m) => m.value ?? "").filter(Boolean));
  try {
    const t = await createTeam(orgId, { name: input.displayName.trim(), memberIds });
    return toScimGroup(t, await memberNames(orgId));
  } catch (e) {
    if (e instanceof DuplicateTeamError) return { conflict: true };
    throw e;
  }
}

export async function scimDeleteGroup(orgId: string, id: string): Promise<boolean> {
  return deleteTeam(orgId, id);
}

/** RFC 7644 §3.5.2 PATCH on a Group: displayName replace + members add/remove/replace.
 *  Anything else is ignored (echo semantics, same posture as the Users PATCH). */
export async function scimPatchGroup(orgId: string, id: string, body: unknown): Promise<ScimGroup | null> {
  const t = await getTeam(orgId, id).catch(() => null);
  if (!t) return null;
  let name: string | undefined;
  let members = [...t.memberIds];
  const ops = (body as { Operations?: Array<{ op?: string; path?: string; value?: unknown }> } | undefined)?.Operations ?? [];
  for (const op of ops) {
    const kind = (op.op ?? "").toLowerCase();
    const path = (op.path ?? "").trim();
    const values = Array.isArray(op.value) ? (op.value as { value?: string }[]) : [];
    if (kind === "replace" && (!path || path === "displayName")) {
      const v = op.value as { displayName?: string } | string | undefined;
      if (typeof v === "string" && path === "displayName") name = v;
      else if (v && typeof v === "object" && typeof v.displayName === "string") name = v.displayName;
      if (!path && v && typeof v === "object" && Array.isArray((v as { members?: unknown }).members)) {
        members = ((v as { members: { value?: string }[] }).members).map((m) => m.value ?? "").filter(Boolean);
      }
    }
    if (path === "members") {
      const ids = values.map((m) => m.value ?? "").filter(Boolean);
      if (kind === "replace") members = ids;
      if (kind === "add") members = [...new Set([...members, ...ids])];
      if (kind === "remove") members = members.filter((m) => !ids.includes(m));
    }
    // remove with a value filter: members[value eq "id"]
    const filterMatch = /^members\[value\s+eq\s+"([^"]+)"\]$/i.exec(path);
    if (kind === "remove" && filterMatch) members = members.filter((m) => m !== filterMatch[1]);
  }
  const memberIds = await validMemberIds(orgId, members);
  const updated = await updateTeam(orgId, id, { ...(name ? { name: name.trim() } : {}), memberIds });
  return updated ? toScimGroup(updated, await memberNames(orgId)) : null;
}
