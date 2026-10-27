import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  ensureClassificationDefaults,
  getTopicRules,
  getReactionMap,
  getRiskKeywords,
  getClassificationConfig,
  replaceClassificationConfig,
  DEFAULT_TOPIC_RULES,
} from "../src/classification.js";
import { ruleTopic } from "../src/topics.js";
import { classifyRisk, BUILTIN_RISK_TAGS } from "../src/model.js";

// STUDIO-SEEDED-FLOWS #3+#4: the three classifier maps as per-tenant R2 config. Pure classifiers use
// the built-in defaults (no DB); the config layer seeds defaults on first touch, full-replaces on
// write, and — crucially — the risk keywords are ADDITIVE (built-ins always fire, tenant can only add).
// Config mutations run on Globex (B) so Acme's demo state is untouched.

const B = "22222222-2222-2222-2222-222222222222"; // Globex

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

async function main() {
  // ── pure classifiers (default built-in rules, no DB) ──────────────────────
  check("ruleTopic → billing (default rules)", ruleTopic("Invoice question", "charged twice on my subscription") === "billing");
  check("ruleTopic → refund beats billing", ruleTopic("refund please", "I want my money back for the invoice") === "refund");
  check("ruleTopic → general fallback", ruleTopic("hello", "zqxwv blorptth") === "general");

  check("classifyRisk: built-in refund guardrail fires", classifyRisk("I want a refund now").includes("refund_dispute"));
  check("classifyRisk: no false tag on a benign custom word", !classifyRisk("please help with the wombat feature").includes("escalation"));
  const extra = [{ riskTag: "escalation", keywords: ["wombat"] }];
  check("classifyRisk: additive keyword ADDS a tag", classifyRisk("please help with the wombat feature", extra).includes("escalation"));
  check("classifyRisk: additive keeps built-ins (can't loosen)", classifyRisk("I want a refund, wombat", extra).includes("refund_dispute"));
  check("BUILTIN_RISK_TAGS has the 7 built-in tags", BUILTIN_RISK_TAGS.length === 7 && BUILTIN_RISK_TAGS.includes("payment_pii"));

  // ── config layer (Globex) ─────────────────────────────────────────────────
  const superPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER,
    password: process.env.DB_SUPER_PASSWORD,
    max: 1,
  });
  const clean = async () => {
    for (const t of ["topic_rules", "slack_reaction_map", "risk_keywords", "classification_settings"]) {
      await superPool.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [B]);
    }
  };
  await clean();

  // First touch seeds topic rules + reaction map; risk keywords stay empty (additive).
  await ensureClassificationDefaults(B);
  const cfg0 = await getClassificationConfig(B);
  check("seed: topic rules match the built-in count", cfg0.topicRules.length === DEFAULT_TOPIC_RULES.length);
  check("seed: reaction map has the 6 defaults", cfg0.reactionMap.length === 6);
  check("seed: risk keywords start empty (additive)", cfg0.riskKeywords.length === 0);
  check("seed: white_check_mark → close", (await getReactionMap(B))["white_check_mark"] === "close");
  check("seed: seeded topic rules classify (billing)", ruleTopic("", "invoice overdue", await getTopicRules(B)) === "billing");

  // Full-replace all three.
  const replaced = await replaceClassificationConfig(B, {
    topicRules: [{ topic: "vip", keywords: ["enterprise deal"], enabled: true }],
    reactionMap: [{ emoji: "fire", action: "close" }],
    riskKeywords: [{ riskTag: "legal", keywords: ["subpoena"], enabled: true }],
  });
  check("replace: topic rules replaced wholesale", replaced.topicRules.length === 1 && replaced.topicRules[0].topic === "vip");
  check("replace: reaction map replaced", replaced.reactionMap.length === 1 && replaced.reactionMap[0].emoji === "fire");
  check("replace: risk keywords stored", replaced.riskKeywords.length === 1 && replaced.riskKeywords[0].riskTag === "legal");
  check("replace: reaction reader reflects new map", (await getReactionMap(B))["fire"] === "close" && (await getReactionMap(B))["white_check_mark"] === undefined);
  check("replace: additive risk from config fires via classifyRisk", classifyRisk("we just received a subpoena", await getRiskKeywords(B)).includes("legal"));
  check("replace: custom topic rule classifies", ruleTopic("", "closing the enterprise deal", await getTopicRules(B)) === "vip");

  // Clearing every table stays cleared — the marker prevents defaults from being re-seeded.
  await replaceClassificationConfig(B, { topicRules: [], reactionMap: [], riskKeywords: [] });
  const cfgEmpty = await getClassificationConfig(B); // this call also runs ensureClassificationDefaults
  check("clear stays cleared: topic rules empty (not re-seeded)", cfgEmpty.topicRules.length === 0);
  check("clear stays cleared: reaction map empty", cfgEmpty.reactionMap.length === 0);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nCLASSIFICATION: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nCLASSIFICATION: all checks green");
}

main().catch((e) => {
  console.error("classification seam ERROR", e);
  process.exit(1);
});
