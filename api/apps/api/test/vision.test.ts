import { HttpChatModelDriver, RuleModelDriver, type DraftReplyInput } from "../src/model.js";

// Vision seam: a customer's inline image (a widget screenshot) must reach a vision-capable hosted
// model as an image content-block on the user turn — not be dropped so the model answers blind. This
// test stubs global fetch, drives the hosted driver, and inspects the exact request body it PUTs on
// the wire (Anthropic + OpenAI shapes), plus the no-image regression and the rule baseline's ignore.
// No DB / network — pure driver-level assertions.

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

// A 1x1 png, base64 (payload only, no data: prefix) — the shape the widget forwards after stripping
// the data-URL header.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const realFetch = globalThis.fetch;
let lastBody: any = null;

/** Capture the request body and return a minimal, provider-shaped success so draftReply resolves. */
function stubFetch(provider: "anthropic" | "openai") {
  globalThis.fetch = (async (_url: string, init: any) => {
    lastBody = JSON.parse(init.body);
    const payload =
      provider === "anthropic"
        ? { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function inputWithImage(): DraftReplyInput {
  return {
    customerMessage: "here is the problem",
    sources: [{ title: "KB", text: "grounding" }],
    images: [{ mediaType: "image/png", dataBase64: PNG_B64 }],
  };
}

async function main() {
  // ---- Anthropic: image rides as an image content-block ----
  {
    stubFetch("anthropic");
    const d = new HttpChatModelDriver({ provider: "anthropic", model: "claude-x", apiKey: "k" });
    const r = await d.draftReply(inputWithImage());
    const content = lastBody?.messages?.[0]?.content;
    check("anthropic: user content is a block array when an image is attached", Array.isArray(content));
    check("anthropic: a text block precedes the image", content?.[0]?.type === "text");
    const img = Array.isArray(content) ? content.find((b: any) => b.type === "image") : null;
    check("anthropic: an image block is present", !!img);
    check("anthropic: image is base64 with the right media type", img?.source?.type === "base64" && img?.source?.media_type === "image/png");
    check("anthropic: image carries the raw base64 payload", img?.source?.data === PNG_B64);
    check("anthropic: draft still returns text", r.text === "ok");
  }

  // ---- Anthropic: NO image → plain string content (regression) ----
  {
    stubFetch("anthropic");
    const d = new HttpChatModelDriver({ provider: "anthropic", model: "claude-x", apiKey: "k" });
    await d.draftReply({ customerMessage: "hi", sources: [] });
    check("anthropic: no image → content stays a plain string", typeof lastBody?.messages?.[0]?.content === "string");
  }

  // ---- OpenAI-compatible: image rides as an image_url data-URL part ----
  {
    stubFetch("openai");
    const d = new HttpChatModelDriver({ provider: "openai", model: "gpt-x", apiKey: "k" });
    await d.draftReply(inputWithImage());
    const content = lastBody?.messages?.[1]?.content; // [0]=system, [1]=user
    check("openai: user content is a parts array when an image is attached", Array.isArray(content));
    const img = Array.isArray(content) ? content.find((b: any) => b.type === "image_url") : null;
    check("openai: an image_url part is present", !!img);
    check("openai: image_url is a png data URL carrying the payload", img?.image_url?.url === `data:image/png;base64,${PNG_B64}`);
  }

  // ---- OpenAI-compatible: NO image → plain string content (regression) ----
  {
    stubFetch("openai");
    const d = new HttpChatModelDriver({ provider: "openai", model: "gpt-x", apiKey: "k" });
    await d.draftReply({ customerMessage: "hi", sources: [] });
    check("openai: no image → content stays a plain string", typeof lastBody?.messages?.[1]?.content === "string");
  }

  // ---- Rule baseline: images are ignored, never crash, still drafts from sources ----
  {
    const rule = new RuleModelDriver();
    const r = await rule.draftReply(inputWithImage());
    check("rule baseline: ignores images and still returns a draft", r.text.trim().length > 0);
  }

  globalThis.fetch = realFetch;
  if (failures > 0) { console.error(`\nVISION: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nVISION: all checks green");
}

main().catch((e) => { globalThis.fetch = realFetch; console.error("vision seam ERROR", e); process.exit(1); });
