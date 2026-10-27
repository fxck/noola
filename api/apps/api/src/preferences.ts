import { withTenant } from "@repo/db";
import { UserPreferences } from "@repo/contracts";

/** A member's preferences. A stored value that no longer validates falls back to its default, and the rest are kept. */
export async function getPreferences(tenantId: string, userId: string): Promise<UserPreferences> {
  const stored = await withTenant(tenantId, (c) =>
    c.query<{ prefs: Record<string, unknown> }>("SELECT prefs FROM user_preferences WHERE user_id = $1", [userId]),
  );
  const raw = stored.rows[0]?.prefs ?? {};
  const parsed = UserPreferences.safeParse(raw);
  if (parsed.success) return parsed.data;
  const kept = Object.fromEntries(
    Object.entries(raw).filter(([k, v]) => UserPreferences.shape[k as keyof UserPreferences]?.safeParse(v).success),
  );
  return UserPreferences.parse(kept);
}

/** Saves only the given keys, so two settings saved from different tabs don't overwrite each other. */
export async function updatePreferences(tenantId: string, userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
  await withTenant(tenantId, (c) =>
    c.query(
      `INSERT INTO user_preferences (tenant_id, user_id, prefs) VALUES (current_tenant(), $1, $2::jsonb)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET prefs = user_preferences.prefs || EXCLUDED.prefs, updated_at = now()`,
      [userId, JSON.stringify(patch)],
    ),
  );
  return getPreferences(tenantId, userId);
}
