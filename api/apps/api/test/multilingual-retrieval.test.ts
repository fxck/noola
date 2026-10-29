import pg from "pg";
import { getModelConfig, putModelConfig } from "../src/modelconfig.js";
import { createArticle, deleteArticle } from "../src/kb.js";
import { ensureKbCollection } from "../src/search.js";
import { keywords, mergeBest, suggestForQuery } from "../src/copilot.js";
import { getTranslationSettings, putTranslationSettings, splitMarkdown, translateArticle } from "../src/translate.js";
import { getDocsSearchSettings, putDocsSearchSettings } from "../src/docs-search.js";

// A question in another language finds the workspace's articles through its translation, and the article editor translates a pasted one.
// A hosted model answers from a stubbed endpoint, and the MLRET data is removed at the end.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const ENDPOINT = "https://llm.mlret.invalid/v1";
const CZECH = "Jak zruším předplatné?";
const SLOW = "Jak zruším předplatné? Pomalu prosím";
const TRANSLATED = "How do I cancel my MLRETSUB subscription?";

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

async function main() {
  // ---- Keywords and Markdown parts, no model ----
  const kw = keywords(CZECH);
  check("keywords keep letters with diacritics", kw.includes("předplatné") && kw.includes("zruším"), kw);

  const fenced = "```sh\nnpm install\n\nnpm run build\n```";
  const md = ["# Title", "a".repeat(1000), fenced, "b".repeat(1000), "## Next\n- one\n- two"].join("\n\n");
  const parts = splitMarkdown(md);
  check("a long article splits into parts", parts.length === 2, parts.map((p) => p.length));
  check("a code fence with a blank line stays in one part", parts.some((p) => p.includes(fenced)), parts);
  check("the parts rejoin into the article", parts.join("\n\n") === md);
  check("a part stays under the limit when its blocks allow", parts.every((p) => p.length <= 1500), parts.map((p) => p.length));

  const run = (pairs: [string, number][]) => ({ items: pairs.map(([id]) => ({ id })), scores: new Map(pairs) });
  const merged = mergeBest(run([["x", 0.02], ["y", 0.03]]), run([["x", 0.03], ["z", 0.01]]), (i) => i.id);
  check("a source found by both searches keeps its better score, not the sum", merged.scores.get("x") === 0.03, [...merged.scores]);
  check("the merged sources are ordered by score", merged.items.map((i) => i.id).join() === "x,y,z" || merged.items.map((i) => i.id).join() === "y,x,z", merged.items);
  check("each source appears once", merged.items.length === 3, merged.items);

  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  superPool.on("error", () => {});
  if ((await getModelConfig(A)).provider !== "managed") throw new Error("TestCo has a hosted model, which this test would overwrite");

  let searchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith(ENDPOINT)) return realFetch(url, init);
    const req = JSON.parse(String(init?.body ?? "{}")) as { messages: { role: string; content: string }[] };
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    let content = "Open Billing and click Cancel plan.";
    if (system.includes("search query for")) {
      searchCalls++;
      if (user === SLOW) await new Promise((r) => setTimeout(r, 8000));
      content = `<query>${TRANSLATED}</query>`;
    } else if (system.includes("translation engine for a help center")) {
      if (user.includes("FAIL")) return new Response("boom", { status: 500 });
      content = `EN ${user}`;
    }
    const finish = user.includes("CUTOFF") ? "length" : "stop";
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const settingsBefore = await getTranslationSettings(A);
  const searchBefore = await getDocsSearchSettings(A);
  let articleId: string | null = null;
  const trace = async (id: string | null) =>
    (await superPool.query("SELECT search_query, model FROM draft_traces WHERE id = $1", [id])).rows[0] as { search_query: string | null; model: string } | undefined;
  const ask = (q: string) => suggestForQuery(A, q, { audience: "public", forceScope: ["kb"] });

  try {
    await putTranslationSettings(A, { workspaceLocale: "en", autoTranslate: false });
    await ensureKbCollection();
    articleId = (await createArticle(A, "MLRETSUB subscription", "To cancel your MLRETSUB subscription, open Billing and click Cancel plan.", null, { visibility: "public" })).id;

    // Without a hosted model nothing translates the question, and the English article stays out of reach.
    const untranslated = await ask(CZECH);
    check("without a model a Czech question finds nothing", untranslated.model === "grounding-guard", untranslated.model);

    await putModelConfig(A, { provider: "custom", endpoint: ENDPOINT, model: "mlret-model", apiKey: "k" });

    const czech = await ask(CZECH);
    check("a Czech question finds the English article through its translation", czech.citations.some((c) => c.id === articleId), czech.citations);
    check("then the model answers", czech.model !== "grounding-guard", czech.model);
    check("the trace keeps the search query", (await trace(czech.traceId))?.search_query === TRANSLATED, await trace(czech.traceId));

    await putDocsSearchSettings(A, { rewrite: false, product: "", prompt: null });
    const switchedOff = await ask(CZECH);
    check("with the rewrite off a Czech question searches only itself", switchedOff.model === "grounding-guard", switchedOff.model);
    await putDocsSearchSettings(A, { rewrite: true, product: "", prompt: null });

    const callsBefore = searchCalls;
    const english = await ask(TRANSLATED);
    check("an English question also gets a search query", searchCalls === callsBefore + 1, searchCalls - callsBefore);
    check("a query identical to the question is not searched twice", (await trace(english.traceId))?.search_query === null, await trace(english.traceId));

    const started = Date.now();
    const slow = await ask(SLOW);
    const waited = Date.now() - started;
    check("a slow translation is given up on", waited < 7500 && slow.model === "grounding-guard", { waited, model: slow.model });

    // ---- Article translation ----
    const article = await translateArticle(A, { title: "Zrušení předplatného", body: md }, "en");
    check("the title is translated", article?.title === "EN Zrušení předplatného", article?.title);
    check("every part of the body is translated in order", article?.body === parts.map((p) => `EN ${p}`).join("\n\n"), article?.body.slice(0, 120));

    const failed = await translateArticle(A, { title: "Zrušení", body: `${"c".repeat(3000)}\n\nFAIL here` }, "en");
    check("a failed part fails the whole translation", failed === null, failed);

    const cut = await translateArticle(A, { title: "Zrušení", body: "Text that the model stops short on. CUTOFF" }, "en");
    check("a part cut off at the output limit fails the translation", cut === null, cut);

    await putModelConfig(A, { provider: "managed" });
    check("without a model an article is not translated", (await translateArticle(A, { title: "Zrušení", body: "Text" }, "en")) === null);
  } finally {
    globalThis.fetch = realFetch;
    await putModelConfig(A, { provider: "managed" });
    await putTranslationSettings(A, settingsBefore);
    await putDocsSearchSettings(A, searchBefore);
    if (articleId) await deleteArticle(A, articleId);
    await superPool.query("DELETE FROM draft_traces WHERE tenant_id = $1 AND query = ANY($2)", [A, [CZECH, SLOW, TRANSLATED]]);
    await superPool.query("DELETE FROM knowledge_gaps WHERE tenant_id = $1 AND question = ANY($2)", [A, [CZECH, SLOW, TRANSLATED]]);
    await superPool.end();
  }

  if (failures > 0) {
    console.error(`\nMULTILINGUAL RETRIEVAL: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nMULTILINGUAL RETRIEVAL: all checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
