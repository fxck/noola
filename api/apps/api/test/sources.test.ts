import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  createSource,
  getSource,
  listSources,
  updateSource,
  maskSource,
  deleteSource,
  syncSource,
  fetchUrlUnits,
  filterGithubTree,
  batchDiscordMessages,
  type ConnectorUnit,
  type GithubTreeEntry,
  type DiscordMessage,
} from "../src/sources.js";
import { SourceInput } from "@repo/contracts";
import { searchDocuments } from "../src/documents.js";
import { ensureChunksCollection } from "../src/search.js";

// Live-sources connector vertical: a source is registered, its connector's units are
// ingested through the document pipeline tagged by source_id (searchable), a re-sync
// REPLACES the source's docs (old gone, new present), deleting the source removes its
// docs, and one tenant never sees another's source or docs. The URL connector's SSRF
// guard is unit-checked without touching the network. Needs Typesense + Postgres
// (+ Qdrant/embedder in dev, which no-op cleanly if absent). Network is never hit — the
// sync connector is injected (test seam on syncSource).

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const OLD = "zetaphase"; // marker in the first sync's units
const NEW = "omegaphase"; // marker in the re-sync's units

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

// A fake connector: N units, each a multi-paragraph doc carrying `marker` so retrieval
// can find it. Titles are SRCTEST-prefixed so teardown can sweep the docs.
function fakeConnector(marker: string, n: number) {
  return async (): Promise<ConnectorUnit[]> => {
    const units: ConnectorUnit[] = [];
    for (let i = 0; i < n; i++) {
      units.push({
        key: `https://fixture.test/${marker}/${i}`,
        title: `SRCTEST ${marker} page ${i}`,
        contentType: "text/markdown",
        content:
          `SRCTEST ${marker} page ${i}: this document explains onboarding and billing in ` +
          `enough detail that the chunker produces real chunks and retrieval can reach the ${marker} marker.`,
      });
    }
    return units;
  };
}

async function searchUntil(tenantId: string, q: string, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const hits = await searchDocuments(tenantId, q);
    if (hits.length) return hits;
    await new Promise((r) => setTimeout(r, 150));
  }
  return searchDocuments(tenantId, q);
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER,
    password: process.env.DB_SUPER_PASSWORD,
    max: 1,
  });
  await ensureChunksCollection();
  const clean = async () => {
    await superPool.query("DELETE FROM documents WHERE filename LIKE 'SRCTEST%'");
    await superPool.query("DELETE FROM sources WHERE label LIKE 'SRCTEST%'");
  };
  await clean();

  const docCountBySource = async (sourceId: string): Promise<number> => {
    const r = await superPool.query("SELECT count(*)::int AS n FROM documents WHERE source_id = $1", [sourceId]);
    return r.rows[0].n as number;
  };

  // ---- URL connector SSRF guard (no network) ----
  const blocked = async (url: string) => {
    try {
      await fetchUrlUnits({ url });
      return false;
    } catch {
      return true;
    }
  };
  check("url connector rejects non-http scheme (file:)", await blocked("file:///etc/passwd"));
  check("url connector blocks localhost", await blocked("http://localhost/docs"));
  check("url connector blocks 127.0.0.1", await blocked("http://127.0.0.1:8080/"));
  check("url connector blocks cloud-metadata 169.254.169.254", await blocked("http://169.254.169.254/latest/meta-data/"));
  check("url connector blocks RFC1918 10.x", await blocked("http://10.1.2.3/internal"));

  // ---- create + initial sync (injected connector) ----
  const src = await createSource(A, { kind: "url", label: "SRCTEST acme docs", config: { url: "https://docs.acme.test/sitemap.xml" } });
  check("createSource returns a pending url source", src.kind === "url" && src.status === "pending");
  check("createSource is listed for its tenant", (await listSources(A)).some((s) => s.id === src.id));

  const r1 = await syncSource(A, src.id, fakeConnector(OLD, 3));
  check("initial sync ok", r1?.status === "ok" && r1.docCount === 3);
  const after1 = await getSource(A, src.id);
  check("source row status=ok after sync", after1?.status === "ok");
  check("source doc_count reflects ingested units", after1?.doc_count === 3);
  check("source last_synced_at set", !!after1?.last_synced_at);
  check("3 documents tagged with source_id", (await docCountBySource(src.id)) === 3);

  // ---- ingested units are searchable ----
  {
    const hits = await searchUntil(A, OLD);
    check("synced source docs are retrievable by content", hits.length > 0);
  }

  // ---- re-sync REPLACES the source's docs ----
  const r2 = await syncSource(A, src.id, fakeConnector(NEW, 2));
  check("re-sync ok with new doc count", r2?.status === "ok" && r2.docCount === 2);
  check("re-sync replaced doc set (count = new N)", (await docCountBySource(src.id)) === 2);
  {
    const fresh = await searchUntil(A, NEW);
    check("re-sync's new docs are retrievable", fresh.length > 0);
    // old marker's chunks should be gone from the index
    const stale = await searchDocuments(A, OLD);
    check("re-sync's old docs are no longer retrievable", !stale.some((h) => h.text.includes(OLD)));
  }

  // ---- tenant isolation ----
  const srcB = await createSource(B, { kind: "url", label: "SRCTEST globex docs", config: { url: "https://docs.globex.test/" } });
  await syncSource(B, srcB.id, fakeConnector(NEW, 2));
  check("A does not see B's source in its list", !(await listSources(A)).some((s) => s.id === srcB.id));
  check("A cannot fetch B's source", (await getSource(A, srcB.id)) === null);
  check("A cannot delete B's source", (await deleteSource(A, srcB.id)) === false);
  check("B's source still present after A's delete attempt", (await getSource(B, srcB.id)) !== null);

  // ---- updateSource settings + write-only credential masking ----
  {
    const gh = await createSource(A, { kind: "github", label: "SRCTEST gh-settings", config: { repo: "acme/docs", token: "ghp_secret123" } });
    const masked = maskSource((await getSource(A, gh.id))!);
    check("maskSource strips the token from config", (masked.config as Record<string, unknown>).token === undefined);
    check("maskSource flags a stored credential (has_token)", (masked.config as Record<string, unknown>).has_token === true);

    // update label + non-sensitive config WITHOUT resending the token → token preserved
    const upd = await updateSource(A, gh.id, { label: "SRCTEST gh-renamed", config: { repo: "acme/docs", branch: "main" } });
    check("updateSource changes the label", upd?.label === "SRCTEST gh-renamed");
    const stored = await getSource(A, gh.id);
    check("updateSource preserves the write-only token when omitted", (stored?.config as Record<string, unknown>).token === "ghp_secret123");
    check("updateSource applies non-sensitive config changes", (stored?.config as Record<string, unknown>).branch === "main");

    // a supplied token replaces it; a masking flag never round-trips into storage
    await updateSource(A, gh.id, { config: { repo: "acme/docs", token: "ghp_rotated" } });
    check("updateSource replaces token when a new value is supplied", ((await getSource(A, gh.id))?.config as Record<string, unknown>).token === "ghp_rotated");
    await updateSource(A, gh.id, { config: { repo: "acme/docs", has_token: true } });
    const afterFlag = await getSource(A, gh.id);
    check("updateSource strips has_token flag from stored config", (afterFlag?.config as Record<string, unknown>).has_token === undefined);
    check("stripping has_token preserves the real token", (afterFlag?.config as Record<string, unknown>).token === "ghp_rotated");

    check("A cannot update B's source (cross-tenant → null)", (await updateSource(A, srcB.id, { label: "hax" })) === null);
    await deleteSource(A, gh.id);
  }

  // ---- github/discord connectors ingest through the same sync (injected fakes, no network) ----
  {
    const ghSrc = await createSource(A, { kind: "github", label: "SRCTEST gh", config: { repo: "acme/docs" } });
    const gh = await syncSource(A, ghSrc.id, fakeConnector(OLD, 4));
    check("github source syncs via connector seam (docs ingested + tagged)", gh?.status === "ok" && gh.docCount === 4);
    check("github source docs carry its source_id", (await docCountBySource(ghSrc.id)) === 4);
    // re-sync replaces
    const gh2 = await syncSource(A, ghSrc.id, fakeConnector(NEW, 2));
    check("github re-sync replaces its docs", gh2?.status === "ok" && (await docCountBySource(ghSrc.id)) === 2);

    const dcSrc = await createSource(A, { kind: "discord", label: "SRCTEST dc", config: { channelId: "42" } });
    const dc = await syncSource(A, dcSrc.id, fakeConnector(NEW, 3));
    check("discord source syncs via connector seam", dc?.status === "ok" && dc.docCount === 3);
    check("discord source docs carry its source_id", (await docCountBySource(dcSrc.id)) === 3);

    // a connector that throws (e.g. bad config / auth) → sync records status=error + last_error
    const failGh = await createSource(A, { kind: "github", label: "SRCTEST gh-fail", config: { repo: "acme/docs" } });
    const bad = await syncSource(A, failGh.id, async () => {
      throw Object.assign(new Error("github connector: repo not found or private (needs a token)"), { statusCode: 404 });
    });
    check("failing connector → sync status error", bad?.status === "error");
    const badRow = await getSource(A, failGh.id);
    check("connector failure recorded in last_error", !!badRow?.last_error && badRow.last_error.includes("repo not found"));
  }

  // ---- pure helpers: GitHub tree filtering (no network) ----
  {
    const tree: GithubTreeEntry[] = [
      { path: "README.md", type: "blob", size: 100 },
      { path: "docs/guide.mdx", type: "blob", size: 200 },
      { path: "docs/notes.txt", type: "blob", size: 50 },
      { path: "docs/api.rst", type: "blob", size: 60 },
      { path: "docs", type: "tree" }, // directory entry — skipped
      { path: "src/index.ts", type: "blob", size: 300 }, // wrong extension
      { path: "logo.png", type: "blob", size: 999 }, // binary
      { path: "CHANGELOG.markdown", type: "blob", size: 40 },
    ];
    const all = filterGithubTree(tree);
    check("github tree keeps only docs-like blobs", JSON.stringify(all) ===
      JSON.stringify(["README.md", "docs/guide.mdx", "docs/notes.txt", "docs/api.rst", "CHANGELOG.markdown"]));
    const underDocs = filterGithubTree(tree, "docs");
    check("github tree respects the path prefix", JSON.stringify(underDocs) ===
      JSON.stringify(["docs/guide.mdx", "docs/notes.txt", "docs/api.rst"]));
    check("github tree trims slashes on the path prefix", JSON.stringify(filterGithubTree(tree, "/docs/")) === JSON.stringify(underDocs));
  }

  // ---- pure helpers: Discord message batching (no network) ----
  {
    const msgs: DiscordMessage[] = [
      { id: "1", content: "hello", author: { username: "alice" } },
      { id: "2", content: "", author: { username: "bot" } }, // empty → skipped
      { id: "3", content: "how do I reset?", author: { username: "bob" } },
      { id: "4", content: "click settings", author: { username: "alice" } },
    ];
    const units = batchDiscordMessages("999", msgs);
    check("discord batch yields one unit for a small channel", units.length === 1);
    check("discord unit is keyed by channelId:firstMsgId", units[0].key === "999:1");
    check("discord unit content skips empty and formats 'author: content'", units[0].content ===
      "alice: hello\nbob: how do I reset?\nalice: click settings");
    check("discord unit is text/plain", units[0].contentType === "text/plain");
    // batching by count: >100 non-empty messages → multiple parts
    const many: DiscordMessage[] = Array.from({ length: 250 }, (_, i) => ({
      id: String(i + 1),
      content: `msg ${i}`,
      author: { username: "u" },
    }));
    const parts = batchDiscordMessages("999", many);
    check("discord batches into ~100-message parts", parts.length === 3);
    check("discord part titles are numbered", parts[0].title === "Discord #999 (part 1)" && parts[2].title === "Discord #999 (part 3)");
  }

  // ---- SourceInput refine (contracts) ----
  {
    check("SourceInput: github requires config.repo", !SourceInput.safeParse({ kind: "github", config: {} }).success);
    check("SourceInput: github rejects a malformed repo", !SourceInput.safeParse({ kind: "github", config: { repo: "no-slash" } }).success);
    check("SourceInput: valid github passes", SourceInput.safeParse({ kind: "github", config: { repo: "owner/name" } }).success);
    check("SourceInput: discord requires config.channelId", !SourceInput.safeParse({ kind: "discord", config: {} }).success);
    check("SourceInput: valid discord passes", SourceInput.safeParse({ kind: "discord", config: { channelId: "123" } }).success);
    check("SourceInput: url still requires config.url", !SourceInput.safeParse({ kind: "url", config: {} }).success);
    check("SourceInput: valid url passes", SourceInput.safeParse({ kind: "url", config: { url: "https://x.test" } }).success);
  }

  // ---- deleteSource removes the source + its docs ----
  check("deleteSource → true", (await deleteSource(A, src.id)) === true);
  check("deleted source is gone", (await getSource(A, src.id)) === null);
  check("deleted source's docs are removed", (await docCountBySource(src.id)) === 0);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nSOURCES: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nSOURCES: all checks green");
}

main().catch((e) => {
  console.error("sources seam ERROR", e);
  process.exit(1);
});
