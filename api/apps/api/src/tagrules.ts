import { withTenant } from "@repo/db";
import type { TagRulesConfigInput } from "@repo/contracts";
import { ensureTagDefaults, projectAutotag } from "./seedflows.js";

// Auto-tagging config (mig 0084): the tenant-facing read/write over tag_rules + tag_settings that
// the Settings form drives. Every write full-replaces the rule set (mirrors the projection's
// full-replace) and re-projects the managed 'autotag' automations. The always-on baseline is
// preserved by ensureTagDefaults (seeds the built-in rules on first touch).

export interface TagRule {
  id: string;
  tag: string;
  keywords: string[];
  enabled: boolean;
  position: number;
}
export interface TagConfig {
  aiEnabled: boolean;
  rules: TagRule[];
}

/** Live read of the tenant's ENABLED keyword rules (no default-seeding side-effect) — the hot-path
 *  read the `apply_tag_rules` engine action uses on every ticket.created. Empty when unconfigured. */
export async function getEnabledTagRules(tenantId: string): Promise<Array<{ tag: string; keywords: string[] }>> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT tag, keywords FROM tag_rules WHERE enabled = true ORDER BY position ASC, created_at ASC",
    );
    return r.rows.map((row: Record<string, unknown>) => ({ tag: row.tag as string, keywords: (row.keywords as string[]) ?? [] }));
  });
}

/** Read the tenant's tag config, installing the built-in defaults on first access. */
export async function getTagConfig(tenantId: string): Promise<TagConfig> {
  await ensureTagDefaults(tenantId);
  return withTenant(tenantId, async (c) => {
    const s = await c.query("SELECT ai_enabled FROM tag_settings LIMIT 1");
    const r = await c.query(
      "SELECT id, tag, keywords, enabled, position FROM tag_rules ORDER BY position ASC, created_at ASC",
    );
    return {
      aiEnabled: s.rowCount ? Boolean(s.rows[0].ai_enabled) : true,
      rules: r.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        tag: row.tag as string,
        keywords: (row.keywords as string[]) ?? [],
        enabled: row.enabled as boolean,
        position: row.position as number,
      })),
    };
  });
}

/** Full-replace the tenant's tag rules + AI toggle, then re-project the managed automations. */
export async function replaceTagConfig(tenantId: string, input: TagRulesConfigInput): Promise<TagConfig> {
  await ensureTagDefaults(tenantId); // ensure the settings row exists before we upsert it
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO tag_settings (tenant_id, ai_enabled) VALUES (current_tenant(), $1)
       ON CONFLICT (tenant_id) DO UPDATE SET ai_enabled = $1, updated_at = now()`,
      [input.aiEnabled],
    );
    await c.query("DELETE FROM tag_rules");
    for (let i = 0; i < input.rules.length; i++) {
      const rule = input.rules[i];
      const keywords = rule.keywords.map((k) => k.trim()).filter(Boolean);
      await c.query(
        `INSERT INTO tag_rules (tenant_id, tag, keywords, enabled, position)
         VALUES (current_tenant(), $1, $2, $3, $4)`,
        [rule.tag.trim(), keywords, rule.enabled, i],
      );
    }
  });
  await projectAutotag(tenantId);
  return getTagConfig(tenantId);
}

/** Install + project auto-tagging for a freshly-created tenant (org-creation hook), so tagging is
 *  always-on from the first ticket without waiting for the next boot backfill. Best-effort. */
export async function initTenantAutotag(tenantId: string): Promise<void> {
  try {
    await ensureTagDefaults(tenantId);
    await projectAutotag(tenantId);
  } catch {
    /* best-effort — the boot backfill will retry on the next deploy */
  }
}
