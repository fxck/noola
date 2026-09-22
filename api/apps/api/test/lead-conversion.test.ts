import pg from "pg";
import { appPool, withTenant } from "@repo/db";
import {
  upsertContact,
  getContact,
  absorbAnonymousByHandles,
  absorbAnonymousContact,
  mergeContacts,
  tagContacts,
} from "../src/contacts.js";
import { ensureCompaniesByName } from "../src/companies.js";
import { publicUpsertContact } from "../src/public-contacts.js";
import { ingestInbound } from "../src/ingest.js";

// Lead -> user conversion (the Intercom model): a visitor who chats before telling us who they are
// is a LEAD living on an anonymous contact keyed by the widget's conversation handle. When they
// identify (widget boot/update) or sign up (account sync), that lead must CONVERT — same contact,
// history intact — not sit next to a fresh profile. Covers both halves plus the anti-theft guard.
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
  const clean = async () => {
    // messages -> tickets -> contacts: the FKs are SET NULL, so delete children first to keep the
    // fixtures from leaking into other suites' counts.
    await superPool.query("DELETE FROM messages WHERE ticket_id IN (SELECT id FROM tickets WHERE external_channel_id LIKE 'lc-%')");
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'lc-%'");
    await superPool.query("DELETE FROM contact_identities WHERE external_id LIKE 'lc-%'");
    await superPool.query("DELETE FROM contacts WHERE email LIKE 'lctest%' OR external_id LIKE 'lctest%' OR name LIKE 'LCTest%'");
    await superPool.query("DELETE FROM companies WHERE name LIKE 'LCTest%'");
  };
  await clean();

  const handleOf = (row: { id: string } | null) => row?.id ?? "";

  // ── 1. an anonymous widget turn creates a LEAD we only know by its conversation handle ──
  const h1 = "lc-conv-1";
  const turn1 = await ingestInbound({
    tenantId: A, body: "is there a free tier?", authorType: "customer", channelType: "widget",
    externalChannelId: h1, identity: { externalId: h1, email: null, name: null },
  });
  const anon = await getContact(A, turn1.contactId as string);
  check("anonymous widget turn creates an anonymous contact", !!anon && anon.identified === false);
  check("an unsynced widget visitor is a lead", anon?.account_status === "lead");
  const anonId = handleOf(anon);
  const anonCreatedAt = anon?.created_at as string;

  // Something the lead told us while anonymous (live enrichment writes attributes the same way).
  await withTenant(A, (c) =>
    c.query("UPDATE contacts SET attributes = '{\"last_page_url\":\"/pricing\"}'::jsonb, tags = ARRAY['DevConf'] WHERE id = $1", [anonId]));

  // ── 2. they identify (widget boot after signup) → the lead CONVERTS onto one contact ──
  const { contact: identified } = await upsertContact(A, {
    external_id: "lctest-user-1", email: "lctest-dana@example.test", name: "Dana Lead",
  });
  check("identify resolves a separate contact before the fold", identified.id !== anonId);
  const folded = await absorbAnonymousByHandles(A, identified.id, "widget", [h1]);
  check("identify folds exactly the one anonymous shell", folded === 1);

  const shell = await getContact(A, anonId);
  check("the anonymous shell is gone (one record per person)", shell === null);
  const after = await getContact(A, identified.id);
  check("the survivor keeps its identity", after?.email === "lctest-dana@example.test" && after?.external_id === "lctest-user-1");
  check("what the lead told us anonymously carries over", (after?.attributes as Record<string, unknown>)?.last_page_url === "/pricing");
  check("lead tags carry over", (after?.tags ?? []).includes("DevConf"));
  check("known-since dates from the first anonymous visit", new Date(after?.created_at as string).getTime() === new Date(anonCreatedAt).getTime());

  const moved = await withTenant(A, (c) =>
    c.query("SELECT contact_id FROM tickets WHERE id = $1", [turn1.ticketId]));
  check("the conversation follows the person", moved.rows[0]?.contact_id === identified.id);
  const msgs = await withTenant(A, (c) =>
    c.query("SELECT author_contact_id FROM messages WHERE ticket_id = $1", [turn1.ticketId]));
  check("authored messages follow the person", msgs.rows.every((r: { author_contact_id: string }) => r.author_contact_id === identified.id));

  // ── 3. the next message on that conversation threads onto the identified person ──
  const turn2 = await ingestInbound({
    tenantId: A, body: "and what about SSO?", authorType: "customer", channelType: "widget",
    externalChannelId: h1, identity: { externalId: h1, email: null, name: null },
  });
  check("a later anonymous turn threads onto the converted contact", turn2.contactId === identified.id);
  check("...onto the same conversation, not a new one", turn2.ticketId === turn1.ticketId);

  // ── 4. signing up (account sync) converts a lead by email — same record, status flips ──
  const lead2 = await upsertContact(A, { email: "lctest-erin@example.test", name: "Erin Lead" });
  check("a CSV/widget person with no sync is a lead", (await getContact(A, lead2.contact.id))?.account_status === "lead");
  const synced = await publicUpsertContact(A, { external_id: "lctest-user-2", email: "lctest-erin@example.test", name: "Erin Lead" });
  check("sync attaches the new account to the existing lead", synced.status === "updated" && synced.contact.id === lead2.contact.id);
  check("...matched on email, not a second contact", synced.status !== "conflict" && (synced as { matched_by?: string }).matched_by === "email");
  check("the lead converts to a user", synced.status !== "conflict" && synced.contact.account_status === "user");

  // ── 5. anti-theft: an IDENTIFIED contact is never swallowed by a conversation handle ──
  const h2 = "lc-conv-2";
  const victimTurn = await ingestInbound({
    tenantId: A, body: "my invoice is wrong", authorType: "customer", channelType: "widget",
    externalChannelId: h2, identity: { externalId: h2, email: "lctest-frank@example.test", name: "Frank Real" },
  });
  const victimId = victimTurn.contactId as string;
  const { contact: attacker } = await upsertContact(A, { email: "lctest-mallory@example.test", name: "Mallory" });
  const stolen = await absorbAnonymousByHandles(A, attacker.id, "widget", [h2]);
  check("a handle owned by an identified contact absorbs nothing", stolen === 0);
  const victim = await getContact(A, victimId);
  check("...the identified contact survives", victim?.email === "lctest-frank@example.test");
  const stillTheirs = await withTenant(A, (c) =>
    c.query("SELECT contact_id FROM tickets WHERE id = $1", [victimTurn.ticketId]));
  check("...and keeps their conversation", stillTheirs.rows[0]?.contact_id === victimId);

  // ── 6. the primitive refuses to fold a contact into itself ──
  const selfFold = await withTenant(A, (c) => absorbAnonymousContact(c, attacker.id, attacker.id));
  check("absorbing a contact into itself is a no-op", selfFold === false);

  // ── 7. the sync moves an email onto an account and a LEAD holds it → the lead converts ──
  {
    const synced = await publicUpsertContact(A, { external_id: "lctest-user-3", email: "lctest-old@example.test", name: "Gita Grey" });
    check("sync creates the account", synced.status === "created");
    const syncedId = synced.status !== "conflict" ? synced.contact.id : "";
    // Someone we met first, under the address the account is about to move to.
    const lead = await ingestInbound({
      tenantId: A, body: "quick question before we buy", authorType: "customer", channelType: "email",
      externalChannelId: "lc-mail-1", identity: { externalId: "lc-mail-1", email: "lctest-new@example.test", name: "G. Grey" },
    });
    const leadId = lead.contactId as string;
    await tagContacts(A, [leadId], ["DevConf"]);
    await withTenant(A, (c) =>
      c.query("UPDATE contacts SET unsubscribed_at = now(), unsubscribed_source = 'contact' WHERE id = $1", [leadId]));

    const moved = await publicUpsertContact(A, { external_id: "lctest-user-3", email: "lctest-new@example.test", name: "Gita Grey" });
    check("an email held by a lead no longer blocks the sync", moved.status === "updated");
    check("...it lands on the account, not a new contact", moved.status !== "conflict" && moved.contact.id === syncedId);
    check("...and says so", moved.status !== "conflict" && (moved.warnings ?? []).includes("lead_merged"));
    check("the lead's record is gone", (await getContact(A, leadId)) === null);
    const survivor = await getContact(A, syncedId);
    check("the account now holds the address", survivor?.email === "lctest-new@example.test");
    check("the lead's tags carry over", (survivor?.tags ?? []).includes("DevConf"));
    check("the lead's opt-out is sticky (not relabelled 'api')",
      !!survivor?.unsubscribed_at && survivor?.unsubscribed_source === "contact");
    check("it is a user, not a lead", survivor?.account_status === "user");
    const convo = await withTenant(A, (c) => c.query("SELECT contact_id FROM tickets WHERE id = $1", [lead.ticketId]));
    check("the lead's conversation follows them", convo.rows[0]?.contact_id === syncedId);
  }

  // ── 8. two SYNCED accounts claiming one email is still a conflict — never merged ──
  {
    await publicUpsertContact(A, { external_id: "lctest-user-4", email: "lctest-hana@example.test", name: "Hana" });
    const other = await publicUpsertContact(A, { external_id: "lctest-user-5", email: "lctest-ivan@example.test", name: "Ivan" });
    const clash = await publicUpsertContact(A, { external_id: "lctest-user-5", email: "lctest-hana@example.test", name: "Ivan" });
    check("an email held by another ACCOUNT is a conflict", clash.status === "conflict");
    const untouched = await getContact(A, other.status !== "conflict" ? other.contact.id : "");
    check("...and nothing is written", untouched?.email === "lctest-ivan@example.test");
  }

  // ── 9. an imported company name lands on the real client instead of forking one ──
  {
    await superPool.query(
      `INSERT INTO companies (tenant_id, name, external_id, synced_at) VALUES ($1, 'LCTest Nimbus', 'lctest-co-1', now())`,
      [A],
    );
    const map = await ensureCompaniesByName(A, ["LCTest Nimbus"]);
    const resolved = map.get("lctest nimbus");
    const which = await withTenant(A, (c) => c.query("SELECT external_id FROM companies WHERE id = $1", [resolved]));
    check("an imported company name links to the synced client", which.rows[0]?.external_id === "lctest-co-1");
    const dupes = await withTenant(A, (c) =>
      c.query("SELECT count(*)::int AS n FROM companies WHERE lower(name) = 'lctest nimbus'"));
    check("...and no look-alike company is created next to it", dupes.rows[0]?.n === 1);
  }

  // ── 10. two real clients share a name → no guess, the id-less company is used ──
  {
    await superPool.query(
      `INSERT INTO companies (tenant_id, name, external_id, synced_at) VALUES
         ($1, 'LCTest Orion', 'lctest-co-2', now()), ($1, 'LCTest Orion', 'lctest-co-3', now())`,
      [A],
    );
    const map = await ensureCompaniesByName(A, ["LCTest Orion"]);
    const resolved = map.get("lctest orion");
    const which = await withTenant(A, (c) => c.query("SELECT external_id FROM companies WHERE id = $1", [resolved]));
    check("an ambiguous client name is never guessed at", which.rows[0]?.external_id === null);
  }

  // ── 11. the agent-driven merge keeps both sides' tags (one shared fold body) ──
  {
    const keep = await upsertContact(A, { email: "lctest-keep@example.test", name: "LCTest Keep" });
    const drop = await upsertContact(A, { email: "lctest-drop@example.test", name: "LCTest Drop" });
    await tagContacts(A, [keep.contact.id], ["VIP"]);
    await tagContacts(A, [drop.contact.id], ["DevConf"]);
    const merged = await mergeContacts(A, keep.contact.id, drop.contact.id);
    check("merge unions the tags of both records", (merged?.tags ?? []).includes("VIP") && (merged?.tags ?? []).includes("DevConf"));
  }

  await clean();
  await superPool.end();
  await appPool.end();
  console.log(failures === 0 ? "\nlead-conversion: ALL PASS" : `\nlead-conversion: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
