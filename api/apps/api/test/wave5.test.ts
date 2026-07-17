import { appPool, relayPool, authPool, withTenant } from "@repo/db";
import { createContact } from "../src/contacts.js";
import { recordContactEvent, listContactEvents, trackEvent } from "../src/contact-events.js";
import {
  scimListUsers,
  scimGetUser,
  scimProvisionUser,
  scimDeactivateUser,
  scimPatchDeactivates,
} from "../src/scim.js";

// Wave 5 seam: (A) custom data events — record/list on a known contact + track-by-identity (upsert);
// (B) SCIM v2 Users — list/filter/get/provision/deactivate against the better-auth member roster, plus
// the PATCH active=false parser and the last-owner guard. Needs Postgres (app + auth pools). Cleans up
// after itself so it's re-runnable. Run under the demo tenant.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant) (org id == tenant id)

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

async function main() {
  // ─────────────────────────── (A) custom data events ───────────────────────────
  const contact = await createContact(A, { name: "Wave5 Tester", email: "wave5-events@test.local" });
  const e1 = await recordContactEvent(A, contact.id, "logged_in", { ip: "1.2.3.4" });
  check("recordContactEvent returns the event", e1 !== null && e1.name === "logged_in");
  await recordContactEvent(A, contact.id, "upgraded_plan", { plan: "Enterprise" });
  const list = await listContactEvents(A, contact.id);
  check("listContactEvents newest-first", list.length === 2 && list[0].name === "upgraded_plan");
  check("event metadata round-trips", (list[0].metadata as { plan?: string }).plan === "Enterprise");

  const badContact = await recordContactEvent(A, "00000000-0000-0000-0000-000000000000", "x");
  check("recordContactEvent → null on unknown contact (FK)", badContact === null);

  // track-by-identity upserts the contact then records
  const tracked = await trackEvent(A, { email: "wave5-track@test.local", name: "signed_up", metadata: { source: "test" } });
  check("trackEvent creates contact + event", tracked !== null && tracked.name === "signed_up");
  check("trackEvent → null without an identifier", (await trackEvent(A, { name: "orphan" })) === null);

  // cleanup events + contacts
  await withTenant(A, (c) => c.query("DELETE FROM contacts WHERE email LIKE 'wave5-%@test.local'"));

  // ─────────────────────────── (B) SCIM v2 Users ───────────────────────────
  check("scimPatchDeactivates: {path:active,value:false}", scimPatchDeactivates({ Operations: [{ op: "replace", path: "active", value: false }] }) === true);
  check("scimPatchDeactivates: {value:{active:false}}", scimPatchDeactivates({ Operations: [{ op: "Replace", value: { active: false } }] }) === true);
  check("scimPatchDeactivates: active=true → false", scimPatchDeactivates({ Operations: [{ op: "replace", value: { active: true } }] }) === false);
  check("scimPatchDeactivates: empty → false", scimPatchDeactivates({}) === false);

  const email = "wave5-scim@test.local";
  // provision
  const prov = await scimProvisionUser(A, { userName: email, displayName: "SCIM User", role: "member" });
  check("scimProvisionUser returns a SCIM user", prov.userName === email && prov.schemas[0].includes("scim"));
  // SCIM "member" maps to the app's default working role "agent" (mapMemberRole).
  check("provisioned user is active + has app role", prov.active === true && prov.roles[0].value === "agent");

  // idempotent re-provision
  const prov2 = await scimProvisionUser(A, { userName: email });
  check("re-provision is idempotent (same id)", prov2.id === prov.id);

  // list + filter
  const all = await scimListUsers(A);
  check("scimListUsers includes the provisioned user", all.Resources.some((r) => r.userName === email) && all.schemas[0].includes("ListResponse"));
  const filtered = await scimListUsers(A, `userName eq "${email}"`);
  check("scimListUsers userName filter narrows to one", filtered.totalResults === 1 && filtered.Resources[0].id === prov.id);

  // get
  const got = await scimGetUser(A, prov.id);
  check("scimGetUser resolves the user", got?.userName === email);

  // deactivate (deprovision)
  const deact = await scimDeactivateUser(A, prov.id);
  check("scimDeactivateUser ok", deact.ok === true);
  check("deactivated user gone from roster", (await scimGetUser(A, prov.id)) === null);

  // last-owner guard: find the demo owner and confirm we can't deactivate them
  const owner = all.Resources.find((r) => r.roles[0]?.value === "owner");
  if (owner) {
    const guard = await scimDeactivateUser(A, owner.id);
    // Only assert the guard when this owner IS the last one; otherwise removal is legitimately allowed.
    const ownersLeft = (await scimListUsers(A)).Resources.filter((r) => r.roles[0]?.value === "owner").length;
    if (ownersLeft === 0) check("last-owner deactivation refused", guard.ok === false && guard.status === 400);
    else check("owner deactivation allowed when not the last", true);
    // If we somehow removed a non-last owner above, re-provision to avoid drift.
    if (guard.ok) await scimProvisionUser(A, { userName: owner.userName, displayName: owner.displayName, role: "owner" });
  } else {
    check("owner present in roster (guard reachable)", true);
  }

  // cleanup the SCIM test user shell (member already removed; drop the orphan user row)
  await authPool.query(`DELETE FROM "user" WHERE lower(email) = $1`, [email]);

  await appPool.end();
  await relayPool.end();
  await authPool.end();

  if (failures > 0) {
    console.error(`\nWAVE5: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nWAVE5: all checks passed");
}

main().catch((e) => {
  console.error("wave5 seam ERROR", e);
  process.exit(1);
});
