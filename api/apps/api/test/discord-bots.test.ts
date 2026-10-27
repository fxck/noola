import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  listBots, registerBot, deleteBot, listStartableTenantBots, countStartableTenantBots, quarantineBot,
} from "../src/discord-bots.js";

// Discord Phase 6 — per-tenant BYO bot registry (mig 0080). Proves: a registered token is ENCRYPTED
// at rest ("v1:" blob, never the plaintext) and never returned by listBots; the manager's startable
// list decrypts it back; quarantine drops a bot from the startable set; and the registry is
// tenant-scoped. registerBot best-effort-verifies against Discord (a fake token → 'unverified', not
// fatal). Needs MODEL_KEY_SECRET (project var, present in the api container). Exit 1 on any fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const FAKE = "BOTTESTfaketoken.aaaaaaaaaaaaaaaaaaaaaaaa"; // 20+ chars, obviously not real

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 2,
  });
  const clean = () => superPool.query("DELETE FROM discord_bots WHERE label LIKE 'BOTTEST-%'");
  await clean();

  const bot = await registerBot(A, { label: "BOTTEST-one", token: FAKE });
  check("registerBot returns a tenant-scoped, enabled bot", bot.scope === "tenant" && bot.enabled === true && bot.tenant_id === A);
  check("registerBot flags a bad token 'unverified' (not fatal)", bot.verification_state === "unverified");
  check("registerBot never returns the token", !("token" in bot) && !("token_enc" in bot));

  // Token stored ENCRYPTED (crypto.ts "v1:" blob), not the plaintext.
  const enc = await superPool.query("SELECT token_enc FROM discord_bots WHERE id = $1", [bot.id]);
  const blob = enc.rows[0].token_enc as string;
  check("token stored as a v1: cipher blob", blob.startsWith("v1:"));
  check("token ciphertext is not the plaintext", !blob.includes(FAKE));

  const listed = await listBots(A);
  check("listBots returns the bot", listed.some((b) => b.id === bot.id));
  check("listBots masks the token", listed.every((b) => !("token_enc" in (b as Record<string, unknown>))));

  // The manager's startable list decrypts the token back to the original.
  const startable = await listStartableTenantBots();
  const mine = startable.find((s) => s.botId === bot.id);
  check("listStartableTenantBots includes the enabled bot", !!mine);
  check("startable token round-trips (decrypts to the original)", mine?.token === FAKE);
  check("countStartableTenantBots ≥ 1", (await countStartableTenantBots()) >= 1);

  // Quarantine drops it from the startable set.
  await quarantineBot(bot.id, "test_quarantine");
  const afterQ = await listStartableTenantBots();
  check("a quarantined bot is NOT startable", !afterQ.some((s) => s.botId === bot.id));
  const relisted = await listBots(A);
  check("quarantined bot shows disabled + a reason", relisted.find((b) => b.id === bot.id)?.enabled === false);

  // Tenant isolation.
  const bBot = await registerBot(B, { label: "BOTTEST-globex", token: FAKE });
  check("listBots(A) does not include Globex's bot", !(await listBots(A)).some((b) => b.id === bBot.id));

  check("deleteBot removes it", await deleteBot(A, bot.id));
  check("deleted bot is gone from listBots", !(await listBots(A)).some((b) => b.id === bot.id));
  await deleteBot(B, bBot.id);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  if (failures > 0) { console.error(`\nDISCORD-BOTS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nDISCORD PHASE 6 (bot registry): all checks green");
}

main().catch((e) => { console.error("discord-bots ERROR", e); process.exit(1); });
