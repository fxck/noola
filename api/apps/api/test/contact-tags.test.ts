import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  createContact, getContact, listContacts, updateContact, bulkUpsertContacts,
  normalizeTags, tagContacts, tagContactsByIdentity, existingRowIndexes, listContactTags, upsertContactsWithoutEmail,
} from "../src/contacts.js";
import { publicUpsertContact } from "../src/public-contacts.js";
import { parseCsvContacts } from "../src/csv-import.js";
import { previewSegment } from "../src/broadcasts.js";

// Contact tags seam (0123): normalization, bulk add/remove, the event-import flow (new people are
// created + tagged, existing people keep their details and only gain the tag), the tag filter in
// the directory and in broadcast audiences, tag counts. Mirrors the /contacts/import route's steps.
// Needs Postgres only.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

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
  const clean = () => superPool.query("DELETE FROM contacts WHERE email LIKE 'ctag-%' OR external_id LIKE 'ctag-%' OR name LIKE 'Ctag %'");
  await clean();

  check("normalizeTags trims, collapses, dedupes case-insensitively, sorts",
    JSON.stringify(normalizeTags(["  DevConf  2026 ", "devconf 2026", "", "VIP", 5])) === JSON.stringify(["DevConf 2026", "VIP"]));

  // ---- CSV parsing of real-world exports ----
  {
    const ok = (csv: string) => { const r = parseCsvContacts(csv); if ("error" in r) throw new Error(r.error); return r; };
    const semi = ok("email;name;company\nctag-a@x.example;A;ACME");
    check("semicolon-delimited CSV (Czech Excel)", semi.rows.length === 1 && semi.rows[0].name === "A" && semi.rows[0].company === "ACME");
    const bom = ok("\uFEFFemail,name\nctag-b@x.example,B");
    check("BOM stripped", bom.rows[0]?.email === "ctag-b@x.example");
    const cz = ok("E-mail;Jméno;Příjmení;Firma;Telefon\nctag-c@x.example;Jan;Novák;ACME;+420 777");
    check("Czech headers map to email/name/company, others to attributes",
      cz.rows[0].name === "Jan Novák" && cz.rows[0].company === "ACME" && (cz.rows[0].attributes as Record<string, unknown>)?.Telefon === "+420 777");
    check("'Email address' header", ok("Email address,Name\nctag-d@x.example,D").rows.length === 1);
    const mixed = ok("email,name,company\nctag-e@x.example,,\n,Ctag NoMail,ACME\njan@firma,Typo,\n,,Only Company");
    check("missing values keep the row", mixed.rows.length === 1 && mixed.rows[0].email === "ctag-e@x.example");
    check("name-only row imported as withoutEmail", mixed.withoutEmail.length === 1 && mixed.withoutEmail[0].name === "Ctag NoMail");
    check("typo'd email + nameless row reported with row numbers",
      mixed.skipped === 2 && mixed.issues[0].row === 4 && mixed.issues[0].reason.includes("jan@firma") && mixed.issues[1].row === 5);
    const badge = ok("name,company,phone\nCtag Badge,ACME,777");
    check("file without an email column (badge scan) imports", badge.withoutEmail.length === 1);
    const err = parseCsvContacts("phone,city\n777,Brno");
    check("no identity or name column → clear error", "error" in err);
  }

  // ---- name-only import: created as tagged leads, matched by name + company on re-import ----
  {
    const rows = [{ name: "Ctag Badge", company: "ACME" }, { name: "Ctag Solo" }];
    const r1 = await upsertContactsWithoutEmail(A, rows, { tags: ["DevConf 2026"] });
    check("name-only rows created + tagged", r1.created === 2 && r1.tagged === 2 && r1.existing === 0);
    const r2 = await upsertContactsWithoutEmail(A, [{ name: "ctag badge", company: "acme" }], { tags: ["WebExpo 2026"] });
    check("re-import matches by name + company (no duplicate), adds the tag", r2.created === 0 && r2.existing === 1);
    const badge = (await listContacts(A, { q: "Ctag Badge" })).contacts;
    check("one contact, both tags, lead", badge.length === 1 && badge[0].tags.join("|") === "DevConf 2026|WebExpo 2026" && badge[0].account_status === "lead");
  }

  // An existing synced customer and an existing lead, before the event import.
  const cust = await publicUpsertContact(A, { external_id: "ctag-cust", email: "ctag-cust@x.example", name: "Real Name" });
  const lead = await createContact(A, { email: "ctag-lead@x.example", name: "Old Lead", company: "OldCo" });

  // ---- event import: CSV → tag new + existing, leave existing details alone ----
  const csv = [
    "email,name,company",
    "CTAG-cust@x.example,Wrong Name From Badge,Badge Co",
    "ctag-lead@x.example,Lead Renamed,NewCo",
    "ctag-new1@x.example,New Person,Startup",
    "ctag-new2@x.example,Another,",
  ].join("\n");
  const parsed = parseCsvContacts(csv);
  if ("error" in parsed) throw new Error(parsed.error);
  const existing = await existingRowIndexes(A, parsed.rows);
  check("existing rows found by email (case-insensitive)", existing.size === 2 && existing.has(0) && existing.has(1));
  const writeRows = parsed.rows.filter((_, i) => !existing.has(i));
  const res = await bulkUpsertContacts(A, writeRows);
  check("only new people written", res.created === 2 && res.updated === 0);
  const tagged = await tagContactsByIdentity(A, parsed.rows, ["DevConf 2026"]);
  check("all four contacts tagged", tagged === 4);
  const custAfter = await getContact(A, cust.status === "created" ? cust.contact.id : "");
  check("existing customer keeps its synced name, gains the tag",
    custAfter?.name === "Real Name" && custAfter.tags.includes("DevConf 2026") && custAfter.account_status === "user");
  const leadAfter = await getContact(A, lead.id);
  check("existing lead keeps name/company, gains the tag",
    leadAfter?.name === "Old Lead" && leadAfter.company === "OldCo" && leadAfter.tags.join() === "DevConf 2026");

  // Second event: a person met twice carries both tags; re-import is idempotent.
  await tagContactsByIdentity(A, parsed.rows.slice(1, 2), ["WebExpo 2026"]);
  await tagContactsByIdentity(A, parsed.rows.slice(1, 2), ["webexpo 2026"]);
  check("two events → two tags, case-insensitive dedupe", (await getContact(A, lead.id))?.tags.join("|") === "DevConf 2026|WebExpo 2026");

  // ---- filter: directory + broadcast audience ----
  const who = async (op: string, value?: string) =>
    (await listContacts(A, { q: "ctag-", conditions: [{ field: "tag", op, value } as never] })).contacts.map((c) => c.email).sort().join(",");
  check("tag is (case-insensitive)", (await who("is", "devconf 2026")).split(",").length === 4);
  check("tag is WebExpo → only the lead", (await who("is", "WebExpo 2026")) === "ctag-lead@x.example");
  check("tag is_not WebExpo", !(await who("is_not", "WebExpo 2026")).includes("ctag-lead"));
  check("tag contains", (await who("contains", "expo")) === "ctag-lead@x.example");
  const preview = await previewSegment(A, { q: "ctag-", conditions: [{ field: "tag", op: "is", value: "DevConf 2026" }] });
  check("broadcast audience by tag", preview.total === 4);

  // ---- bulk remove / manual edit / counts ----
  const n1 = (await listContacts(A, { q: "ctag-new1" })).contacts[0];
  check("bulk remove tag", (await tagContacts(A, [n1.id], [], ["devconf 2026"])) === 1 && (await getContact(A, n1.id))?.tags.length === 0);
  check("bulk add is a no-op when already tagged", (await tagContacts(A, [lead.id], ["DevConf 2026"])) === 0);
  const edited = await updateContact(A, lead.id, { tags: ["VIP", " vip ", "DevConf 2026"] });
  check("manual tag edit replaces + normalizes", edited?.tags.join("|") === "DevConf 2026|VIP");
  const counts = await listContactTags(A);
  check("tag counts (3 identified + 2 name-only)", counts.find((t) => t.tag === "DevConf 2026")?.count === 5 && counts.find((t) => t.tag === "VIP")?.count === 1);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  if (failures) {
    console.error(`\ncontact-tags: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\ncontact-tags: all passed");
}

main().catch((e) => {
  console.error("contact-tags seam ERROR", e);
  process.exit(1);
});
