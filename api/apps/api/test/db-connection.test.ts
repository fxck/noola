import { appPool, relayPool, authPool } from "@repo/db";

// A database connection that errors while in use is logged and discarded instead of crashing the process.

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

async function main() {
  for (const [name, pool] of [["app", appPool], ["relay", relayPool], ["auth", authPool]] as const) {
    const client = await pool.connect();
    let threw: unknown = null;
    try {
      // An in-use connection that the server drops emits exactly this event.
      client.emit("error", new Error("Connection terminated unexpectedly"));
    } catch (e) {
      threw = e;
    } finally {
      client.release(true);
    }
    check(`a ${name} pool connection that errors while in use doesn't crash the process`, threw === null, String(threw));
  }
  const r = await appPool.query("SELECT 1 AS ok");
  check("the pool keeps serving queries afterwards", r.rows[0]?.ok === 1);

  await appPool.end();
  await relayPool.end();
  await authPool.end();
  if (failures > 0) {
    console.error(`\nDB CONNECTION: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nDB CONNECTION: all checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
