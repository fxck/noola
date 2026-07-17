import { withTenant } from "@repo/db";
import type { ClassificationConfigInput } from "@repo/contracts";

// R2 config for the three classifier maps that used to be frozen in code (STUDIO-SEEDED-FLOWS #3+#4):
//   • topic_rules        — the keyword→primary-topic table (topics.ts ruleTopic floor)
//   • slack_reaction_map — the emoji→triage-action map (slack-triage.ts)
//   • risk_keywords      — ADDITIVE autoreply-guardrail patterns (model.ts classifyRisk); built-ins
//                          always apply, tenants only ADD (tighten-only, never loosen).
// topic_rules + slack_reaction_map seed their built-in defaults on first touch (classification_settings
// marker = "installed", so clearing a table stays cleared); risk_keywords starts empty. Every write
// full-replaces its table. All tenant-scoped via RLS.

export interface TopicRule { id: string; topic: string; keywords: string[]; enabled: boolean; position: number }
export interface ReactionEntry { emoji: string; action: string }
export interface RiskKeywordRule { id: string; riskTag: string; keywords: string[]; enabled: boolean }

export interface ClassificationConfig {
  topicRules: TopicRule[];
  reactionMap: ReactionEntry[];
  riskKeywords: RiskKeywordRule[];
}

// ── built-in defaults (the seed) ──────────────────────────────────────────────
// Keyword approximations of topics.ts' ordered TOPIC_RULES regexes — order preserved (position), so
// the more specific topics still win first. The floor classifier only runs when the hosted model is
// absent/failed, and topics are advisory, so substring keywords are the right fidelity here.
export const DEFAULT_TOPIC_RULES: Array<{ topic: string; keywords: string[] }> = [
  { topic: "refund", keywords: ["refund", "money back", "reimburse", "chargeback"] },
  { topic: "cancellation", keywords: ["cancel", "unsubscribe", "close my account", "terminate"] },
  { topic: "billing", keywords: ["invoice", "billing", "charge", "payment", "subscription", "price", "receipt", "card declined"] },
  { topic: "security", keywords: ["security", "breach", "hacked", "phishing", "vulnerab", "leak", "gdpr", "data request"] },
  { topic: "outage", keywords: ["outage", "downtime", "502", "503", "unavailable", "can't access", "cant access", "can't reach", "degraded"] },
  { topic: "account", keywords: ["login", "log in", "sign in", "password", "reset", "locked out", "2fa"] },
  { topic: "integration", keywords: ["integrat", "webhook", "api", "zapier", "slack", "connect to", "oauth"] },
  { topic: "shipping", keywords: ["shipping", "delivery", "tracking", "order status", "order number", "package"] },
  { topic: "feature-request", keywords: ["feature request", "would be great", "would be nice", "please add", "wish", "suggestion", "could you add", "any plans"] },
  { topic: "sales", keywords: ["pricing plan", "upgrade", "enterprise", "quote", "demo", "trial", "sales", "purchase", "seats", "license"] },
  { topic: "bug", keywords: ["bug", "error", "broken", "crash", "not working", "doesn't work", "doesnt work", "fails", "glitch", "500", "404", "freez", "stuck", "laggy", "timing out", "timed out", "time out", "times out", "timeout"] },
  { topic: "how-to", keywords: ["how do", "how can", "how to", "where do", "is it possible", "can i", "tutorial", "guide", "documentation", "docs", "help me", "setup", "set up", "configur", "getting started", "instructions", "example"] },
];

export const DEFAULT_REACTION_MAP: ReactionEntry[] = [
  { emoji: "white_check_mark", action: "close" },
  { emoji: "heavy_check_mark", action: "close" },
  { emoji: "ballot_box_with_check", action: "close" },
  { emoji: "arrows_counterclockwise", action: "reopen" },
  { emoji: "eyes", action: "assign_me" },
  { emoji: "zzz", action: "snooze" },
];

// Unicode ⇄ Slack-name aliases for the shared reaction-triage map: Slack delivers colon-names
// ("white_check_mark"), Discord delivers the raw glyph ("✅"). One canonical form (the Slack-style
// name) is stored and matched; VS-16 presentation selectors are stripped before lookup so "✔️"
// and "✔" resolve alike. Unknown input passes through as-is — a custom Discord emoji named "zzz"
// matches a "zzz" map row naturally.
const EMOJI_ALIASES: Record<string, string> = {
  "✅": "white_check_mark",
  "✔": "heavy_check_mark",
  "☑": "ballot_box_with_check",
  "🔄": "arrows_counterclockwise",
  "👀": "eyes",
  "💤": "zzz",
  "😴": "sleeping",
  "📤": "outbox_tray",
  "❌": "x",
  "👍": "+1",
  "⏰": "alarm_clock",
  "🔔": "bell",
};

export function canonicalEmojiName(raw: string): string {
  const trimmed = raw.trim().replace(/^:|:$/g, "");
  const bare = trimmed.replace(/\uFE0F/g, "");
  return EMOJI_ALIASES[bare] ?? trimmed;
}

// ── ensure-on-first-touch ─────────────────────────────────────────────────────
/** Install the built-in topic rules + reaction map once per tenant (idempotent via the marker), so
 *  the deterministic classifiers work out of the box. risk_keywords stays empty (additive). */
export async function ensureClassificationDefaults(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const marker = await c.query("SELECT 1 FROM classification_settings LIMIT 1");
    if (marker.rowCount) return;
    await c.query("INSERT INTO classification_settings (tenant_id) VALUES (current_tenant()) ON CONFLICT DO NOTHING");
    for (let i = 0; i < DEFAULT_TOPIC_RULES.length; i++) {
      const r = DEFAULT_TOPIC_RULES[i];
      await c.query(
        "INSERT INTO topic_rules (tenant_id, topic, keywords, position) VALUES (current_tenant(), $1, $2, $3)",
        [r.topic, r.keywords, i],
      );
    }
    for (const e of DEFAULT_REACTION_MAP) {
      await c.query(
        "INSERT INTO slack_reaction_map (tenant_id, emoji, action) VALUES (current_tenant(), $1, $2) ON CONFLICT DO NOTHING",
        [e.emoji, e.action],
      );
    }
  });
}

// ── hot-path readers ──────────────────────────────────────────────────────────
/** The tenant's ENABLED topic rules (ordered) — what topics.ts ruleTopic keyword-matches against. */
export async function getTopicRules(tenantId: string): Promise<Array<{ topic: string; keywords: string[] }>> {
  await ensureClassificationDefaults(tenantId);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT topic, keywords FROM topic_rules WHERE enabled = true ORDER BY position ASC, created_at ASC",
    );
    return r.rows.map((row: Record<string, unknown>) => ({ topic: row.topic as string, keywords: (row.keywords as string[]) ?? [] }));
  });
}

/** The tenant's emoji→action map — what slack-triage.ts resolves a reaction through. */
export async function getReactionMap(tenantId: string): Promise<Record<string, string>> {
  await ensureClassificationDefaults(tenantId);
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT emoji, action FROM slack_reaction_map");
    const map: Record<string, string> = {};
    for (const row of r.rows as Array<{ emoji: string; action: string }>) map[row.emoji] = row.action;
    return map;
  });
}

/** The tenant's ADDITIVE risk keyword rules (no defaults) — unioned onto the built-in RISK_RULES in
 *  classifyRisk. Empty for a tenant that hasn't added any. */
export async function getRiskKeywords(tenantId: string): Promise<Array<{ riskTag: string; keywords: string[] }>> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT risk_tag, keywords FROM risk_keywords WHERE enabled = true",
    );
    return r.rows.map((row: Record<string, unknown>) => ({ riskTag: row.risk_tag as string, keywords: (row.keywords as string[]) ?? [] }));
  });
}

// ── settings surface (full config read/write) ─────────────────────────────────
export async function getClassificationConfig(tenantId: string): Promise<ClassificationConfig> {
  await ensureClassificationDefaults(tenantId);
  return withTenant(tenantId, async (c) => {
    const topics = await c.query(
      "SELECT id, topic, keywords, enabled, position FROM topic_rules ORDER BY position ASC, created_at ASC",
    );
    const reactions = await c.query("SELECT emoji, action FROM slack_reaction_map ORDER BY emoji ASC");
    const risks = await c.query("SELECT id, risk_tag, keywords, enabled FROM risk_keywords ORDER BY created_at ASC");
    return {
      topicRules: topics.rows.map((r: Record<string, unknown>) => ({
        id: r.id as string, topic: r.topic as string, keywords: (r.keywords as string[]) ?? [],
        enabled: r.enabled as boolean, position: r.position as number,
      })),
      reactionMap: reactions.rows.map((r: Record<string, unknown>) => ({ emoji: r.emoji as string, action: r.action as string })),
      riskKeywords: risks.rows.map((r: Record<string, unknown>) => ({
        id: r.id as string, riskTag: r.risk_tag as string, keywords: (r.keywords as string[]) ?? [], enabled: r.enabled as boolean,
      })),
    };
  });
}

/** Full-replace all three tables from the Settings form (one atomic save). */
export async function replaceClassificationConfig(tenantId: string, input: ClassificationConfigInput): Promise<ClassificationConfig> {
  await ensureClassificationDefaults(tenantId); // ensure the marker exists so a full-clear stays cleared
  await withTenant(tenantId, async (c) => {
    await c.query("DELETE FROM topic_rules");
    for (let i = 0; i < input.topicRules.length; i++) {
      const r = input.topicRules[i];
      const keywords = r.keywords.map((k) => k.trim()).filter(Boolean);
      await c.query(
        "INSERT INTO topic_rules (tenant_id, topic, keywords, enabled, position) VALUES (current_tenant(), $1, $2, $3, $4)",
        [r.topic.trim(), keywords, r.enabled, i],
      );
    }
    await c.query("DELETE FROM slack_reaction_map");
    for (const e of input.reactionMap) {
      const emoji = canonicalEmojiName(e.emoji); // tolerate :emoji: paste + raw glyphs
      // 📤 is reserved by the Discord ops-mirror (promote-to-reply) — never a triage mapping.
      if (!emoji || emoji === "outbox_tray") continue;
      await c.query(
        "INSERT INTO slack_reaction_map (tenant_id, emoji, action) VALUES (current_tenant(), $1, $2) ON CONFLICT (tenant_id, emoji) DO UPDATE SET action = $2",
        [emoji, e.action],
      );
    }
    await c.query("DELETE FROM risk_keywords");
    for (const r of input.riskKeywords) {
      const keywords = r.keywords.map((k) => k.trim()).filter(Boolean);
      if (!keywords.length) continue;
      await c.query(
        "INSERT INTO risk_keywords (tenant_id, risk_tag, keywords, enabled) VALUES (current_tenant(), $1, $2, $3)",
        [r.riskTag.trim(), keywords, r.enabled],
      );
    }
  });
  return getClassificationConfig(tenantId);
}
