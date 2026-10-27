import http from "node:http";
import { embed, MODEL_NAME, DIM } from "./embed.mjs";

// Minimal, dependency-free HTTP surface (no framework — keep the sidecar tiny):
//   GET  /health            → { ok, model, dim }
//   POST /embed {texts[]}   → { vectors: number[][], dim, model }
// Internal-only; the api calls it over the project network via the EmbeddingDriver.

const PORT = Number(process.env.PORT ?? 3001);
const MAX_TEXTS = 256;

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 8_000_000) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, model: MODEL_NAME, dim: DIM });
  }
  if (req.method === "POST" && req.url === "/embed") {
    try {
      const { texts } = JSON.parse((await readBody(req)) || "{}");
      if (!Array.isArray(texts) || texts.some((t) => typeof t !== "string")) {
        return send(res, 400, { error: "texts must be string[]" });
      }
      if (texts.length === 0) return send(res, 200, { vectors: [], dim: DIM, model: MODEL_NAME });
      if (texts.length > MAX_TEXTS) return send(res, 400, { error: `max ${MAX_TEXTS} texts per call` });
      const vectors = await embed(texts);
      return send(res, 200, { vectors, dim: DIM, model: MODEL_NAME });
    } catch (err) {
      return send(res, 500, { error: String(err?.message ?? err) });
    }
  }
  send(res, 404, { error: "not found" });
});

// Warm the model at boot so the first real request isn't slow.
embed(["warmup"]).then(() => console.log("embedder ready")).catch((e) => console.error("boot warmup failed", e));

server.listen(PORT, "0.0.0.0", () => console.log(`embedder listening on :${PORT} (${MODEL_NAME}, ${DIM}d)`));
