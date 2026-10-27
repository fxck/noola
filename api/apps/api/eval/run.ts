import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appPool, relayPool } from "@repo/db";
import { suggestForQuery } from "../src/copilot.js";
import { modelDriver } from "../src/model.js";
import {
  ruleScorer,
  judgeScorer,
  RECALL_THRESHOLD,
  OVERLAP_THRESHOLD,
  type Golden,
  type RuleScore,
} from "./scorers.js";

// Offline eval / regression runner. Replays a committed per-tenant golden set through
// the LIVE retrieval+draft path (suggestForQuery — same code /suggest and the gate
// use), scores each case with the deterministic ruleScorer, and diffs the aggregate
// pass-rate + per-case pass/fail against a committed baseline. Exits non-zero on a
// regression (pass-rate drop, or any previously-passing case now failing) so CI can
// gate on it. `--update-baseline` rewrites the baseline instead of diffing. Every
// replay also writes a draft_traces row with source='eval', so eval runs are
// inspectable in the same trace store as live traffic (and never pollute live
// outcome analytics). No retrieval/RRF/draft is reimplemented here — this only scores.

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args {
  tenant: string | null;
  updateBaseline: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { tenant: null, updateBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant") out.tenant = argv[++i] ?? null;
    else if (a.startsWith("--tenant=")) out.tenant = a.slice("--tenant=".length);
    else if (a === "--update-baseline") out.updateBaseline = true;
  }
  return out;
}

/** One golden per line (JSONL); blank lines and `//` comments tolerated. */
async function loadGoldens(tenant: string): Promise<Golden[]> {
  const path = join(HERE, "golden", `${tenant}.jsonl`);
  const raw = await readFile(path, "utf8");
  const goldens: Golden[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    goldens.push(JSON.parse(t) as Golden);
  }
  return goldens;
}

interface CaseResult {
  query: string;
  recall: number;
  overlap: number;
  pass: boolean;
  citedIds: string[];
  judge?: { score: number; reason: string } | null;
}

interface Baseline {
  tenant: string;
  generatedAt: string;
  thresholds: { recall: number; overlap: number };
  passRate: number;
  cases: Array<{ query: string; recall: number; overlap: number; pass: boolean }>;
}

function baselinePath(tenant: string): string {
  return join(HERE, "baselines", `${tenant}.json`);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function main() {
  const { tenant, updateBaseline } = parseArgs(process.argv.slice(2));
  if (!tenant) {
    console.error("usage: npm run eval -- --tenant <id> [--update-baseline]");
    process.exit(2);
  }

  const goldens = await loadGoldens(tenant);
  if (goldens.length === 0) {
    console.error(`no goldens found for tenant ${tenant}`);
    process.exit(2);
  }

  const judgeEnabled = process.env.EVAL_JUDGE === "1";
  const results: CaseResult[] = [];

  for (const g of goldens) {
    // The real system: hybrid retrieval + RRF + model draft, and a source='eval' trace.
    const suggestion = await suggestForQuery(tenant, g.query, { source: "eval" });
    const score: RuleScore = ruleScorer(suggestion, g);
    const judge = judgeEnabled ? await judgeScorer(modelDriver, suggestion, g) : null;
    results.push({
      query: g.query,
      recall: round(score.recall),
      overlap: round(score.overlap),
      pass: score.pass,
      citedIds: suggestion.citations.map((c) => c.id),
      judge,
    });
  }

  const passed = results.filter((r) => r.pass).length;
  const passRate = round(passed / results.length);

  // ---- readable summary ----
  console.log(`\nEVAL  tenant=${tenant}  driver=${modelDriver.name}  cases=${results.length}`);
  console.log(`thresholds: recall>=${RECALL_THRESHOLD}  overlap>=${OVERLAP_THRESHOLD}${judgeEnabled ? "  judge=on" : ""}`);
  console.log("─".repeat(72));
  for (const r of results) {
    const flag = r.pass ? "PASS" : "FAIL";
    const q = r.query.length > 42 ? r.query.slice(0, 39) + "..." : r.query;
    let line = `  ${flag}  recall=${r.recall.toFixed(2)}  overlap=${r.overlap.toFixed(2)}  ${q}`;
    if (r.judge) line += `  judge=${r.judge.score.toFixed(2)}`;
    console.log(line);
  }
  console.log("─".repeat(72));
  console.log(`pass-rate: ${(passRate * 100).toFixed(1)}%  (${passed}/${results.length})`);

  // ---- baseline: update or diff ----
  if (updateBaseline) {
    const baseline: Baseline = {
      tenant,
      generatedAt: new Date().toISOString(),
      thresholds: { recall: RECALL_THRESHOLD, overlap: OVERLAP_THRESHOLD },
      passRate,
      cases: results.map((r) => ({ query: r.query, recall: r.recall, overlap: r.overlap, pass: r.pass })),
    };
    await writeFile(baselinePath(tenant), JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log(`\nbaseline updated → baselines/${tenant}.json`);
    await shutdown();
    process.exit(0);
  }

  let baseline: Baseline | null = null;
  try {
    baseline = JSON.parse(await readFile(baselinePath(tenant), "utf8")) as Baseline;
  } catch {
    console.error(`\nno baseline for tenant ${tenant} — run with --update-baseline to seed one`);
    await shutdown();
    process.exit(2);
  }

  const prevPass = new Map(baseline.cases.map((c) => [c.query, c.pass]));
  const regressions: string[] = [];
  for (const r of results) {
    // A case that passed at baseline but fails now is a hard regression.
    if (prevPass.get(r.query) === true && !r.pass) {
      regressions.push(`case regressed: "${r.query}" (recall=${r.recall}, overlap=${r.overlap})`);
    }
  }
  // Aggregate pass-rate must not drop (tiny epsilon absorbs float noise).
  const rateDropped = passRate < baseline.passRate - 1e-9;
  if (rateDropped) {
    regressions.push(`pass-rate dropped: ${(passRate * 100).toFixed(1)}% < baseline ${(baseline.passRate * 100).toFixed(1)}%`);
  }

  console.log(`baseline:  ${(baseline.passRate * 100).toFixed(1)}%  (from ${baseline.generatedAt})`);
  if (regressions.length > 0) {
    console.error(`\nREGRESSION (${regressions.length}):`);
    for (const r of regressions) console.error(`  ✗ ${r}`);
    await shutdown();
    process.exit(1);
  }
  console.log("\nOK — no regressions vs baseline");
  await shutdown();
  process.exit(0);
}

async function shutdown() {
  await Promise.allSettled([appPool.end(), relayPool.end()]);
}

main().catch(async (e) => {
  console.error("eval runner ERROR", e);
  await shutdown().catch(() => {});
  process.exit(1);
});
