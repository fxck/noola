import { appPool, relayPool, authPool } from "@repo/db";
import { setDiscordTransportForTests, type MirrorTransport, type GuildSnapshot } from "../src/discord-gateway.js";
import {
  getGuildSnapshots, resolveGuildSnapshots, syncDiscordGuildSnapshots,
} from "../src/discord-guild-cache.js";

// discord_guild_cache (0111): the Settings pages read their forum/role/channel pickers from OUR DB,
// projected from the bot's gateway cache — so they render instantly and survive a bot outage instead
// of hanging a live Discord fetch into a 504. This exercises: background sync writes a snapshot; an
// outage (snapshotGuild → null) keeps the LAST snapshot rather than blanking it; the read path fills a
// cold miss from the gateway cache and persists it. Guild-keyed relay table — no tenant context needed.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo
const GUILD = "GCTEST-guild";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A fake transport whose live cache read is controllable — set to null to simulate a bot outage.
let live: GuildSnapshot | null = {
  forums: [{ id: "f1", name: "help-forum" }],
  textChannels: [{ id: "t1", name: "general" }],
  roles: [{ id: "r1", name: "Team" }],
};
const fake: MirrorTransport = {
  snapshotGuild: (gid) => (gid === GUILD ? live : null),
  async listForums() { return []; },
  async listRoles() { return []; },
  async listTextChannels() { return []; },
  async createForumPost() { return null; },
  async createMessageThread() { return null; },
  async postToThread() { return true; },
  async setArchived() { return true; },
  async applyTags() { return true; },
  async react() { return true; },
  async memberRoleIds() { return []; },
};

async function clean() {
  await relayPool.query("DELETE FROM discord_guild_cache WHERE guild_id = $1", [GUILD]).catch(() => {});
  await relayPool.query("DELETE FROM discord_links WHERE guild_id = $1", [GUILD]).catch(() => {});
}

async function main() {
  await clean();
  await relayPool.query("INSERT INTO discord_links (guild_id, tenant_id) VALUES ($1, $2)", [GUILD, A]);
  setDiscordTransportForTests(fake);

  // ── background sync projects the gateway cache into the DB ──
  await syncDiscordGuildSnapshots();
  let snaps = await getGuildSnapshots([GUILD]);
  const s = snaps.get(GUILD);
  check("sync persisted the guild snapshot", !!s && s.forums.length === 1 && s.textChannels.length === 1 && s.roles[0]?.name === "Team");

  // ── outage: snapshotGuild → null must KEEP the last snapshot, not blank it ──
  live = null;
  await syncDiscordGuildSnapshots();
  snaps = await getGuildSnapshots([GUILD]);
  check("a bot outage keeps the last-known snapshot (not blanked)", (snaps.get(GUILD)?.forums.length ?? 0) === 1);
  live = { forums: [{ id: "f1", name: "help-forum" }], textChannels: [{ id: "t1", name: "general" }], roles: [{ id: "r1", name: "Team" }] };

  // ── read path fills a cold miss from the gateway cache and persists it ──
  await relayPool.query("DELETE FROM discord_guild_cache WHERE guild_id = $1", [GUILD]);
  const resolved = await resolveGuildSnapshots([GUILD], fake);
  check("resolve fills a cold cache miss from the gateway cache", resolved.get(GUILD)?.textChannels[0]?.name === "general");
  await sleep(80); // the persist is best-effort/fire-and-forget
  check("the cold-fill was written back for next time", !!(await getGuildSnapshots([GUILD])).get(GUILD));

  // ── no transport + cold cache → empty, never throws ──
  await relayPool.query("DELETE FROM discord_guild_cache WHERE guild_id = $1", [GUILD]);
  const none = await resolveGuildSnapshots([GUILD], null);
  check("no transport + cold cache → empty result, no throw", !none.get(GUILD));

  setDiscordTransportForTests(null);
  await clean();
  await appPool.end();
  await relayPool.end();
  await authPool.end();

  if (failures > 0) {
    console.error(`\nDISCORD-GUILD-CACHE: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nDISCORD-GUILD-CACHE: all checks passed");
}

main().catch((e) => {
  console.error("discord-guild-cache ERROR", e);
  process.exit(1);
});
