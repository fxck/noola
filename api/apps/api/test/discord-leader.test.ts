import { relayPool } from "@repo/db";
import { isDiscordEventLeader, leaderEligible, probeDiscordLeaderNow, startDiscordLeaderElection } from "../src/discord-leader.js";

// Gateway-event leadership (discord-leader.ts): a process leads only while its gateway is connected, and a
// leader rides out a short drop so the events Discord replays on resume are still handled. Uses the real
// advisory lock on the dev DB, so nothing else may hold it while this runs (no api server against this DB).

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

async function main() {
  const now = 1_000_000;
  check("connected → eligible", leaderEligible(null, false, now));
  check("a follower whose gateway is down is not eligible", !leaderEligible(now - 1, false, now));
  check("a leader keeps the lock through a short drop", leaderEligible(now - 59_000, true, now));
  check("a leader steps down after a long drop", !leaderEligible(now - 61_000, true, now));

  let downSince: number | null = Date.now();
  let acquired = 0;
  startDiscordLeaderElection({ gatewayDownSince: () => downSince, onAcquired: () => { acquired++; } });
  await new Promise((r) => setTimeout(r, 500));
  check("no leadership before the gateway connects", !isDiscordEventLeader() && acquired === 0);

  downSince = null;
  probeDiscordLeaderNow();
  check("connecting takes the lock at once", await waitFor(() => isDiscordEventLeader()));
  check("onAcquired fires once", acquired === 1);

  const held = await relayPool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 7337 AND objid = 1 AND granted",
  );
  check("the advisory lock is held in Postgres", held.rows[0].n === 1);

  await relayPool.end();
  if (failures > 0) {
    console.error(`\nDISCORD-LEADER: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nDISCORD-LEADER: all checks green");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
