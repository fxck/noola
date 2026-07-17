import { appPool, relayPool } from "@repo/db";
import { routeTelegramOutbound, telegramConfigured } from "../src/telegram.js";
import { routeWhatsAppOutbound, whatsappConfigured, verifyWhatsAppChallenge } from "../src/whatsapp.js";
import { CHANNEL_DRIVERS, getChannelDriver, channelCatalog } from "../src/channels/registry.js";
import { splitForDiscord } from "../src/channels/format.js";

// Wave 4 — channel registry + Telegram/WhatsApp driver seams. All checks run with NO channel creds in
// the env, so every network-touching path must degrade to an honest no-op (never a throw, never a
// fake "delivered"). The verify handshake + catalog shape are pure. Needs Postgres only (catalog reads
// connection counts). Run under the demo tenant.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

async function main() {
  // ---- credential gates: off without env ----
  check("telegram not configured without token", telegramConfigured() === false);
  check("whatsapp not configured without token", whatsappConfigured() === false);

  // ---- outbound refuses (honest no-op) when unconfigured ----
  // (0092: drivers are tenant-scoped now — no connection row + no env fallback = refuse.)
  const tg = await routeTelegramOutbound({ tenantId: A, channelType: "telegram", externalChannelId: "123" }, "hi");
  check("telegram outbound → not delivered when unconfigured", tg.delivered === false && tg.reason === "telegram-send-failed");
  const tgWrong = await routeTelegramOutbound({ tenantId: A, channelType: "email", externalChannelId: "x" }, "hi");
  check("telegram outbound → rejects non-telegram routing", tgWrong.delivered === false && tgWrong.reason === "not-telegram");

  const wa = await routeWhatsAppOutbound({ tenantId: A, channelType: "whatsapp", externalChannelId: "441234" }, "hi");
  check("whatsapp outbound → not delivered when unconfigured", wa.delivered === false && wa.reason === "whatsapp-send-failed");

  // ---- WhatsApp verify handshake (async since 0092 — also accepts per-tenant tokens) ----
  // No WHATSAPP_VERIFY_TOKEN set → any token fails.
  check("whatsapp verify → rejects when no verify token configured", (await verifyWhatsAppChallenge({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "c" })) === null);
  process.env.WHATSAPP_VERIFY_TOKEN = "secret123";
  check("whatsapp verify → echoes challenge on token match", (await verifyWhatsAppChallenge({ "hub.mode": "subscribe", "hub.verify_token": "secret123", "hub.challenge": "chal-42" })) === "chal-42");
  check("whatsapp verify → rejects token mismatch", (await verifyWhatsAppChallenge({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "c" })) === null);
  check("whatsapp verify → rejects wrong mode", (await verifyWhatsAppChallenge({ "hub.mode": "unsubscribe", "hub.verify_token": "secret123", "hub.challenge": "c" })) === null);
  delete process.env.WHATSAPP_VERIFY_TOKEN;

  // ---- registry shape ----
  const ids = CHANNEL_DRIVERS.map((d) => d.id);
  check("registry has discord/email/slack/telegram/whatsapp", ["discord", "email", "slack", "telegram", "whatsapp"].every((k) => ids.includes(k)));
  check("getChannelDriver resolves telegram", getChannelDriver("telegram")?.label === "Telegram");
  check("getChannelDriver unknown → undefined", getChannelDriver("nope") === undefined);
  check("every driver has a dispatch seam", CHANNEL_DRIVERS.every((d) => typeof d.dispatch === "function"));

  // ---- catalog: self-serve posture (0092) — always credentialed, connected = has a row ----
  const cat = await channelCatalog(A);
  const tgCat = cat.find((c) => c.id === "telegram")!;
  const waCat = cat.find((c) => c.id === "whatsapp")!;
  check("telegram catalog: credentialed (self-serve), not connected", tgCat.credentialed === true && tgCat.connected === false);
  check("whatsapp catalog: credentialed (self-serve), not connected", waCat.credentialed === true && waCat.connected === false);
  check("catalog covers all 5 drivers", cat.length === CHANNEL_DRIVERS.length);

  // ---- splitForDiscord (0078): chunk >2000-char bodies without breaking a code fence ----
  {
    check("short body passes through as one chunk", splitForDiscord("hello world").length === 1 && splitForDiscord("hello world")[0] === "hello world");

    // Two big paragraphs (1500 each) → two chunks, each under 2000, breaking on the blank line.
    const para = "x".repeat(1500);
    const two = splitForDiscord(`${para}\n\n${para}`);
    check("splits on paragraph boundary under the limit", two.length === 2 && two.every((c) => c.length <= 2000));
    check("no chunk contains the paragraph join artifact", two.every((c) => !c.includes("x\n\nx")));

    // A ~3000-char single wall of text with no breaks → hard-sliced, every chunk ≤ 2000.
    const wall = "abcde".repeat(600); // 3000 chars, no whitespace
    const walls = splitForDiscord(wall);
    check("hard-slices an unbreakable wall under the limit", walls.length >= 2 && walls.every((c) => c.length <= 2000));
    check("hard-slice preserves total content", walls.join("") === wall);

    // A fenced block surrounded by big paragraphs (total > 2000) must land WHOLE in one chunk —
    // never split mid-fence (a ``` carried across two messages renders as broken code on both).
    const fence = "```\n" + "line\n".repeat(300) + "```"; // ~1507 chars, one paragraph (no blank line)
    const withText = "i".repeat(1500) + "\n\n" + fence + "\n\n" + "o".repeat(1500);
    const fchunks = splitForDiscord(withText, 2000);
    check("splits a fence-plus-prose body into multiple chunks", fchunks.length >= 2 && fchunks.every((c) => c.length <= 2000));
    check("code fence is never split across chunks", fchunks.some((c) => c.includes(fence)));

    // A custom small limit exercises the boundary logic deterministically.
    const small = splitForDiscord("aaaa\n\nbbbb\n\ncccc", 10);
    check("respects a custom limit", small.every((c) => c.length <= 10) && small.join("").includes("aaaa"));
  }

  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nCHANNELS: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nCHANNELS: all checks passed");
}

main().catch((e) => {
  console.error("channels seam ERROR", e);
  process.exit(1);
});
