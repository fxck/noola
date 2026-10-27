import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { createSegment, getSegment, listSegments, updateSegment, deleteSegment } from "../src/segments.js";

// Saved Segments seam + isolation gate: CRUD round-trips through RLS, the definition jsonb
// round-trips intact, `resource` scoping works, and one tenant never sees or mutates
// another's segment. Needs Postgres only.

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
  const clean = async () => { await superPool.query("DELETE FROM segments WHERE name LIKE 'SEGTEST%'"); };
  await clean();

  // NB: jsonb does not preserve object key order, so definitions are compared
  // structurally (by field), never via JSON.stringify equality.
  const def = { q: "acme", filters: [{ field: "company", op: "is", value: "Acme Corp" }], sort: { by: "name", dir: "asc" } };
  const s = await createSegment(A, { name: "SEGTEST enterprise", definition: def });
  const sdef = s.definition as { q?: string; filters?: Array<{ field: string; op: string; value?: string }>; sort?: { by: string; dir: string } };
  check("createSegment returns a row with an id", !!s.id && s.name === "SEGTEST enterprise");
  check("createSegment defaults resource to contacts", s.resource === "contacts");
  check("createSegment round-trips the definition jsonb", sdef.q === "acme" && sdef.filters?.[0].field === "company" && sdef.filters?.[0].op === "is" && sdef.sort?.dir === "asc");

  check("getSegment returns it", (await getSegment(A, s.id))?.id === s.id);
  check("listSegments includes the segment", (await listSegments(A)).some((x) => x.id === s.id));
  check("listSegments filters by resource (contacts)", (await listSegments(A, "contacts")).some((x) => x.id === s.id));
  check("listSegments(other resource) excludes it", !(await listSegments(A, "tickets")).some((x) => x.id === s.id));

  const upd = await updateSegment(A, s.id, { name: "SEGTEST renamed" });
  const udef = upd?.definition as { q?: string; filters?: Array<{ field: string }> };
  check("updateSegment renames", upd?.name === "SEGTEST renamed");
  check("updateSegment leaves definition unchanged when omitted", udef.q === "acme" && udef.filters?.[0].field === "company");
  const def2 = { filters: [{ field: "email", op: "ends_with", value: "@acme.example" }] };
  const upd2 = await updateSegment(A, s.id, { definition: def2 });
  const u2def = upd2?.definition as { q?: string; filters?: Array<{ field: string; op: string }> };
  check("updateSegment replaces the definition", u2def.filters?.[0].op === "ends_with" && u2def.q === undefined);

  // ---- tenant isolation ----
  const sB = await createSegment(B, { name: "SEGTEST b-seg", definition: {} });
  check("A's list never shows B's segment", !(await listSegments(A)).some((x) => x.id === sB.id));
  check("A cannot get B's segment", (await getSegment(A, sB.id)) === null);
  check("A cannot update B's segment", (await updateSegment(A, sB.id, { name: "hax" })) === null);
  check("A cannot delete B's segment", (await deleteSegment(A, sB.id)) === false);
  check("B's segment survives A's attempts", !!(await getSegment(B, sB.id)));

  check("deleteSegment own → true", (await deleteSegment(A, s.id)) === true);
  check("deleted segment get → null", (await getSegment(A, s.id)) === null);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nSEGMENTS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nSEGMENTS: all checks green");
}

main().catch((e) => { console.error("segments seam ERROR", e); process.exit(1); });
