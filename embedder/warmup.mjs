// Build-time warmup: instantiate the pipeline so the model downloads into ./.cache,
// which deployFiles then ships to the runtime (offline, no first-request stall).
import { embed, MODEL_NAME, DIM } from "./embed.mjs";

const v = await embed(["warmup"]);
if (!Array.isArray(v?.[0]) || v[0].length !== DIM) {
  console.error(`warmup produced unexpected shape: ${v?.[0]?.length}`);
  process.exit(1);
}
console.log(`warmed ${MODEL_NAME} — dim=${v[0].length}`);
