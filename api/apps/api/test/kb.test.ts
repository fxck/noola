import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  createArticle, listArticles, getArticle, updateArticle, deleteArticle, searchArticles,
  listCollections, getCollection, createCollection, updateCollection, deleteCollection,
} from "../src/kb.js";
import { ensureKbCollection, deleteArticleDoc } from "../src/search.js";

// KB seam + isolation gate: CRUD round-trips through RLS, tenant isolation holds
// on every op (list/get/update/delete/search), and full-text search matches on
// body while the filter_by keeps tenants apart. Needs Typesense + Postgres.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const SHARED = "kbzephyr";
const BODY_A = "acmequasar";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function searchUntil(tenantId: string, q: string, wantId: string, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const rows = await searchArticles(tenantId, q);
    if (rows.some((r) => r.id === wantId)) return rows;
    await new Promise((r) => setTimeout(r, 150));
  }
  return searchArticles(tenantId, q);
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  await ensureKbCollection();
  const clean = async () => {
    await superPool.query("DELETE FROM kb_articles WHERE title LIKE 'KBTEST%'");
    await superPool.query("DELETE FROM kb_collections WHERE name LIKE 'KBTEST%'");
  };
  await clean();

  // create in both tenants (shared title word, tenant-unique body word)
  const a = await createArticle(A, `KBTEST ${SHARED} acme guide`, `KBTEST ${BODY_A} how to reset your password`);
  const b = await createArticle(B, `KBTEST ${SHARED} globex guide`, `KBTEST different globex content`);
  check("create returns an article with an id", !!a.id && a.title.includes(SHARED));

  // CRUD round-trip within tenant A
  {
    const got = await getArticle(A, a.id);
    check("get returns the created article", got?.id === a.id && got?.body.includes(BODY_A));
    const upd = await updateArticle(A, a.id, { title: `KBTEST ${SHARED} acme guide v2` });
    check("update returns the patched article", upd?.title.endsWith("v2"));
    const reget = await getArticle(A, a.id);
    check("update persisted", reget?.title.endsWith("v2"));
    const list = await listArticles(A);
    check("list includes the article, tenant-scoped", list.some((x) => x.id === a.id) && list.every((x) => x.id !== b.id));
  }

  // isolation: A cannot see/touch B's article
  {
    check("A get of B's article → null", (await getArticle(A, b.id)) === null);
    check("A update of B's article → null", (await updateArticle(A, b.id, { title: "hax" })) === null);
    check("A delete of B's article → false", (await deleteArticle(A, b.id)) === false);
    const stillThere = await getArticle(B, b.id);
    check("B's article survived A's attempts", stillThere?.id === b.id);
  }

  // full-text search: body match + tenant isolation on a shared word
  {
    const byBody = await searchUntil(A, BODY_A, a.id);
    check("KB search matches on body text", byBody.some((r) => r.id === a.id));
    const shared = await searchUntil(A, SHARED, a.id);
    check("shared-word KB search returns own tenant's hit", shared.some((r) => r.id === a.id));
    check("shared-word KB search NEVER returns the other tenant's hit", !shared.some((r) => r.id === b.id));
  }

  // collections (taxonomy): assignment, filtering, counts, ON DELETE SET NULL, isolation
  {
    const col = await createCollection(A, { name: "KBTEST Guides", description: "how-tos", color: "#38f" });
    check("createCollection returns a row with an id", !!col.id && col.name === "KBTEST Guides");

    const inCol = await createArticle(A, "KBTEST collected article", "KBTEST body inside a collection", col.id);
    check("createArticle stores collection_id", inCol.collection_id === col.id);
    check("listArticles(collectionId) returns only that collection", (await listArticles(A, col.id)).every((x) => x.collection_id === col.id) && (await listArticles(A, col.id)).some((x) => x.id === inCol.id));
    check("listArticles(null) excludes collected articles", !(await listArticles(A, null)).some((x) => x.id === inCol.id));
    check("listCollections reports the article_count", (await listCollections(A)).find((cc) => cc.id === col.id)?.article_count === 1);

    const moved = await updateArticle(A, inCol.id, { collection_id: null });
    check("updateArticle collection_id:null → uncategorized", moved?.collection_id === null);
    check("moved article appears in the uncategorized list", (await listArticles(A, null)).some((x) => x.id === inCol.id));
    check("updateArticle without collection_id key leaves it unchanged", (await updateArticle(A, inCol.id, { title: "KBTEST collected article v2" }))?.collection_id === null);

    // put it back, delete the collection → article survives, collection_id nulled (SET NULL)
    await updateArticle(A, inCol.id, { collection_id: col.id });
    const renamed = await updateCollection(A, col.id, { name: "KBTEST Guides v2" });
    check("updateCollection renames", renamed?.name === "KBTEST Guides v2");
    check("deleteCollection → true", (await deleteCollection(A, col.id)) === true);
    const orphan = await getArticle(A, inCol.id);
    check("article survives its collection's deletion", !!orphan);
    check("orphaned article's collection_id is nulled (ON DELETE SET NULL)", orphan?.collection_id === null);

    // isolation: B cannot see or mutate A's collection
    const colB = await createCollection(B, { name: "KBTEST Bcol" });
    check("A's listCollections never shows B's collection", !(await listCollections(A)).some((cc) => cc.id === colB.id));
    check("A cannot update B's collection", (await updateCollection(A, colB.id, { name: "hax" })) === null);
    check("A cannot delete B's collection", (await deleteCollection(A, colB.id)) === false);
    check("B's collection survived A's attempts", !!(await getCollection(B, colB.id)));

    await deleteArticle(A, inCol.id);
  }

  // delete removes it
  {
    check("delete own article → true", (await deleteArticle(A, a.id)) === true);
    check("deleted article get → null", (await getArticle(A, a.id)) === null);
  }

  await deleteArticleDoc(a.id);
  await deleteArticleDoc(b.id);
  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nKB SEAM: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nKB SEAM: all checks green");
}

main().catch((e) => { console.error("kb seam ERROR", e); process.exit(1); });
