import { HttpChatModelDriver } from "../src/model.js";

// The hosted driver's model list for the settings picker, and the output budget each provider gets.
// Global fetch is stubbed, so there is no network.

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

const realFetch = globalThis.fetch;
let lastUrl = "";
let lastHeaders: Record<string, string> = {};
let lastBody: any = null;
function stub(status: number, payload: unknown) {
  globalThis.fetch = (async (url: string, init: any) => {
    lastUrl = String(url);
    lastHeaders = init?.headers ?? {};
    lastBody = init?.body ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

async function main() {
  const claude = new HttpChatModelDriver({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "k" });
  stub(200, { data: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }], has_more: false });
  const listed = await claude.listModels();
  check("anthropic: the list is read from /v1/models with the key", lastUrl === "https://api.anthropic.com/v1/models?limit=1000" && lastHeaders["x-api-key"] === "k", lastUrl);
  check("anthropic: model ids come back in the provider's order", JSON.stringify(listed) === '["claude-opus-5-5","claude-sonnet-5-5"]', listed);

  const gpt = new HttpChatModelDriver({ provider: "openai", model: "gpt-x", apiKey: "k" });
  stub(200, { data: [{ id: "gpt-5" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }, { id: "o4-mini" }, { id: "gpt-4o-mini-tts" }] });
  const chat = await gpt.listModels();
  check("openai: the list uses a bearer token", lastUrl === "https://api.openai.com/v1/models" && lastHeaders.authorization === "Bearer k", lastUrl);
  check("openai: embedding, audio and speech models are left out", JSON.stringify(chat) === '["gpt-5","o4-mini"]', chat);

  const custom = new HttpChatModelDriver({ provider: "custom", endpoint: "https://llm.example/v1/", model: "llama", apiKey: "k" });
  stub(200, { data: [{ id: "llama" }, { id: "embed-x" }] });
  check("custom: the endpoint's own list is used as is", JSON.stringify(await custom.listModels()) === '["llama","embed-x"]' && lastUrl === "https://llm.example/v1/models");

  stub(401, { error: { message: "invalid x-api-key" } });
  check("a rejected key gives an empty list", (await claude.listModels()).length === 0);

  // Current Claude models think before answering, so their drafts get room for both.
  stub(200, { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
  const drafted = await claude.draftReply({ customerMessage: "hi", sources: [] });
  check("anthropic: a draft gets an 8000-token budget", lastBody?.max_tokens === 8000, lastBody?.max_tokens);
  check("anthropic: a thinking block doesn't reach the reply", drafted.text === "ok", drafted.text);
  stub(200, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  await gpt.draftReply({ customerMessage: "hi", sources: [] });
  check("openai: a draft keeps the 1500-token budget", lastBody?.max_tokens === 1500, lastBody?.max_tokens);

  globalThis.fetch = realFetch;
  console.log(failures ? `\n${failures} FAILURES` : "\nMODEL-LIST: all checks green");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { globalThis.fetch = realFetch; console.error(e); process.exit(1); });
