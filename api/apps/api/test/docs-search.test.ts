import pg from "pg";
import { getModelConfig, putModelConfig } from "../src/modelconfig.js";
import { createArticle, deleteArticle } from "../src/kb.js";
import { ensureKbCollection } from "../src/search.js";
import { mergeQueryRuns, safeWithoutSources, suggestForQuery, suggestForQueryStream } from "../src/copilot.js";
import {
  DEFAULT_SEARCH_PROMPT, SEARCH_REPLY_FORMAT, getDocsSearchSettings, parseSearchQuery, putDocsSearchSettings, renderSearchPrompt, searchQueryFor,
} from "../src/docs-search.js";

// The docs search asks the search model for a short query, and retrieval puts that query's results first.
// A hosted model answers from a stubbed endpoint, and the DSRCH data is removed at the end.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const ENDPOINT = "https://llm.dsrch.invalid/v1";

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

async function main() {
  // ---- Prompt and reply handling, no model ----
  const rendered = renderSearchPrompt("Search {language} docs.\n{product}\nOnly the query.", { language: "English", product: "Zerops is a cloud." });
  check("the placeholders are filled", rendered === "Search English docs.\nAbout the product: Zerops is a cloud.\nOnly the query.", rendered);
  const bare = renderSearchPrompt("Search {language} docs.\n{product}\nOnly the query.", { language: "English", product: " " });
  check("an empty product line is dropped", bare === "Search English docs.\nOnly the query.", bare);
  check("the default prompt uses both placeholders", DEFAULT_SEARCH_PROMPT.includes("{language}") && DEFAULT_SEARCH_PROMPT.includes("{product}"));

  check("the query is read from its tag", parseSearchQuery("<query>custom domain DNS setup</query>") === "custom domain DNS setup");
  check("text around the tag and quotes inside it are dropped", parseSearchQuery('Sure.\n<query>"cron job\nsetup"</query>\nThis covers scheduling.') === "cron job setup");
  check("<none/> means nothing to search", parseSearchQuery("<none/>") === null);
  check("NONE inside the tag means nothing to search", parseSearchQuery("<query>NONE</query>") === null && parseSearchQuery("<query>none.</query>") === null);
  check("a query that starts with none is still searched", parseSearchQuery("<query>none of my env variables load</query>") === "none of my env variables load");
  check("an explanation without the tag is not a query", parseSearchQuery("The message logy? gives no usable product feature or problem to search for here") === null);
  check("an empty query is not a query", parseSearchQuery("<query>  </query>") === null && parseSearchQuery("") === null);
  const long = Array.from({ length: 20 }, (_, i) => `term${i}`).join(" ");
  check("a query longer than the prompt asks for is still searched", parseSearchQuery(`<query>${long}</query>`) === long);
  check("a runaway query is not searched", parseSearchQuery(`<query>${long} ${long} ${long}</query>`) === null);

  check("no reply is safe without sources", safeWithoutSources("<no_reply/>"));
  check("a note alone is safe without sources", safeWithoutSources("<internal>Billing question, a teammate should answer.</internal>"));
  check("a short question is safe without sources", safeWithoutSources("Which service is it, and what error do you see?"));
  check("a question in Japanese or Arabic counts as a question", safeWithoutSources("どのサービスですか？") && safeWithoutSources("ما هي الخدمة؟"));
  check("a short handoff is safe without sources", safeWithoutSources("I don't have that information, a teammate will help. <handoff/>"));
  check("an explanation is not safe without sources", !safeWithoutSources("Zerops doesn't expose nftables, but you can open ports in zerops.yaml under run.ports."));
  check("a long handoff is not safe without sources", !safeWithoutSources(`${"Here is how it works in detail. ".repeat(20)}<handoff/>`));
  check("a broken answer is not safe without sources", !safeWithoutSources("Sure <internal>unclosed"));

  const run = (pairs: [string, number][]) => ({
    items: pairs.map(([id]) => ({ id })), scores: new Map(pairs), ranks: new Map(pairs.map(([id], i) => [id, { keyword: i + 1 }])),
  });
  const merged = mergeQueryRuns(run([["q", 0.02]]), run([["m", 0.03], ["q", 0.01]]), (i) => i.id);
  check("a query result outranks a message result up to twice as strong", merged.items[0].id === "q", merged.items);
  check("the reported scores stay unhalved for the gate", merged.scores.get("m") === 0.03 && merged.scores.get("q") === 0.02, [...merged.scores]);
  check("a source both runs found has the ranks of the run that gave its score", merged.ranks.get("q")?.foundBy === "both" && merged.ranks.get("q")?.keyword === 1, [...merged.ranks]);
  check("a source only the message found says so", merged.ranks.get("m")?.foundBy === "message", [...merged.ranks]);

  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  superPool.on("error", () => {});
  if ((await getModelConfig(A)).provider !== "managed") throw new Error("TestCo has a hosted model, which this test would overwrite");

  let reply = "";
  let draftReply = "Here is the answer.";
  let draftFails = false;
  let lastDraftSystem = "";
  const calls: { system: string; user: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith(ENDPOINT)) return realFetch(url, init);
    const req = JSON.parse(String(init?.body ?? "{}")) as { messages: { role: string; content: string }[] };
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    let content = draftReply;
    if (system.includes("search query for") || system.includes("DSRCH custom prompt")) {
      calls.push({ system, user });
      content = reply;
    } else {
      lastDraftSystem = system;
      if (draftFails) return new Response("down", { status: 503 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const before = await getDocsSearchSettings(A);
  const articles: string[] = [];
  const queries: string[] = [];
  const ask = (q: string) => {
    queries.push(q);
    return suggestForQuery(A, q, { audience: "public", forceScope: ["kb"], source: "eval" });
  };

  try {
    // ---- Settings ----
    await superPool.query("DELETE FROM docs_search_settings WHERE tenant_id = $1", [A]);
    const def = await getDocsSearchSettings(A);
    check("by default the rewrite is on with no product and the default prompt", def.rewrite === true && def.product === "" && def.prompt === null, def);
    const saved = await putDocsSearchSettings(A, { rewrite: true, product: "  Zerops is a cloud.  ", prompt: DEFAULT_SEARCH_PROMPT });
    check("the product is trimmed and the default prompt is kept as null", saved.product === "Zerops is a cloud." && saved.prompt === null, saved);
    const custom = await putDocsSearchSettings(A, { rewrite: true, product: "Zerops is a cloud.", prompt: "DSRCH custom prompt for {language}" });
    check("a custom prompt is saved", custom.prompt === "DSRCH custom prompt for {language}", custom);
    const empty = await putDocsSearchSettings(A, { rewrite: true, product: "", prompt: "  " });
    check("an empty prompt is saved as the default", empty.prompt === null, empty);

    // ---- The query call ----
    await putModelConfig(A, { provider: "custom", endpoint: ENDPOINT, model: "dsrch-model", apiKey: "k" });
    await putDocsSearchSettings(A, { rewrite: true, product: "Zerops is a developer cloud.", prompt: null });
    reply = "<query>custom domain setup</query>";
    const q = await searchQueryFor(A, "takze a vlozit pro nej CNAME?", [
      { role: "customer", text: "I want my domain shop.example on Zerops" },
      { role: "agent", text: "Add an A record or a CNAME." },
    ]);
    const last = calls[calls.length - 1];
    check("the model's query is returned", q === "custom domain setup", q);
    check("the reply format follows the prompt", last.system.endsWith(`\n${SEARCH_REPLY_FORMAT}`), last.system.slice(-200));
    check("the product description reaches the model", last.system.includes("About the product: Zerops is a developer cloud."), last.system);
    check("the earlier turns give the model context", last.user.includes("Earlier messages:") && last.user.includes("shop.example") && last.user.includes("Latest message:"), last.user);

    reply = "<none/>";
    check("nothing to search gives no query", (await searchQueryFor(A, "ok děkuji")) === null);

    await putDocsSearchSettings(A, { rewrite: true, product: "", prompt: "DSRCH custom prompt for {language}" });
    reply = "<query>export reports</query>";
    await searchQueryFor(A, "how to export?");
    check("a custom prompt replaces the default and keeps the reply format", calls[calls.length - 1].system === `DSRCH custom prompt for English\n${SEARCH_REPLY_FORMAT}`, calls[calls.length - 1].system);

    const callsBefore = calls.length;
    await putDocsSearchSettings(A, { rewrite: false, product: "", prompt: null });
    check("with the rewrite off no model is asked", (await searchQueryFor(A, "how to export?")) === null && calls.length === callsBefore);
    await putDocsSearchSettings(A, { rewrite: true, product: "", prompt: null });

    // ---- Retrieval puts the query's results first ----
    await ensureKbCollection();
    const viaMessage = (await createArticle(A, "DSRCHMSG gadget troubleshooting", "The DSRCHMSG gadget error appears when the gadget is offline.", null, { visibility: "public" })).id;
    const viaQuery = (await createArticle(A, "DSRCHQRY widget setup", "Set up the DSRCHQRY widget from the dashboard.", null, { visibility: "public" })).id;
    articles.push(viaMessage, viaQuery);
    reply = "<query>DSRCHQRY widget setup</query>";
    const both = await ask("I get DSRCHMSG on my thing and want to set it up, please help");
    const ids = both.citations.map((c) => c.id);
    check("the query's article comes first", ids[0] === viaQuery, both.citations);
    check("the message's own match is still kept", ids.includes(viaMessage), both.citations);
    const traced = (await superPool.query("SELECT sources FROM draft_traces WHERE id = $1", [both.traceId])).rows[0]?.sources as { id: string; foundBy?: string; keywordRank?: number }[];
    check("with a search query the trace says what found each source", traced?.length > 0 && traced.every((s) => s.foundBy), traced);
    // Only the message's keyword search can find DSRCHMSG, so its keyword rank shows that the message run's ranks were kept.
    check("a source shows the ranks of the run that gave its score", traced?.find((s) => s.id === viaMessage)?.keywordRank === 1, traced);

    reply = "<none/>";
    const plain = await ask("DSRCHMSG gadget troubleshooting help");
    check("without a query the message is searched alone", plain.citations[0]?.id === viaMessage, plain.citations);

    // ---- No sources found: an empty scope finds nothing every time ----
    const sourceless = (q: string, outcomes: boolean) => {
      queries.push(q);
      // Live traffic, since eval runs never record knowledge gaps.
      return suggestForQuery(A, q, { audience: "public", forceScope: [], outcomes });
    };
    // A gap is recorded in the background, so this waits a moment for it before counting.
    const gaps = async (q: string) => {
      const count = async () =>
        (await superPool.query("SELECT count(*)::int AS n FROM knowledge_gaps WHERE tenant_id = $1 AND question = $2", [A, q])).rows[0].n as number;
      for (let i = 0; i < 20 && (await count()) === 0; i++) await new Promise((r) => setTimeout(r, 100));
      return count();
    };
    draftReply = "<no_reply/>";
    const thanks = await sourceless("ok děkuji DSRCH", true);
    check("without sources the model still answers when it can tag its answer", thanks.model !== "grounding-guard" && thanks.draft === "<no_reply/>", [thanks.model, thanks.draft]);
    check("and it is told it has no sources", lastDraftSystem.includes("You have no sources for this message"), lastDraftSystem.slice(-400));
    check("a thank-you the model leaves unanswered is not a knowledge gap", (await gaps("ok děkuji DSRCH")) === 0);
    draftReply = "I don't have that information, a teammate will help. <handoff/>";
    await sourceless("what is the DSRCH quota", true);
    check("an unanswered question without sources is still a knowledge gap", (await gaps("what is the DSRCH quota")) === 1);
    const untagged = await sourceless("what is the DSRCH limit", false);
    check("without answer tags the fixed reply goes out", untagged.model === "grounding-guard", untagged.model);
    draftFails = true;
    const failed = await sourceless("what is the DSRCH price", true);
    check("if the model fails without sources the fixed reply goes out", failed.model === "grounding-guard", failed.model);
    draftFails = false;

    draftReply = "DSRCH doesn't expose firewall rules, but you can open ports in zerops.yaml under run.ports.";
    const invented = await sourceless("can I add DSRCH firewall rules", true);
    check("an invented answer without sources is replaced by the fixed reply", invented.model === "grounding-guard", [invented.model, invented.draft]);
    draftReply = "Which DSRCH service is it, and what error do you see?";
    const question = await sourceless("DSRCH broken", true);
    check("a clarifying question without sources is sent", question.draft === draftReply && question.model !== "grounding-guard", question.draft);

    draftReply = "DSRCH doesn't expose firewall rules, but you can open ports in zerops.yaml under run.ports.";
    queries.push("can I add DSRCH firewall rules via stream");
    const stream = suggestForQueryStream(A, "can I add DSRCH firewall rules via stream", { audience: "public", forceScope: [], outcomes: true });
    let shown = "";
    let step = await stream.next();
    while (!step.done) {
      shown += step.value.delta;
      step = await stream.next();
    }
    check("the streaming lane shows none of an invented answer", !shown.includes("run.ports") && step.value.model === "grounding-guard", shown);
  } finally {
    globalThis.fetch = realFetch;
    await putModelConfig(A, { provider: "managed" });
    await putDocsSearchSettings(A, before);
    for (const id of articles) await deleteArticle(A, id);
    await superPool.query("DELETE FROM draft_traces WHERE tenant_id = $1 AND query = ANY($2)", [A, queries]);
    await superPool.query("DELETE FROM knowledge_gaps WHERE tenant_id = $1 AND question = ANY($2)", [A, queries]);
    await superPool.end();
  }

  if (failures > 0) {
    console.error(`\nDOCS SEARCH: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nDOCS SEARCH: all checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
