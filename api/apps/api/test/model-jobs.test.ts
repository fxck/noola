import pg from "pg";
import { getModelConfig, putModelConfig, resolveModelDriver, testModelConfig } from "../src/modelconfig.js";
import { suggestForQuery } from "../src/copilot.js";

// Each AI job runs on its own model and thinking level, or on the answers settings when it has none.
// A hosted model answers from a stubbed endpoint, and TestCo's model config is restored at the end.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const ENDPOINT = "https://llm.mjobs.invalid/v1";
const QUERY = "MJOBS how do I export my reports?";

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

async function rejects(fn: () => Promise<unknown>): Promise<number | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { statusCode?: number }).statusCode ?? -1;
  }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  superPool.on("error", () => {});
  if ((await getModelConfig(A)).provider !== "managed") throw new Error("TestCo has a hosted model, which this test would overwrite");

  const requests: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith(ENDPOINT)) return realFetch(url, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if (body.model === "rejects-effort" && (body.output_config || body.reasoning_effort)) {
      return new Response(JSON.stringify({ error: "effort not supported" }), { status: 400 });
    }
    const anthropic = String(url).endsWith("/messages");
    const payload = anthropic
      ? { content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      : { choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const last = () => requests[requests.length - 1] ?? {};

  try {
    // ---- Saving ----
    const saved = await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", apiKey: "k", effort: "medium", searchModel: "search-model", searchEffort: "low" });
    check("saves the answers thinking level and the search job", saved.effort === "medium" && saved.searchModel === "search-model" && saved.searchEffort === "low", saved);
    check("an unset general job stays empty", saved.generalModel === null && saved.generalEffort === null, saved);

    const kept = await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model" });
    check("a save without the job settings keeps them", kept.effort === "medium" && kept.searchModel === "search-model" && kept.searchEffort === "low", kept);

    const cleared = await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", searchModel: null });
    check("null clears a job setting", cleared.searchModel === null && cleared.searchEffort === "low", cleared);

    check("a thinking level the provider doesn't know is a 400", (await rejects(() => putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", effort: "extreme" }))) === 400);
    check("the levels above high are not offered", (await rejects(() => putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", effort: "max" }))) === 400);
    check("a custom endpoint takes no thinking level", (await rejects(() => putModelConfig(A, { provider: "custom", endpoint: ENDPOINT, model: "answers-model", effort: "low" }))) === 400);

    const switched = await putModelConfig(A, { provider: "custom", endpoint: ENDPOINT, model: "answers-model" });
    check("switching to a provider without thinking levels drops the saved ones", switched.effort === null && switched.searchEffort === null, switched);

    await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", searchModel: "claude-search" });
    const otherProvider = await putModelConfig(A, { provider: "openai", endpoint: ENDPOINT, model: "gpt-answers" });
    check("switching provider drops the other jobs' models", otherProvider.searchModel === null, otherProvider);

    // ---- Resolving each job ----
    await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", effort: "high", searchModel: "search-model", searchEffort: "low", generalModel: null, generalEffort: null });
    const answers = await resolveModelDriver(A);
    const search = await resolveModelDriver(A, { job: "search" });
    const general = await resolveModelDriver(A, { job: "general" });
    check("answers run on the answers model and level", answers.name === "anthropic:answers-model" && answers.effort === "high", [answers.name, answers.effort]);
    check("search runs on its own model and level", search.name === "anthropic:search-model" && search.effort === "low", [search.name, search.effort]);
    check("a job with no settings of its own uses the answers settings", general.name === "anthropic:answers-model" && general.effort === "high", [general.name, general.effort]);

    await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", generalEffort: "low" });
    const levelOnly = await resolveModelDriver(A, { job: "general" });
    check("a job with only a level runs the answers model at that level", levelOnly.name === "anthropic:answers-model" && levelOnly.effort === "low", [levelOnly.name, levelOnly.effort]);

    await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", generalModel: "general-model", generalEffort: null });
    const modelOnly = await resolveModelDriver(A, { job: "general" });
    check("a job with only a model runs it at the model's own level", modelOnly.name === "anthropic:general-model" && modelOnly.effort === null, [modelOnly.name, modelOnly.effort]);

    // ---- What each provider receives ----
    await search.complete!("system", "user");
    check("Anthropic gets the level as output_config.effort", JSON.stringify(last().output_config) === JSON.stringify({ effort: "low" }), last());
    check("with a level Anthropic is also asked to think", JSON.stringify(last().thinking) === JSON.stringify({ type: "adaptive" }), last());
    await modelOnly.complete!("system", "user");
    check("without a level Anthropic gets no output_config or thinking", !("output_config" in last()) && !("thinking" in last()), last());

    await putModelConfig(A, { provider: "openai", endpoint: ENDPOINT, model: "answers-model", effort: "medium" });
    await (await resolveModelDriver(A)).complete!("system", "user");
    check("OpenAI gets the level as reasoning_effort", last().reasoning_effort === "medium" && !("output_config" in last()), last());
    check("with a level OpenAI gets the limits a reasoning model accepts", typeof last().max_completion_tokens === "number" && !("max_tokens" in last()) && !("temperature" in last()), last());
    await putModelConfig(A, { provider: "openai", endpoint: ENDPOINT, model: "answers-model", effort: null });
    await (await resolveModelDriver(A)).complete!("system", "user");
    check("without a level OpenAI keeps max_tokens and temperature", typeof last().max_tokens === "number" && last().temperature === 0.3 && !("reasoning_effort" in last()), last());

    await putModelConfig(A, { provider: "custom", endpoint: ENDPOINT, model: "answers-model" });
    await (await resolveModelDriver(A)).complete!("system", "user");
    check("a custom endpoint gets neither", !("reasoning_effort" in last()) && !("output_config" in last()), last());

    // ---- Connection test per job ----
    await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", effort: "high", searchModel: "rejects-effort", searchEffort: "low", generalModel: null, generalEffort: null });
    const tested = await testModelConfig(A);
    const searchTest = tested.jobs.find((j) => j.job === "search");
    check("the connection test tries a job with its own settings", !!searchTest && searchTest.ok === false && /400/.test(searchTest.error ?? ""), tested);
    check("a job on the answers settings isn't tested twice", !tested.jobs.some((j) => j.job === "general"), tested.jobs);
    check("one failing job fails the whole test and names the error", tested.ok === false && /400/.test(tested.error ?? ""), tested);

    // ---- The trace keeps the level ----
    await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "answers-model", effort: "high", searchModel: null, searchEffort: null });
    const s = await suggestForQuery(A, QUERY, { source: "eval" });
    const tr = await superPool.query("SELECT model, effort FROM draft_traces WHERE id = $1", [s.traceId]);
    check("the trace records the thinking level", tr.rows[0]?.effort === "high" && tr.rows[0]?.model === "anthropic:answers-model", tr.rows[0]);
  } finally {
    globalThis.fetch = realFetch;
    await putModelConfig(A, { provider: "managed" });
    await superPool.query("DELETE FROM draft_traces WHERE tenant_id = $1 AND query = $2", [A, QUERY]);
    await superPool.query("DELETE FROM knowledge_gaps WHERE tenant_id = $1 AND question = $2", [A, QUERY]);
    await superPool.end();
  }

  if (failures > 0) {
    console.error(`\nMODEL JOBS: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nMODEL JOBS: all checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
