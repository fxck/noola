import { parseAgentDecision, runAgent } from "../src/automations.js";

// Lane 4 agent-node seam. Two halves, both DB-free:
//  1. parseAgentDecision — the brittle bit: pull the first balanced JSON object out of a model
//     completion (which may wrap it in prose / code fences), string-aware so braces inside a
//     string value don't fool the matcher.
//  2. runAgent under FORCE_RULE_MODEL=1 — the extractive baseline exposes no complete(), so the
//     node must no-op ("skipped") with zero executed actions. This is the deterministic, no-paid-
//     call path the eval/test flows rely on, and it short-circuits before any DB access.

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  // ── parseAgentDecision ──
  const plain = parseAgentDecision('{"action":{"type":"reply","body":"hi"},"reason":"greet"}');
  check("plain JSON action parses", plain?.action?.type === "reply" && plain?.action?.body === "hi");

  const fenced = parseAgentDecision('Sure, here you go:\n```json\n{"done":true,"summary":"nothing to do"}\n```');
  check("JSON inside prose + code fence is extracted", fenced?.done === true && fenced?.summary === "nothing to do");

  const nested = parseAgentDecision('{"action":{"type":"reply","body":"use {{steps.a}} and {nested}"}}');
  check("braces inside a string value don't break brace-matching", nested?.action?.body === "use {{steps.a}} and {nested}");

  check("garbage returns null", parseAgentDecision("no json here at all") === null);
  check("truncated/unbalanced returns null", parseAgentDecision('{"action": {"type":"reply"') === null);

  const leading = parseAgentDecision('```\n{"action":{"type":"set_status","status":"closed"}}\n```');
  check("set_status action parses through a bare fence", leading?.action?.type === "set_status" && leading?.action?.status === "closed");

  // ── runAgent deterministic no-model path ──
  process.env.FORCE_RULE_MODEL = "1";
  const ctx = { event: "message.received", subject: "Refund?", body: "I want a refund", steps: {} } as Record<string, unknown>;
  const out = await runAgent("33333333-3333-3333-3333-333333333333", { instructions: "help", tools: ["reply"] }, ctx as never);
  check("no hosted model → agent node is skipped", (out.output as { agent?: string }).agent === "skipped");
  check("skipped agent executes zero actions", out.results.length === 0);

  if (failures > 0) { console.error(`\nFLOW-AGENT: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nFLOW-AGENT: all checks green");
  process.exit(0);
}
main().catch((e) => { console.error("flow-agent seam ERROR", e); process.exit(1); });
