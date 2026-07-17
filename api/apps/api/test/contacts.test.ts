import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  createContact,
  getContact,
  listContacts,
  updateContact,
  deleteContact,
  upsertContact,
  bulkUpsertContacts,
  contactHistory,
} from "../src/contacts.js";

// Contacts directory + sync seam: CRUD, filtered listing, idempotent upsert on
// external_id / email (attributes shallow-merge), bulk import counts, ticket-history
// linkage (email channel), and tenant isolation. Needs Postgres only.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex

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
    await superPool.query("DELETE FROM contacts WHERE external_id LIKE 'ctest%' OR email LIKE 'ctest%'");
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'ctest%'");
  };
  await clean();

  // ---- create + get ----
  const c1 = await createContact(A, {
    external_id: "ctest-acme-1", email: "ctest-alice@acme.example", name: "Alice Zephyr",
    company: "Acme Corp", attributes: { plan: "pro", region: "eu" },
  });
  check("createContact returns a row with an id", typeof c1.id === "string" && c1.id.length > 0);
  check("create persists name/company/attributes", c1.name === "Alice Zephyr" && c1.company === "Acme Corp" && (c1.attributes as any).plan === "pro");
  const got = await getContact(A, c1.id);
  check("getContact returns the created contact", got?.id === c1.id && got?.email === "ctest-alice@acme.example");

  await createContact(A, { external_id: "ctest-acme-2", name: "Bob Quokka", company: "Globex Ltd", attributes: { plan: "free" } });
  await createContact(A, { external_id: "ctest-acme-3", email: "ctest-carol@acme.example", name: "Carol Acme", company: "Acme Corp", attributes: { plan: "pro" } });

  // ---- list: q (name/email/company ILIKE) ----
  {
    const { contacts, total } = await listContacts(A, { q: "zephyr" });
    check("list q matches name (ILIKE)", contacts.length === 1 && contacts[0].name === "Alice Zephyr" && total === 1);
  }
  // ---- list: company exact ----
  {
    const { contacts } = await listContacts(A, { company: "Acme Corp" });
    check("list company exact returns only Acme Corp", contacts.length === 2 && contacts.every((c) => c.company === "Acme Corp"));
  }
  // ---- list: attribute filter ----
  {
    // Assert the semantic (both seeded pro contacts hit, every hit is pro) rather than an
    // exact count — the shared dev DB holds other suites' plan=pro leftovers.
    const { contacts } = await listContacts(A, { attrKey: "plan", attrValue: "pro" });
    const ext = new Set(contacts.map((c) => c.external_id));
    check("list attrKey+attrValue filters on attributes->>key",
      ext.has("ctest-acme-1") && ext.has("ctest-acme-3") && contacts.every((c) => (c.attributes as any).plan === "pro"));
    const exists = await listContacts(A, { attrKey: "region" });
    // attrKey-alone means "has the key" — assert the semantic (every hit carries region, and
    // our seeded contact is among them) rather than an exact count, so the check survives a
    // shared dev DB that already holds other region-tagged contacts.
    check("list attrKey alone = key exists", exists.contacts.some((c) => c.name === "Alice Zephyr") && exists.contacts.every((c) => Object.prototype.hasOwnProperty.call(c.attributes, "region")));
  }

  // ---- filter-builder ops: ends_with / not_contains + LIKE-metachar escaping ----
  {
    const ends = await listContacts(A, { conditions: [{ field: "email", op: "ends_with", value: "@acme.example" }] });
    check("ends_with matches the suffix", ends.contacts.length === 2 && ends.contacts.every((c) => c.email?.endsWith("@acme.example")));
    const notC = await listContacts(A, { conditions: [{ field: "company", op: "not_contains", value: "Globex" }] });
    check("not_contains excludes matching rows", notC.contacts.every((c) => !c.company.includes("Globex")) && notC.contacts.some((c) => c.name === "Alice Zephyr"));
    // LIKE metacharacters in the value are matched literally, not as wildcards.
    await createContact(A, { external_id: "ctest-pct", name: "Pct", company: "100% Cotton" });
    const pct = await listContacts(A, { conditions: [{ field: "company", op: "contains", value: "100%" }] });
    check("contains escapes LIKE metachars (literal %)", pct.contacts.some((c) => c.name === "Pct"));
    const noPct = await listContacts(A, { conditions: [{ field: "company", op: "contains", value: "100x" }] });
    check("escaped % is not treated as a wildcard", !noPct.contacts.some((c) => c.name === "Pct"));
  }

  // ---- upsert idempotency on external_id (merge) ----
  {
    const first = await upsertContact(A, { external_id: "ctest-up-1", name: "Dana", company: "UpCo", attributes: { a: 1 } });
    check("upsert new external_id → created", first.created === true && first.contact.name === "Dana");
    const second = await upsertContact(A, { external_id: "ctest-up-1", attributes: { b: 2 } });
    check("upsert same external_id → updated (not created)", second.created === false);
    check("upsert unprovided fields keep their value", second.contact.name === "Dana" && second.contact.company === "UpCo");
    check("upsert attributes shallow-merge (both keys present)", (second.contact.attributes as any).a === 1 && (second.contact.attributes as any).b === 2);
    const third = await upsertContact(A, { external_id: "ctest-up-1", name: "Dana Prime" });
    check("upsert provided scalar overwrites", third.created === false && third.contact.name === "Dana Prime");
    const cnt = await superPool.query("SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND external_id = 'ctest-up-1'", [A]);
    check("upsert on external_id keeps exactly ONE row", cnt.rows[0].n === 1);
  }

  // ---- upsert email-conflict (case-insensitive) ----
  {
    const e1 = await upsertContact(A, { email: "ctest-erin@x.com", name: "Erin" });
    check("upsert new email → created", e1.created === true);
    const e2 = await upsertContact(A, { email: "CTEST-Erin@x.com", company: "Ericorp" });
    check("upsert same email (different case) → updated", e2.created === false && e2.contact.company === "Ericorp");
    check("email-conflict update keeps prior name", e2.contact.name === "Erin");
    const cnt = await superPool.query("SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND lower(email) = 'ctest-erin@x.com'", [A]);
    check("upsert on email keeps exactly ONE row", cnt.rows[0].n === 1);
  }

  // ---- bulk import (mix of new + existing) ----
  {
    const res = await bulkUpsertContacts(A, [
      { external_id: "ctest-up-1", company: "Bulk Updated" }, // existing → update
      { email: "ctest-erin@x.com", name: "Erin Bulk" }, // existing email → update
      { external_id: "ctest-bulk-new-1", name: "Fresh One" }, // new
      { external_id: "ctest-bulk-new-2", name: "Fresh Two", attributes: { z: 9 } }, // new
    ]);
    check("bulk counts created vs updated", res.created === 2 && res.updated === 2);
    const upd = await getContact(A, (await listContacts(A, { q: "Bulk Updated" })).contacts[0].id);
    check("bulk update took effect", upd?.company === "Bulk Updated");
  }

  // ---- update (partial) + delete ----
  {
    const u = await updateContact(A, c1.id, { company: "Renamed Inc" });
    check("updateContact patches only provided fields", u?.company === "Renamed Inc" && u?.name === "Alice Zephyr");
    const missing = await updateContact(A, "00000000-0000-0000-0000-000000000000", { name: "x" });
    check("updateContact of a missing id → null", missing === null);
    const tmp = await createContact(A, { external_id: "ctest-del-1", name: "Delete Me" });
    check("deleteContact own → true", (await deleteContact(A, tmp.id)) === true);
    check("deleted contact get → null", (await getContact(A, tmp.id)) === null);
  }

  // ---- history: link contact ↔ tickets via tickets.contact_id (omnichannel, 0062) ----
  {
    const hc = await createContact(A, { external_id: "ctest-hist-1", email: "ctest-history@acme.example", name: "History Person" });
    const t = await superPool.query(
      "INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, contact_id) VALUES ($1,$2,'email',$3,$4) RETURNING id",
      [A, "Billing question", "ctest-history@acme.example", hc.id],
    );
    const ticketId = t.rows[0].id;
    await superPool.query("INSERT INTO messages (tenant_id, ticket_id, author_type, body, created_at) VALUES ($1,$2,'customer',$3, now() - interval '1 minute')", [A, ticketId, "first message"]);
    await superPool.query("INSERT INTO messages (tenant_id, ticket_id, author_type, body) VALUES ($1,$2,'agent',$3)", [A, ticketId, "latest reply"]);
    const hist = await contactHistory(A, hc.id);
    check("history returns the contact's ticket (contact_id linkage)", hist.tickets.length === 1 && hist.tickets[0].id === ticketId);
    check("history includes the latest message per ticket", hist.tickets[0].last_message_body === "latest reply");
    // A ticket never resolved to this contact → no linkage.
    const unlinked = await createContact(A, { external_id: "ctest-noemail", name: "No Email" });
    check("history for an unlinked contact is empty", (await contactHistory(A, unlinked.id)).tickets.length === 0);
  }

  // ---- tenant isolation ----
  {
    const iso = await createContact(A, { external_id: "ctest-iso", email: "ctest-iso@acme.example", name: "Isolated" });
    check("B cannot getContact A's row", (await getContact(B, iso.id)) === null);
    const bList = await listContacts(B, { q: "Isolated" });
    check("B's list never sees A's contact", bList.contacts.length === 0);
    // Same external_id in B is a DIFFERENT row (per-tenant unique) → a fresh insert.
    const bUp = await upsertContact(B, { external_id: "ctest-iso", name: "B's Own" });
    check("same external_id in another tenant → created (not a cross-tenant update)", bUp.created === true && bUp.contact.id !== iso.id);
    check("B cannot delete A's contact", (await deleteContact(B, iso.id)) === false);
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nCONTACTS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nCONTACTS: all checks green");
}

main().catch((e) => { console.error("contacts seam ERROR", e); process.exit(1); });
