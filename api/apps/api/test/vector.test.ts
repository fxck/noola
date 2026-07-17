import crypto from "node:crypto";
import {
  ensureVectorCollections,
  upsertVectors,
  vectorSearch,
  deleteVectors,
  vectorEnabled,
  VECTOR_DIM,
} from "../src/vector.js";

// Qdrant vector-store gate. Uses HAND-MADE vectors (no embedder needed), so it runs
// in CI with just a Qdrant container. The property under test is the one that must
// never regress: a vector search is tenant-scoped — even a point in ANOTHER tenant
// whose vector is IDENTICAL to the query must never be returned. Skips cleanly when
// no Qdrant is configured (QDRANT_URL unset).

const A = "33333333-3333-3333-3333-333333333333";
const B = "22222222-2222-2222-2222-222222222222";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

/** A unit vector pointing mostly along axis `axis`, with a little value at `axis+1`. */
function vec(axis: number, tail = 0): number[] {
  const v = new Array(VECTOR_DIM).fill(0);
  v[axis % VECTOR_DIM] = 1;
  if (tail) v[(axis + 1) % VECTOR_DIM] = tail;
  // normalize
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

async function searchUntil(tenantId: string, q: number[], want: (ids: string[]) => boolean, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const ids = await vectorSearch("chunks", tenantId, q, 10);
    if (want(ids)) return ids;
    await new Promise((r) => setTimeout(r, 150));
  }
  return vectorSearch("chunks", tenantId, q, 10);
}

async function main() {
  if (!vectorEnabled()) {
    console.log("VECTOR: skipped (QDRANT_URL not set)");
    return;
  }
  await ensureVectorCollections();

  const query = vec(0); // points along axis 0
  const aIds = [crypto.randomUUID(), crypto.randomUUID()];
  const bExact = crypto.randomUUID(); // B's TRAP point: identical to the query vector
  const bIds = [bExact, crypto.randomUUID()];

  await upsertVectors("chunks", [
    { id: aIds[0], vector: vec(0, 0.05), payload: { tenant_id: A, document_id: "doc-a" } },
    { id: aIds[1], vector: vec(0, 0.10), payload: { tenant_id: A, document_id: "doc-a" } },
    { id: bExact, vector: vec(0), payload: { tenant_id: B, document_id: "doc-b" } }, // closest possible
    { id: bIds[1], vector: vec(0, 0.20), payload: { tenant_id: B, document_id: "doc-b" } },
  ]);

  const aHits = await searchUntil(A, query, (ids) => ids.includes(aIds[0]));
  check("vector search returns own-tenant points", aHits.includes(aIds[0]) || aHits.includes(aIds[1]));
  check("vector search NEVER returns another tenant's point — even an identical vector", !aHits.includes(bExact) && !aHits.includes(bIds[1]));

  const bHits = await searchUntil(B, query, (ids) => ids.includes(bExact));
  check("other tenant retrieves its own closest point", bHits.includes(bExact));
  check("other tenant never sees the first tenant's points", !bHits.includes(aIds[0]) && !bHits.includes(aIds[1]));

  // delete removes points
  await deleteVectors("chunks", [...aIds, ...bIds]);
  const afterA = await vectorSearch("chunks", A, query, 10);
  check("deleted points are gone", !afterA.includes(aIds[0]) && !afterA.includes(aIds[1]));

  if (failures > 0) { console.error(`\nVECTOR: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nVECTOR: all checks green");
}

main().catch((e) => { console.error("vector seam ERROR", e); process.exit(1); });
