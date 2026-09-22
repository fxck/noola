import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { createContact, mergeContacts, upsertContact, getContact } from "../src/contacts.js";
import {
  publicUpsertContact, publicBulkUpsertContacts, publicGetContact, publicSetSubscription,
} from "../src/public-contacts.js";
import { setSubscription } from "../src/unsubscribe.js";

// Public contacts API seam (0120): strict upsert keyed by external_id (attach-to-idless on email,
// 409 on an email held by a different external_id or an email change onto a taken address), bulk
// per-row results with savepoints, lookup, and source-aware consent (the API may undo only its own
// opt-outs; person/agent/import opt-outs need force; merges never launder a source to 'api').
// Needs Postgres only.

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
  const clean = () => superPool.query("DELETE FROM contacts WHERE external_id LIKE 'pctest%' OR email LIKE 'pctest%'");
  await clean();

  // ---- create, then update by external_id ----
  {
    const r1 = await publicUpsertContact(A, { external_id: "pctest-AAAAAAAAAAAAAAAAAAAA", email: "pctest-ann@x.example", name: "Ann" });
    check("new external_id → created", r1.status === "created");
    const r2 = await publicUpsertContact(A, { external_id: "pctest-AAAAAAAAAAAAAAAAAAAA", name: "Ann Updated" });
    check("same external_id → updated, matched_by external_id",
      r2.status === "updated" && r2.matched_by === "external_id" && r2.contact.name === "Ann Updated");
    check("omitted email stays unchanged", r2.status === "updated" && r2.contact.email === "pctest-ann@x.example");
    const got = await publicGetContact(A, "pctest-AAAAAAAAAAAAAAAAAAAA");
    check("lookup by external_id", got?.name === "Ann Updated" && got.subscribed === true);
    check("lookup is tenant-isolated", (await publicGetContact(B, "pctest-AAAAAAAAAAAAAAAAAAAA")) === null);
  }

  // ---- dedup: attach the id to an id-less contact holding the email ----
  {
    const widget = await createContact(A, { email: "PCTEST-Bob@x.example", name: "Bob (widget)" });
    const r = await publicUpsertContact(A, { external_id: "pctest-BBBBBBBBBBBBBBBBBBBB", email: "pctest-bob@x.example" });
    check("id-less email holder gets the id attached (case-insensitive)",
      r.status === "updated" && r.matched_by === "email" && r.contact.id === widget.id && r.contact.external_id === "pctest-BBBBBBBBBBBBBBBBBBBB");
  }

  // ---- 409: email held by a contact with a different external_id ----
  {
    const r = await publicUpsertContact(A, { external_id: "pctest-CCCCCCCCCCCCCCCCCCCC", email: "pctest-ann@x.example" });
    check("new id + taken email → conflict naming the holder",
      r.status === "conflict" && r.conflict?.external_id === "pctest-AAAAAAAAAAAAAAAAAAAA");
    check("conflict wrote nothing", (await publicGetContact(A, "pctest-CCCCCCCCCCCCCCCCCCCC")) === null);
    const chg = await publicUpsertContact(A, { external_id: "pctest-BBBBBBBBBBBBBBBBBBBB", email: "pctest-ann@x.example" });
    check("email change onto a taken address → conflict", chg.status === "conflict");
    check("…and Bob's email is untouched", (await publicGetContact(A, "pctest-BBBBBBBBBBBBBBBBBBBB"))?.email === "pctest-bob@x.example");
  }

  // ---- bulk: per-row results, bad rows don't sink the batch ----
  {
    const res = await publicBulkUpsertContacts(A, [
      { external_id: "pctest-D1", email: "pctest-d1@x.example", name: "D1" },
      { external_id: "pctest-D2", email: "not-an-email" },
      { external_id: "pctest-D3", email: "pctest-ann@x.example" },
      { email: "pctest-noid@x.example" },
      { external_id: "pctest-D1", name: "D1 again" },
      { external_id: "pctest-D4", email: "pctest-d4@x.example", subscribed: false },
    ]);
    check("bulk counts", res.created === 2 && res.updated === 1 && res.conflicts === 1 && res.invalid === 2);
    check("bulk statuses in order",
      res.results.map((r) => r.status).join(",") === "created,invalid,conflict,invalid,updated,created");
    check("invalid row echoes its external_id", res.results[1].external_id === "pctest-D2");
    check("repeated id in batch updates the earlier row", (await publicGetContact(A, "pctest-D1"))?.name === "D1 again");
    const d4 = await publicGetContact(A, "pctest-D4");
    check("created with subscribed:false → opted out by api", d4?.subscribed === false && d4.unsubscribed_source === "api");
  }

  // ---- consent: api opt-out is reversible by the api ----
  {
    const out = await publicSetSubscription(A, "pctest-AAAAAAAAAAAAAAAAAAAA", false, false);
    check("api opt-out", out.status === "ok" && !out.contact.subscribed && out.contact.unsubscribed_source === "api");
    const back = await publicSetSubscription(A, "pctest-AAAAAAAAAAAAAAAAAAAA", true, false);
    check("api may re-subscribe its own opt-out", back.status === "ok" && back.contact.subscribed && !back.forced);
    check("unknown external_id → not_found", (await publicSetSubscription(A, "pctest-nope", true, false)).status === "not_found");
  }

  // ---- consent: a person's own opt-out blocks the api unless forced ----
  {
    const bob = (await publicGetContact(A, "pctest-BBBBBBBBBBBBBBBBBBBB"))!;
    await setSubscription(A, bob.id, true); // unsubscribe link → source 'contact'
    const blocked = await publicSetSubscription(A, "pctest-BBBBBBBBBBBBBBBBBBBB", true, false);
    check("contact opt-out blocks api resubscribe", blocked.status === "blocked" && blocked.unsubscribed_source === "contact");
    const up = await publicUpsertContact(A, { external_id: "pctest-BBBBBBBBBBBBBBBBBBBB", subscribed: true });
    check("upsert subscribed:true on a contact opt-out → saved with warning, still unsubscribed",
      up.status === "updated" && up.warnings.includes("resubscribe_blocked") && !up.contact.subscribed);
    // An api opt-out on top must not relabel the person's opt-out as 'api'.
    await publicSetSubscription(A, "pctest-BBBBBBBBBBBBBBBBBBBB", false, false);
    check("api opt-out doesn't relabel a contact opt-out",
      (await publicGetContact(A, "pctest-BBBBBBBBBBBBBBBBBBBB"))?.unsubscribed_source === "contact");
    const forced = await publicSetSubscription(A, "pctest-BBBBBBBBBBBBBBBBBBBB", true, true);
    check("force re-subscribes and reports forced", forced.status === "ok" && forced.contact.subscribed && forced.forced);
  }

  // ---- source upgrade: a person opting out after an api opt-out wins ----
  {
    await publicSetSubscription(A, "pctest-D1", false, false);
    const d1 = (await publicGetContact(A, "pctest-D1"))!;
    await setSubscription(A, d1.id, true);
    check("contact opt-out upgrades an api opt-out", (await publicGetContact(A, "pctest-D1"))?.unsubscribed_source === "contact");
    await setSubscription(A, d1.id, true, "agent");
    check("first non-api source sticks", (await publicGetContact(A, "pctest-D1"))?.unsubscribed_source === "contact");
    await setSubscription(A, d1.id, false);
    check("resubscribe clears the source", (await getContact(A, d1.id))?.unsubscribed_source === null);
  }

  // ---- import path labels its opt-outs ----
  {
    const { contact } = await upsertContact(A, { external_id: "pctest-imp", unsubscribed_at: new Date().toISOString() });
    check("console/csv import opt-out → source 'import'", contact.unsubscribed_source === "import");
  }

  // ---- merge never launders a non-api opt-out into 'api' ----
  {
    const k = await createContact(A, { external_id: "pctest-mk" });
    const d = await createContact(A, { external_id: "pctest-md" });
    await superPool.query("UPDATE contacts SET unsubscribed_at = now() - interval '1 day', unsubscribed_source = NULL WHERE id = $1", [d.id]); // legacy
    await superPool.query("UPDATE contacts SET unsubscribed_at = now(), unsubscribed_source = 'api' WHERE id = $1", [k.id]);
    const m = await mergeContacts(A, k.id, d.id);
    check("merge api + legacy opt-out → not 'api'", !!m?.unsubscribed_at && m.unsubscribed_source === null);
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  if (failures) {
    console.error(`\npublic-contacts: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\npublic-contacts: all passed");
}

main().catch((e) => {
  console.error("public-contacts seam ERROR", e);
  process.exit(1);
});
