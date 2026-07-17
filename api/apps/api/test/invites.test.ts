import pg from "pg";
import { appPool, relayPool, authPool } from "@repo/db";
import {
  betterAuthSignup,
  createEmailInvite,
  cancelEmailInvite,
  changeMemberRole,
  removeMemberByUser,
  betterAuthAcceptInvite,
  betterAuthJoinViaLink,
} from "../src/betterauth.js";
import { listMembers } from "../src/members.js";
import { getInvitePublic, listPendingInvites, createInviteLink, validateLink, getLinkPublic } from "../src/invites.js";

// Invites + member-management seam (D1 + D2), end to end against the shared DB:
//   • email invite: create → public landing → accept (new account) → reverse-projected member;
//   • link invite: mint → validate → join (new account) → reverse-projected member + uses++;
//   • member mgmt: role change re-projects the mapped role; last-owner guard blocks demote/remove;
//   • single-org (§9.5a): a member of another workspace can't join a second one.
// Needs Postgres + auth_user creds. SMTP not required (sendAuthEmail no-ops/­best-effort).

const OWNER = "invtest-owner@invtest.local";
const INVITEE = "invtest-invitee@invtest.local";
const JOINER = "invtest-joiner@invtest.local";
const OWNER2 = "invtest-owner2@invtest.local";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query(`DELETE FROM org_invite_link WHERE organization_id IN (SELECT id FROM "organization" WHERE name LIKE 'INVTEST %')`);
    await superPool.query(`DELETE FROM "organization" WHERE name LIKE 'INVTEST %'`);
    await superPool.query(`DELETE FROM "user" WHERE email LIKE 'invtest-%@invtest.local'`);
    await superPool.query(`DELETE FROM users WHERE email LIKE 'invtest-%@invtest.local'`);
    await superPool.query(`DELETE FROM tenants WHERE name LIKE 'INVTEST %'`);
  };
  const bail = async () => { await clean(); await superPool.end(); await appPool.end(); await relayPool.end(); await authPool.end(); process.exit(1); };
  await clean();

  // ---- owner + workspace ----
  const owner = await betterAuthSignup(OWNER, "ownerpass123", "INV Owner", "INVTEST Org One");
  if (!owner.ok) { console.error("owner signup failed", owner); await bail(); return; }
  const orgId = owner.user.tenantId;
  const bearer = `Bearer ${owner.token}`;

  // ==== D1: email invitation ====
  const inv = await createEmailInvite(bearer, orgId, INVITEE, "agent");
  check("createEmailInvite succeeds", inv.ok === true);
  if (!inv.ok) { await bail(); return; }
  check("invitation lands pending in the org", (await listPendingInvites(orgId)).some((i) => i.email === INVITEE && i.status === "pending"));
  const pub = await getInvitePublic(inv.invitation.id);
  check("public invite landing resolves org + email", pub?.email === INVITEE && pub?.orgName === "INVTEST Org One" && pub?.organizationId === orgId);

  // accept — creates the invitee account (no own org) and joins the inviter's org
  const acc = await betterAuthAcceptInvite(inv.invitation.id, "inviteepass123", "INV Invitee");
  check("accept succeeds, invitee lands in the inviter's tenant as agent", acc.ok === true && acc.ok && acc.user.tenantId === orgId && acc.user.role === "agent");
  if (!acc.ok) { await bail(); return; }
  const inviteeUserId = acc.user.id;
  const roster1 = await listMembers(orgId);
  check("roster now has owner + invitee", roster1.length === 2 && roster1.some((m) => m.email === OWNER && m.role === "owner") && roster1.some((m) => m.email === INVITEE));
  const projU = await superPool.query("SELECT role FROM users WHERE tenant_id = $1 AND id = $2", [orgId, inviteeUserId]);
  check("invitee was reverse-projected into the app users roster", projU.rows[0]?.role === "agent");

  // ==== member management ====
  const promote = await changeMemberRole(bearer, orgId, inviteeUserId, "admin");
  check("owner promotes invitee to admin", promote.ok === true);
  const projU2 = await superPool.query("SELECT role FROM users WHERE tenant_id = $1 AND id = $2", [orgId, inviteeUserId]);
  check("role change re-projected into the app roster (agent→admin)", projU2.rows[0]?.role === "admin");

  const demoteOwner = await changeMemberRole(bearer, orgId, owner.user.id, "agent");
  check("last-owner demote is blocked", demoteOwner.ok === false && !demoteOwner.ok && demoteOwner.status === 400);
  const removeOwner = await removeMemberByUser(bearer, orgId, owner.user.id);
  check("last-owner removal is blocked", removeOwner.ok === false && !removeOwner.ok && removeOwner.status === 400);

  const rm = await removeMemberByUser(bearer, orgId, inviteeUserId);
  check("owner removes the invitee", rm.ok === true);
  const projU3 = await superPool.query("SELECT 1 FROM users WHERE tenant_id = $1 AND id = $2", [orgId, inviteeUserId]);
  check("removed member is unprojected from the app roster", projU3.rowCount === 0);

  const cancelInv = await createEmailInvite(bearer, orgId, "invtest-cancel@invtest.local", "viewer");
  check("second invite for cancel test created", cancelInv.ok === true);
  if (cancelInv.ok) {
    const cx = await cancelEmailInvite(bearer, cancelInv.invitation.id);
    check("cancel invitation succeeds", cx.ok === true);
    check("cancelled invite no longer pending", !(await listPendingInvites(orgId)).some((i) => i.id === cancelInv.invitation.id));
  }

  // ==== D2: shareable link ====
  const link = await createInviteLink(orgId, owner.user.id, { role: "viewer", maxUses: 5 });
  check("createInviteLink mints an enabled viewer link", link.enabled && link.role === "viewer" && link.maxUses === 5);
  const landing = await getLinkPublic(link.token);
  check("public link landing resolves org + valid", landing?.orgName === "INVTEST Org One" && landing?.valid === true);
  const v = await validateLink(link.token, JOINER);
  check("validateLink accepts a joiner", v.ok === true && v.ok && v.orgId === orgId);

  const join = await betterAuthJoinViaLink(link.token, JOINER, "joinerpass123", "INV Joiner");
  check("join via link succeeds as viewer in the org", join.ok === true && join.ok && join.user.tenantId === orgId && join.user.role === "viewer");
  if (join.ok) {
    const projJ = await superPool.query("SELECT role FROM users WHERE tenant_id = $1 AND id = $2", [orgId, join.user.id]);
    check("joiner reverse-projected into the app roster (viewer)", projJ.rows[0]?.role === "viewer");
  }
  const uses = await superPool.query("SELECT uses FROM org_invite_link WHERE token = $1", [link.token]);
  check("link uses incremented on redemption", uses.rows[0]?.uses === 1);

  // ==== single-org guard on the link path (§9.5a) ====
  const owner2 = await betterAuthSignup(OWNER2, "owner2pass123", "INV Owner Two", "INVTEST Org Two");
  check("second owner/workspace created", owner2.ok === true);
  if (owner2.ok) {
    const cross = await betterAuthJoinViaLink(link.token, OWNER2, "owner2pass123", "INV Owner Two");
    check("a member of another workspace cannot join via link (multi-org blocked 409)", cross.ok === false && !cross.ok && cross.status === 409);
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  await authPool.end();

  if (failures > 0) { console.error(`\nINVITES: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nINVITES: all checks green");
}

main().catch((e) => { console.error("invites seam ERROR", e); process.exit(1); });
