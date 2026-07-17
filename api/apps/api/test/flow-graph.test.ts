import { runGraph, interpolate } from "../src/automations.js";

// Lane 1 graph engine seam. runGraph walks a DAG from the trigger, routes a branch's true/false
// out-edges, reuses runAction for action nodes, and threads each node's output into ctx.steps
// for {{steps.<id>.<field>}} data-passing. The action nodes are `assign` with NO ticket in ctx
// (they no-op to ok:false, no DB) so the test observes ROUTING by which action's result comes
// back — pure engine logic, no DB needed.

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

const graph = {
  nodes: [
    { id: "t", type: "trigger", config: {} },
    { id: "b", type: "branch", config: { conditions: { match: "all", conditions: [{ field: "subject", op: "contains", value: "refund" }] } } },
    { id: "yes", type: "action", config: { action: { type: "assign", assigneeId: "c0000000-0000-0000-0000-000000000001" } } },
    { id: "no", type: "action", config: { action: { type: "assign", assigneeId: "c0000000-0000-0000-0000-000000000002" } } },
  ],
  edges: [
    { from: "t", to: "b" },
    { from: "b", to: "yes", when: "true" },
    { from: "b", to: "no", when: "false" },
  ],
};

async function main() {
  check("interpolate resolves a flat field", interpolate("hi {{subject}}", { subject: "refund" } as never) === "hi refund");
  check("interpolate resolves a nested step output", interpolate("{{steps.b.matched}}", { steps: { b: { matched: true } } } as never) === "true");

  // subject contains "refund" → true branch → only `yes` runs
  const ctxT = { event: "ticket.created", subject: "please refund me" } as Record<string, unknown> & { steps?: Record<string, { matched?: boolean }> };
  const rT = await runGraph("t-none", graph as never, ctxT as never);
  check("true branch: exactly one action ran", rT.length === 1);
  check("true branch: branch step output matched=true", ctxT.steps?.b?.matched === true);

  // subject WITHOUT "refund" → false branch → only `no` runs
  const ctxF = { event: "ticket.created", subject: "hello world" } as Record<string, unknown> & { steps?: Record<string, { matched?: boolean }> };
  const rF = await runGraph("t-none", graph as never, ctxF as never);
  check("false branch: exactly one action ran", rF.length === 1);
  check("false branch: branch step output matched=false", ctxF.steps?.b?.matched === false);

  check("branch prunes the untaken path (never both)", rT.length === 1 && rF.length === 1);

  if (failures > 0) { console.error(`\nFLOW-GRAPH: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nFLOW-GRAPH: all checks green");
  process.exit(0);
}
main().catch((e) => { console.error("flow-graph seam ERROR", e); process.exit(1); });
