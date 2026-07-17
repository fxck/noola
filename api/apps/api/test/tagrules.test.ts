import pg from "pg";
import { withTenant } from "@repo/db";
import { ensureTagDefaults, projectAutotag } from "../src/seedflows.js";
import { getTagConfig, replaceTagConfig } from "../src/tagrules.js";
import { runAutomations, graduateAutomation, getAutomation, createAutomation } from "../src/automations.js";
import { DEFAULT_TAG_RULES } from "../src/autotag.js";

// Auto-tagging → seeded managed flow (STUDIO-SEEDED-FLOWS.md #1):
//   • ensureTagDefaults installs the built-in rules once (respects a tenant who cleared them);
//   • projectAutotag renders tag_rules + tag_settings into managed 'autotag' ticket.created flows
//     (one add_tags per rule + an ai_tag flow), ordered BEFORE routing (year-2000 created_at), no stop;
//   • end-to-end: the engine fires the projected flows and tags a real ticket from its text;
//   • replaceTagConfig full-replaces + re-projects; AI toggle adds/removes the ai_tag flow;
//   • graduateAutomation forks a managed flow into an editable disabled draft + disables the source.
// Synthetic tenant UUID (never the seeded Acme/Globex data). Needs Postgres only.

const T = "eeeeeeee-1111-4000-8000-0000000000f1";
const TK = "eeeeeeee-1111-4000-8000-0000000000f2";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function autotagRows(): Promise<Array<{ name: string; conditions: unknown; actions: Array<{ type: string }>; created_at: string; trigger_event: string; enabled: boolean }>> {
  return withTenant(T, async (c) => {
    const r = await c.query(
      "SELECT name, conditions, actions, created_at, trigger_event, enabled FROM automations WHERE managed_by = 'autotag' ORDER BY created_at ASC",
    );
    return r.rows;
  });
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query(`DELETE FROM automation_runs WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM automations WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM tag_rules WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM tag_settings WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM tickets WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM tenants WHERE id = $1`, [T]);
  };
  await clean();
  await superPool.query(`INSERT INTO tenants (id, name) VALUES ($1,'TagTest') ON CONFLICT (id) DO NOTHING`, [T]);

  // ---- ensureTagDefaults ----
  await ensureTagDefaults(T);
  let cfg = await getTagConfig(T);
  check("defaults installed: rule count matches DEFAULT_TAG_RULES", cfg.rules.length === DEFAULT_TAG_RULES.length);
  check("defaults installed: ai_enabled defaults true", cfg.aiEnabled === true);
  check("defaults installed: a billing rule with keywords exists",
    cfg.rules.some((r) => r.tag === "billing" && r.keywords.includes("invoice")));

  // Idempotent: a second ensure does not duplicate.
  await ensureTagDefaults(T);
  cfg = await getTagConfig(T);
  check("ensureTagDefaults idempotent (no duplicate rules)", cfg.rules.length === DEFAULT_TAG_RULES.length);

  // Respects a tenant who cleared every rule (row present ⇒ no re-seed).
  await withTenant(T, async (c) => { await c.query("DELETE FROM tag_rules"); });
  await ensureTagDefaults(T);
  cfg = await getTagConfig(T);
  check("ensureTagDefaults does NOT re-seed after a deliberate clear", cfg.rules.length === 0);

  // ---- projectAutotag shape: ONE managed "Auto-tagging" flow, not one-per-tag ----
  await replaceTagConfig(T, {
    aiEnabled: true,
    rules: [
      { tag: "billing", keywords: ["invoice", "billing"], enabled: true },
      { tag: "refund", keywords: ["refund", "money back"], enabled: true },
    ],
  });
  let rows = await autotagRows();
  check("projection: exactly ONE managed autotag flow (not one-per-tag)", rows.length === 1);
  check("projection: named 'Auto-tagging' on ticket.created", rows[0]?.name === "Auto-tagging" && rows[0]?.trigger_event === "ticket.created");
  check("projection: actions = apply_tag_rules + ai_tag (AI on)",
    rows[0]?.actions.map((a) => a.type).join(",") === "apply_tag_rules,ai_tag");
  check("projection: no stop action", !rows[0]?.actions.some((a) => a.type === "stop"));
  check("projection: ordered before routing (year-2000 created_at)", new Date(rows[0].created_at).getUTCFullYear() === 2000);

  // AI toggle OFF → the single flow keeps apply_tag_rules, drops ai_tag.
  await replaceTagConfig(T, { aiEnabled: false, rules: [{ tag: "billing", keywords: ["invoice"], enabled: true }] });
  rows = await autotagRows();
  check("ai toggle off: still ONE flow", rows.length === 1);
  check("ai toggle off: actions = apply_tag_rules only", rows[0]?.actions.map((a) => a.type).join(",") === "apply_tag_rules");

  // Ordering guarantee vs routing: a routing-managed row uses now(); autotag rows must sort first.
  await withTenant(T, async (c) => {
    await c.query(
      `INSERT INTO automations (tenant_id, name, enabled, trigger_event, conditions, actions, managed_by)
       VALUES (current_tenant(), 'Route', true, 'ticket.created', '{"match":"all","conditions":[]}'::jsonb,
               '[{"type":"assign","strategy":"round_robin"},{"type":"stop"}]'::jsonb, 'routing')`,
    );
  });
  const ordered = await withTenant(T, async (c) => {
    const r = await c.query(
      "SELECT managed_by FROM automations WHERE trigger_event = 'ticket.created' AND enabled ORDER BY created_at ASC",
    );
    return r.rows.map((x: { managed_by: string }) => x.managed_by);
  });
  check("engine order: autotag before routing", ordered[0] === "autotag" && ordered[ordered.length - 1] === "routing");

  // ---- end-to-end: apply_tag_rules tags a real ticket from its text (live config read) ----
  await replaceTagConfig(T, {
    aiEnabled: true, // ai_tag no-ops (no hosted model) — must not break the run
    rules: [
      { tag: "billing", keywords: ["invoice", "billing"], enabled: true },
      { tag: "refund", keywords: ["refund"], enabled: true },
      { tag: "shipping", keywords: ["delivery"], enabled: true },
      { tag: "empty", keywords: [], enabled: true }, // no keywords → never matches (must not tag everything)
    ],
  });
  // Remove the routing flow so its `stop` can't be blamed for anything (order already asserted).
  await withTenant(T, async (c) => { await c.query("DELETE FROM automations WHERE managed_by = 'routing'"); });
  await superPool.query(
    `INSERT INTO tickets (tenant_id, id, subject, channel_type) VALUES ($1,$2,'Need help','synthetic')`,
    [T, TK],
  );
  await runAutomations(T, "ticket.created", { ticketId: TK, subject: "Need help", body: "Please send my invoice and a refund" });
  const tags = await withTenant(T, async (c) => {
    const r = await c.query("SELECT tags FROM tickets WHERE id = $1", [TK]);
    return (r.rows[0]?.tags as string[]) ?? [];
  });
  check("end-to-end: billing tag applied from body", tags.includes("billing"));
  check("end-to-end: refund tag applied from body", tags.includes("refund"));
  check("end-to-end: non-matching rule (shipping) did NOT tag", !tags.includes("shipping"));
  check("end-to-end: keyword-less rule (empty) did NOT tag everything", !tags.includes("empty"));

  // ---- graduate (fork-to-customize) the single Auto-tagging flow ----
  const sourceId = await withTenant(T, async (c) => {
    const r = await c.query("SELECT id FROM automations WHERE managed_by = 'autotag' LIMIT 1");
    return r.rows[0].id as string;
  });
  const fork = await graduateAutomation(T, sourceId);
  check("graduate: returns a new draft", !!fork && fork.id !== sourceId);
  check("graduate: fork is unmanaged", fork?.managedBy === null);
  check("graduate: fork is disabled (a draft to arm)", fork?.enabled === false);
  check("graduate: fork name marked custom", fork?.name === "Auto-tagging (custom)");
  check("graduate: fork deep-copied the tagging actions", (fork?.actions ?? []).some((a) => a.type === "apply_tag_rules"));
  const src = await getAutomation(T, sourceId);
  check("graduate: managed source disabled (no double-fire)", src?.enabled === false);
  check("graduate: managed source still managed", src?.managedBy === "autotag");

  // graduate on a non-managed automation → null (route maps to 400).
  const hand = await createAutomation(T, { name: "Hand", trigger: "ticket.created", conditions: { match: "all", conditions: [] }, actions: [] });
  const noFork = await graduateAutomation(T, hand.id);
  check("graduate: non-managed automation cannot be forked", noFork === null);

  await clean();
  await superPool.end();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
