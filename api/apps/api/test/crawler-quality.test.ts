import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  createSource,
  getSource,
  updateSource,
  deleteSource,
  syncSource,
  parseLlmsTxt,
  markdownVariantUrl,
  looksLikeHtml,
  type Precheck,
  type ConnectorUnit,
} from "../src/sources.js";
import { ensureChunksCollection } from "../src/search.js";

// Crawler quality (Track C): the modern-docs affordances layered onto the source connectors —
//   • /llms.txt manifest parsing (prefer a curated URL list over blind link-following),
//   • Markdown-twin URL negotiation (index clean .md over stripped HTML),
//   • a cheap revision precheck (github head SHA) that short-circuits a resync when nothing moved.
// The pure helpers are checked without the network; the short-circuit is checked end-to-end against
// Postgres with an INJECTED precheck + connector (a call counter proves the connector is skipped).

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

async function main() {
  // ── pure helpers (no network, no DB) ──────────────────────────────────────
  const base = new URL("https://docs.acme.test/start");

  {
    const body = [
      "# Acme docs",
      "> Everything you need.",
      "",
      "## Guides",
      "- [Getting started](https://docs.acme.test/guide/start)",
      "- [Billing](/guide/billing)",
      "- [External](https://other.test/x)",
      "",
      "Plain link: https://docs.acme.test/reference/api",
      "Dup: [again](https://docs.acme.test/guide/start)",
    ].join("\n");
    const urls = parseLlmsTxt(body, base);
    check("llms.txt: absolute same-origin link kept", urls.includes("https://docs.acme.test/guide/start"));
    check("llms.txt: relative link resolved to same origin", urls.includes("https://docs.acme.test/guide/billing"));
    check("llms.txt: bare same-origin URL captured", urls.includes("https://docs.acme.test/reference/api"));
    check("llms.txt: cross-origin link dropped", !urls.some((u) => u.includes("other.test")));
    check("llms.txt: duplicates collapsed", urls.filter((u) => u === "https://docs.acme.test/guide/start").length === 1);
  }

  {
    const md = (p: string) => markdownVariantUrl(new URL(p))?.toString() ?? null;
    check("md-variant: extensionless page → .md", md("https://d.test/docs/page") === "https://d.test/docs/page.md");
    check("md-variant: trailing slash → .md", md("https://d.test/docs/page/") === "https://d.test/docs/page.md");
    check("md-variant: .html → .md", md("https://d.test/docs/page.html") === "https://d.test/docs/page.md");
    check("md-variant: already .md → null", md("https://d.test/docs/page.md") === null);
    check("md-variant: .txt → null", md("https://d.test/docs/page.txt") === null);
    check("md-variant: non-page ext (.pdf) → null", md("https://d.test/files/manual.pdf") === null);
    check("md-variant: origin root → null", md("https://d.test/") === null);
    check("md-variant: query preserved on candidate", md("https://d.test/docs/page?v=2") === "https://d.test/docs/page.md?v=2");
  }

  {
    check("looksLikeHtml: doctype detected", looksLikeHtml("<!DOCTYPE html><html><head></head></html>"));
    check("looksLikeHtml: <html> detected", looksLikeHtml("\n  <html lang=\"en\">"));
    check("looksLikeHtml: real markdown is not html", !looksLikeHtml("# Title\n\nA paragraph with a [link](/x)."));
  }

  // ── github head-SHA short-circuit (Postgres, injected precheck + connector) ─
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
    await superPool.query("DELETE FROM documents WHERE filename LIKE 'CRAWLTEST%'");
    await superPool.query("DELETE FROM sources WHERE label LIKE 'CRAWLTEST%'");
  };
  await clean();

  // A connector that counts how often it actually runs — the short-circuit must NOT invoke it.
  let calls = 0;
  const countingConnector = (marker: string, n: number) => async (): Promise<ConnectorUnit[]> => {
    calls++;
    const units: ConnectorUnit[] = [];
    for (let i = 0; i < n; i++) {
      units.push({
        key: `docs/${marker}/${i}.md`,
        title: `CRAWLTEST ${marker} ${i}`,
        contentType: "text/markdown",
        content: `CRAWLTEST ${marker} page ${i}: onboarding and billing detail enough to chunk and index.`,
      });
    }
    return units;
  };
  // An injected precheck whose token we control (no network to github).
  let curToken = "sha-A";
  const fakePre: Precheck = async () => ({ token: curToken });

  const gh = await createSource(A, { kind: "github", label: "CRAWLTEST repo", config: { repo: "acme/docs", branch: "main" } });
  check("new github source has no sync token yet", gh.last_sync_token === null);

  // Sync 1: no stored token → full sync runs, token gets recorded.
  const s1 = await syncSource(A, gh.id, countingConnector("alpha", 2), fakePre);
  check("sync 1 ran the connector (no token to short-circuit on)", calls === 1);
  check("sync 1 ok + 2 docs", s1?.status === "ok" && s1.docCount === 2);
  const a1 = await getSource(A, gh.id);
  check("sync 1 recorded the head sha as the sync token", a1?.last_sync_token === "sha-A");

  // Sync 2: token unchanged → short-circuit, connector NOT called, diff all-unchanged.
  const s2 = await syncSource(A, gh.id, countingConnector("beta", 5), fakePre);
  check("sync 2 SKIPPED the connector (head unchanged)", calls === 1);
  check("sync 2 reports all docs unchanged", s2?.diff?.unchanged === 2 && s2?.diff?.added === 0 && s2?.diff?.updated === 0 && s2?.diff?.removed === 0);
  check("sync 2 kept the doc count", s2?.docCount === 2);

  // Sync 3: head moved → full sync runs again.
  curToken = "sha-B";
  const s3 = await syncSource(A, gh.id, countingConnector("beta", 5), fakePre);
  check("sync 3 ran the connector (head moved)", calls === 2);
  check("sync 3 ok + new doc count", s3?.status === "ok" && s3.docCount === 5);
  const a3 = await getSource(A, gh.id);
  check("sync 3 recorded the new head sha", a3?.last_sync_token === "sha-B");

  // Editing the source config invalidates the short-circuit token (new repo/branch/path).
  await updateSource(A, gh.id, { config: { repo: "acme/other", branch: "main" } });
  const edited = await getSource(A, gh.id);
  check("editing config resets the sync token to null", edited?.last_sync_token === null);

  // With the token cleared, the next sync runs in full even though precheck returns a token.
  const s4 = await syncSource(A, gh.id, countingConnector("gamma", 1), fakePre);
  check("sync after edit runs the connector (token was reset)", calls === 3 && s4?.status === "ok");

  check("deleteSource cleans up", (await deleteSource(A, gh.id)) === true);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nCRAWLER-QUALITY: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nCRAWLER-QUALITY: all checks green");
}

main().catch((e) => {
  console.error("crawler-quality seam ERROR", e);
  process.exit(1);
});
