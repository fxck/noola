import pg from "pg";
import { withTenant } from "@repo/db";
import { syncSource } from "../src/sources.js";
import type { ConnectorUnit } from "../src/sources.js";

// Incremental source resync (0085): a re-crawl diffs the fetched units against what's stored (by
// source_key + content_hash) and only re-embeds/re-indexes what changed — unchanged docs keep their
// id (and their embeddings), removed keys are pruned, and the source is never emptied up-front.
// Drives syncSource with a stub connector (its `connector` test seam) so no network is touched;
// ingest still hits the real doc pipeline. Synthetic tenant. Needs Postgres + the doc services.

const T = "eeeeeeee-3333-4000-8000-0000000000d1";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function docsBySource(sourceId: string): Promise<Map<string, { id: string; hash: string | null }>> {
  return withTenant(T, async (c) => {
    const r = await c.query("SELECT id, source_key, content_hash FROM documents WHERE source_id = $1", [sourceId]);
    const m = new Map<string, { id: string; hash: string | null }>();
    for (const row of r.rows) if (row.source_key) m.set(row.source_key as string, { id: row.id as string, hash: row.content_hash as string | null });
    return m;
  });
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 2,
  });
  const clean = async () => {
    const d = "(SELECT id FROM documents WHERE tenant_id = $1)";
    await superPool.query(`DELETE FROM document_chunks WHERE document_id IN ${d}`, [T]);
    await superPool.query(`DELETE FROM documents WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM sources WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM tenants WHERE id = $1`, [T]);
  };
  await clean();
  await superPool.query(`INSERT INTO tenants (id, name) VALUES ($1,'SourceIncTest') ON CONFLICT (id) DO NOTHING`, [T]);
  const sourceId = (await superPool.query(
    `INSERT INTO sources (tenant_id, kind, label, config) VALUES ($1,'url','SrcIncTest','{}'::jsonb) RETURNING id`, [T],
  )).rows[0].id as string;

  // Mutable unit set + a stub connector (syncSource's test seam).
  let units: ConnectorUnit[] = [];
  const connector = async () => units;
  const unit = (key: string, content: string): ConnectorUnit => ({ key, title: key, contentType: "text/markdown", content });

  // ---- run 1: fresh crawl, 2 units → both added ----
  units = [unit("/a", "alpha one"), unit("/b", "bravo one")];
  const r1 = await syncSource(T, sourceId, connector);
  check("run1: added 2, updated 0, unchanged 0, removed 0",
    !!r1?.diff && r1.diff.added === 2 && r1.diff.updated === 0 && r1.diff.unchanged === 0 && r1.diff.removed === 0);
  check("run1: total docCount 2", r1?.docCount === 2);
  const after1 = await docsBySource(sourceId);
  check("run1: source_key + content_hash persisted", after1.has("/a") && !!after1.get("/a")!.hash && after1.has("/b"));
  const idA = after1.get("/a")!.id;

  // ---- run 2: identical crawl → all unchanged, no re-ingest ----
  const r2 = await syncSource(T, sourceId, connector);
  check("run2: unchanged 2, added 0, updated 0", !!r2?.diff && r2.diff.unchanged === 2 && r2.diff.added === 0 && r2.diff.updated === 0);
  const after2 = await docsBySource(sourceId);
  check("run2: unchanged doc /a kept the SAME id (not re-ingested)", after2.get("/a")?.id === idA);

  // ---- run 3: /b content changes → 1 updated, 1 unchanged ----
  const idB1 = after2.get("/b")!.id;
  units = [unit("/a", "alpha one"), unit("/b", "bravo TWO changed")];
  const r3 = await syncSource(T, sourceId, connector);
  check("run3: updated 1, unchanged 1, added 0", !!r3?.diff && r3.diff.updated === 1 && r3.diff.unchanged === 1 && r3.diff.added === 0);
  const after3 = await docsBySource(sourceId);
  check("run3: unchanged /a still same id", after3.get("/a")?.id === idA);
  check("run3: changed /b got a new doc id + new hash", after3.get("/b")?.id !== idB1 && after3.get("/b")?.hash !== after2.get("/b")?.hash);

  // ---- run 4: drop /b, add /c → 1 added, 1 removed, 1 unchanged ----
  units = [unit("/a", "alpha one"), unit("/c", "charlie one")];
  const r4 = await syncSource(T, sourceId, connector);
  check("run4: added 1, removed 1, unchanged 1", !!r4?.diff && r4.diff.added === 1 && r4.diff.removed === 1 && r4.diff.unchanged === 1);
  const after4 = await docsBySource(sourceId);
  check("run4: /b pruned, /c present, /a stable", !after4.has("/b") && after4.has("/c") && after4.get("/a")?.id === idA);
  check("run4: source doc_count reflects 2 live docs", r4?.docCount === 2 && after4.size === 2);

  await clean();
  await superPool.end();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
