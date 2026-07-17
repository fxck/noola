import { pipeline, env } from "@huggingface/transformers";
import { fileURLToPath } from "node:url";

// Cache the model next to this file so the build-time warmup and the runtime
// share the same on-disk cache (shipped via deployFiles). Keyless; at runtime the
// model is read from the shipped cache — no network, no API key.
env.cacheDir = fileURLToPath(new URL("./.cache/", import.meta.url));
env.allowRemoteModels = true; // build warmup downloads once; runtime hits the cache

// all-MiniLM-L6-v2 → 384-dim sentence embeddings. Small, fast, CPU-friendly, and a
// strong general-purpose retrieval model. Swap the model here to change dimensions.
export const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
export const DIM = 384;

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) extractorPromise = pipeline("feature-extraction", MODEL_NAME);
  return extractorPromise;
}

/** Embed texts → array of 384-dim unit vectors (mean-pooled, L2-normalized). */
export async function embed(texts) {
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}
