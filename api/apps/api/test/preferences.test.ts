import pg from "pg";
import { UserPreferencesPatch } from "@repo/contracts";
import { getPreferences, updatePreferences } from "../src/preferences.js";

// Per-member preferences: defaults, partial saves, and a stored value that stopped validating.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const agent = await superPool.query("SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1", [A]);
  const userId = agent.rows[0].id as string;
  const before = await superPool.query("SELECT prefs FROM user_preferences WHERE tenant_id = $1 AND user_id = $2", [A, userId]);
  await superPool.query("DELETE FROM user_preferences WHERE tenant_id = $1 AND user_id = $2", [A, userId]);

  check("a member without saved preferences gets the defaults", (await getPreferences(A, userId)).linkPreviews === true);
  const saved = await updatePreferences(A, userId, { linkPreviews: false });
  check("a saved preference is returned", saved.linkPreviews === false, saved);
  await updatePreferences(A, userId, {});
  check("saving other keys keeps it", (await getPreferences(A, userId)).linkPreviews === false);

  await superPool.query(
    `UPDATE user_preferences SET prefs = '{"linkPreviews": "yes", "retired": 1}'::jsonb WHERE tenant_id = $1 AND user_id = $2`, [A, userId]);
  const repaired = await getPreferences(A, userId);
  check("a stored value that no longer validates falls back to its default", repaired.linkPreviews === true && !("retired" in repaired), repaired);
  check("an unknown key is rejected", !UserPreferencesPatch.safeParse({ linkPreviews: true, colour: "red" }).success);
  check("a wrong type is rejected", !UserPreferencesPatch.safeParse({ linkPreviews: "no" }).success);

  await superPool.query("DELETE FROM user_preferences WHERE tenant_id = $1 AND user_id = $2", [A, userId]);
  if (before.rowCount) {
    await superPool.query("INSERT INTO user_preferences (tenant_id, user_id, prefs) VALUES ($1, $2, $3::jsonb)", [A, userId, JSON.stringify(before.rows[0].prefs)]);
  }
  await superPool.end();
  console.log(failures ? `\n${failures} FAILURES` : "\nPREFERENCES: all checks green");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
