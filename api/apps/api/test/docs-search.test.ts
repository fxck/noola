import pg from "pg";
import Fastify from "fastify";
import publicApiRoutes from "../src/routes/public-api.js";
import { createApiKey, revokeApiKey } from "../src/apikeys.js";
import { getModelConfig, putModelConfig } from "../src/modelconfig.js";
import { createArticle, deleteArticle, getPublicArticleBySlug, listPublicArticles, searchPublicArticles } from "../src/kb.js";
import { ensureChunksCollection, ensureKbCollection } from "../src/search.js";
import { deleteDocument, ingestDocument } from "../src/documents.js";
import { DEFAULT_HANDOFF_RULES } from "../src/ai-outcome.js";
import { getPersona, putPersona } from "../src/persona.js";
import {
  type Candidate, candidateKey, mergeQueryRuns, passageOverlap, pickSources, rankedHigh, requiredWords, safeWithoutSources, suggestForQuery, suggestForQueryStream,
} from "../src/copilot.js";
import { createAutomation, deleteAutomation, executeAutomation } from "../src/automations.js";
import { ingestInbound } from "../src/ingest.js";
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
  const odd = renderSearchPrompt("{product}", { language: "English", product: "costs $$5, see $& and {language}" });
  check("the product text goes in as it is", odd === "About the product: costs $$5, see $& and {language}", odd);
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

  // ---- Which sources are cited, no search ----
  check("a query of one or two words must match all of them", requiredWords(1) === 1 && requiredWords(2) === 2);
  check("a longer query needs half its words, at most 4", requiredWords(3) === 2 && requiredWords(5) === 3 && requiredWords(40) === 4);
  const howTo = "Trigger a pipeline from your nodejs repository with zcli push and a personal access token that you store as a CI secret";
  const sibling = howTo.replace("nodejs", "golang");
  const other = "Shared storage is mounted into every container of the services that you connect it to";
  check("pages that differ only in a technology name overlap", passageOverlap(howTo, sibling) >= 0.6, passageOverlap(howTo, sibling));
  check("unrelated passages do not overlap", passageOverlap(howTo, other) < 0.1, passageOverlap(howTo, other));

  const doc = (id: string, page: string, text: string) => ({ kind: "document", id, item: { id, document_id: page, chunk_index: 0, text, chunk_count: 1 } }) as Candidate;
  const kb = (id: string) => ({ kind: "kb", id, item: { id, title: id, body: id } }) as unknown as Candidate;
  const ranked = (cs: Candidate[], rankOf: (i: number) => number = (i) => i + 1) => ({
    items: cs, scores: new Map<string, number>(), ranks: new Map(cs.map((c, i) => [candidateKey(c), { meaning: rankOf(i) }])),
  });
  const ids = (cs: Candidate[]) => cs.map((c) => c.id).join(",");
  const pick = (r: ReturnType<typeof ranked>) => pickSources(r.items, rankedHigh(r));
  const samePage = pick(ranked([doc("a", "p1", howTo), doc("b", "p1", other), doc("c", "p2", "Scale a service by adding containers in the GUI")]));
  check("a second passage from a cited page is left out", ids(samePage) === "a,c", ids(samePage));
  const nearCopy = pick(ranked([doc("a", "p1", howTo), doc("b", "p2", sibling), doc("c", "p3", other)]));
  check("a near-copy of a cited passage is left out", ids(nearCopy) === "a,c", ids(nearCopy));
  const capped = pick(ranked([kb("k1"), kb("k2"), kb("k3"), doc("a", "p1", howTo), doc("b", "p2", other), doc("c", "p3", "Scale a service"), doc("d", "p4", "Set up a cron job")]));
  check("each kind has its number of places", ids(capped) === "k1,k2,a,b,c", ids(capped));
  const weak = pick(ranked([doc("a", "p1", howTo), kb("k1")], (i) => (i === 0 ? 1 : 11)));
  check("a source that no search ranked in the top 10 is left out, even with a free place", ids(weak) === "a", ids(weak));
  // The message run gives this source the better score but ranks it 11th, and the query run ranks it first.
  const x = doc("x", "p9", other);
  const queryRun = { items: [x], scores: new Map([[candidateKey(x), 1 / 61]]), ranks: new Map([[candidateKey(x), { keyword: 1 }]]) };
  const messageRun = { items: [x], scores: new Map([[candidateKey(x), 2 / 71]]), ranks: new Map([[candidateKey(x), { keyword: 11, meaning: 11 }]]) };
  const bothRuns = mergeQueryRuns(queryRun, messageRun, candidateKey);
  check("a source that either run ranked in the top 10 is cited", ids(pickSources(bothRuns.items, rankedHigh(queryRun, messageRun))) === "x", [...bothRuns.ranks]);

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
  const personaBefore = await getPersona(A);
  const articles: string[] = [];
  const documents: string[] = [];
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
    const both = await ask("I get the DSRCHMSG gadget error and want to set it up, please help");
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
    // The article shares one word with this message, which is not a keyword match.
    const oneWord = await ask("DSRCHMSG question about invoices billing refunds");
    const oneWordTrace = (await superPool.query("SELECT sources FROM draft_traces WHERE id = $1", [oneWord.traceId])).rows[0]?.sources as { id: string; keywordRank?: number }[];
    check("one shared word does not make a keyword match", oneWordTrace !== undefined && !oneWordTrace.some((s) => s.id === viaMessage && s.keywordRank), oneWordTrace);
    check("a draft that can't hand off gets no handoff rules", !lastDraftSystem.includes(DEFAULT_HANDOFF_RULES.slice(0, 60)), lastDraftSystem.slice(0, 400));

    // ---- The draft reads the page around a cited passage ----
    await ensureChunksCollection();
    const filler = (n: number) => `Paragraph ${n} of the DSRCHPAGE guide covers one more setting in detail, so the page needs several passages. `.repeat(4).trim();
    const page = ["# DSRCHPAGE guide", filler(1), "## Setup", filler(2), "## Limits", "The DSRCHPAGE zorblat limit is 42 per project.", filler(3)].join("\n\n");
    const pageDoc = await ingestDocument(A, "DSRCHPAGE guide.md", "text/markdown", page);
    documents.push(pageDoc.id);
    queries.push("DSRCHPAGE zorblat limit");
    let paged = await suggestForQuery(A, "DSRCHPAGE zorblat limit", { audience: "agent", forceScope: ["document"], source: "eval" });
    for (let i = 0; i < 10 && !paged.citations.some((c) => c.id === pageDoc.id); i++) {
      await new Promise((r) => setTimeout(r, 200));
      paged = await suggestForQuery(A, "DSRCHPAGE zorblat limit", { audience: "agent", forceScope: ["document"], source: "eval" });
    }
    check("the page's passage about the limit is cited", paged.citations.some((c) => c.id === pageDoc.id), paged.citations);
    check("the draft reads the whole page around the cited passage", lastDraftSystem.includes("zorblat limit is 42") && lastDraftSystem.includes("Paragraph 1 of the DSRCHPAGE guide"), lastDraftSystem.slice(-1500));

    // ---- Customer-facing answers use only published AI agents and public articles ----
    const internal = (await createArticle(A, "DSRCHVIS quota internals", "The DSRCHVIS quota is raised by hand for big accounts.", null, { visibility: "internal" })).id;
    const draft = (await createArticle(A, "DSRCHVIS quota draft", "The DSRCHVIS quota draft text.", null, { visibility: "public", status: "draft" })).id;
    const forAi = await createArticle(A, "DSRCHVIS quota limits", "The DSRCHVIS quota allows ten projects per account.", null, { visibility: "ai" });
    articles.push(internal, draft, forAi.id);
    const forCustomer = await ask("DSRCHVIS quota");
    check("a customer-facing answer skips internal and draft articles", !forCustomer.citations.some((c) => c.id === internal || c.id === draft), forCustomer.citations);
    check("a customer-facing answer uses articles for AI agents", forCustomer.citations.some((c) => c.id === forAi.id), forCustomer.citations);
    const helpCenter = await listPublicArticles(A);
    const helpSearch = await searchPublicArticles(A, "DSRCHVIS quota");
    check("the help center never shows articles for AI agents",
      !helpCenter.some((a) => a.slug === forAi.slug) && !helpSearch.some((a) => a.slug === forAi.slug) && (await getPublicArticleBySlug(A, forAi.slug!)) === null);
    queries.push("DSRCHVIS quota raised by hand for big accounts");
    const forAgent = await suggestForQuery(A, "DSRCHVIS quota raised by hand for big accounts", { audience: "agent", forceScope: ["kb"], source: "eval" });
    check("an agent's draft still finds internal articles", forAgent.citations.some((c) => c.id === internal), forAgent.citations);
    queries.push("DSRCHVIS quota sent unreviewed");
    const unreviewed = await suggestForQuery(A, "DSRCHVIS quota sent unreviewed", { audience: "agent", forceScope: ["kb"], source: "eval", customerFacing: true });
    check("an answer sent without review skips internal and draft articles", !unreviewed.citations.some((c) => c.id === internal || c.id === draft), unreviewed.citations);
    check("an answer sent without review uses articles for AI agents", unreviewed.citations.some((c) => c.id === forAi.id), unreviewed.citations);
    // An automation's draft can reach the customer through a later reply action, so it is customer-facing too.
    const asked = await ingestInbound({ tenantId: A, authorType: "customer", subject: "DSRCHVIS automation", body: "DSRCHVIS quota" });
    queries.push("DSRCHVIS quota");
    const rule = await createAutomation(A, {
      name: "DSRCHVIS draft", trigger: "message.received", enabled: false,
      conditions: { match: "all", conditions: [] }, actions: [{ type: "rag" }],
    });
    try {
      await executeAutomation(A, rule.id, { ticketId: asked.ticketId });
      const ragSources = (await superPool.query(
        "SELECT e->>'id' AS id FROM draft_traces t, jsonb_array_elements(t.sources) e WHERE t.ticket_id = $1 AND e->>'kind' = 'kb'", [asked.ticketId],
      )).rows.map((r) => r.id as string);
      check("an automation's draft skips internal and draft articles", !ragSources.includes(internal) && !ragSources.includes(draft), ragSources);
      check("an automation's draft uses articles for AI agents", ragSources.includes(forAi.id), ragSources);
    } finally {
      await deleteAutomation(A, rule.id);
      await superPool.query("DELETE FROM tickets WHERE id = $1", [asked.ticketId]);
    }

    // ---- An API key answers from customer-facing articles unless it has answer:internal ----
    const api = Fastify();
    await api.register(publicApiRoutes);
    const answerKey = await createApiKey(A, { name: "DSRCHVIS answer", scopes: ["answer"] });
    const internalKey = await createApiKey(A, { name: "DSRCHVIS answer:internal", scopes: ["answer:internal"] });
    const internalQuestion = "DSRCHVIS quota raised by hand for big accounts";
    const hidden = ["DSRCHVIS quota internals", "DSRCHVIS quota draft"];
    const restTitles = async (secret: string) => {
      queries.push(internalQuestion);
      const r = await api.inject({ method: "POST", url: "/v1/public/answer", headers: { "x-api-key": secret }, payload: { question: internalQuestion } });
      return ((r.json() as { citations?: { title: string }[] }).citations ?? []).map((c) => c.title);
    };
    const mcpText = async (secret: string, name: string, args: Record<string, string>) => {
      queries.push(Object.values(args)[0]);
      const r = await api.inject({
        method: "POST", url: "/v1/mcp", headers: { "x-api-key": secret },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      });
      return (r.json() as { result?: { content?: { text: string }[] } }).result?.content?.[0]?.text ?? "";
    };
    try {
      const plainRest = await restTitles(answerKey.secret);
      check("the answer API skips internal and draft articles", !plainRest.some((t) => hidden.includes(t)), plainRest);
      const fullRest = await restTitles(internalKey.secret);
      check("the answer API uses internal articles with answer:internal", fullRest.includes("DSRCHVIS quota internals"), fullRest);
      const plainSearch = await mcpText(answerKey.secret, "search_knowledge", { query: "DSRCHVIS quota" });
      check("MCP search skips internal and draft articles", plainSearch.includes("DSRCHVIS quota limits") && !hidden.some((t) => plainSearch.includes(t)), plainSearch);
      const fullSearch = await mcpText(internalKey.secret, "search_knowledge", { query: "DSRCHVIS quota" });
      check("MCP search finds internal articles with answer:internal", fullSearch.includes("DSRCHVIS quota internals"), fullSearch);
      const plainAnswer = await mcpText(answerKey.secret, "answer_question", { question: internalQuestion });
      check("MCP answers skip internal and draft articles", plainAnswer !== "" && !hidden.some((t) => plainAnswer.includes(t)), plainAnswer);
      const fullAnswer = await mcpText(internalKey.secret, "answer_question", { question: internalQuestion });
      check("MCP answers use internal articles with answer:internal", fullAnswer.includes("DSRCHVIS quota internals"), fullAnswer);
    } finally {
      await revokeApiKey(A, answerKey.key.id);
      await revokeApiKey(A, internalKey.key.id);
      await api.close();
    }

    // ---- No sources found: an empty scope finds nothing every time ----
    const sourceless = (q: string, outcomes: boolean) => {
      queries.push(q);
      return suggestForQuery(A, q, { audience: "public", forceScope: [], outcomes });
    };
    draftReply = "<no_reply/>";
    const thanks = await sourceless("ok děkuji DSRCH", true);
    check("without sources the model still answers when it can tag its answer", thanks.model !== "grounding-guard" && thanks.draft === "<no_reply/>", [thanks.model, thanks.draft]);
    check("and it is told it has no sources", lastDraftSystem.includes("You have no sources for this message"), lastDraftSystem.slice(-400));
    const rulesAt = lastDraftSystem.indexOf(DEFAULT_HANDOFF_RULES);
    check("the default handoff rules come before the fixed rules", rulesAt >= 0 && rulesAt < lastDraftSystem.indexOf("You are a customer-support agent"), lastDraftSystem.slice(0, 400));
    await putPersona(A, { handoffRules: "DSRCH hand off everything about billing." });
    await sourceless("ok díky DSRCH", true);
    check("a workspace's own handoff rules replace the default", lastDraftSystem.includes("DSRCH hand off everything about billing.") && !lastDraftSystem.includes(DEFAULT_HANDOFF_RULES), lastDraftSystem.slice(0, 400));
    await putPersona(A, { handoffRules: null });
    draftReply = "I don't have that information, a teammate will help. <handoff/>";
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
    await putPersona(A, { handoffRules: personaBefore.handoffRules });
    for (const id of articles) await deleteArticle(A, id);
    for (const id of documents) await deleteDocument(A, id);
    await superPool.query("DELETE FROM draft_traces WHERE tenant_id = $1 AND query = ANY($2)", [A, queries]);
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
