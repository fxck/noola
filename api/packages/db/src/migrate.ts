import pg from "pg";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Runs as the DB superuser: applies roles + FORCE-RLS schema, syncs the
// runtime-role passwords from env, and seeds two demo tenants. Idempotent.

const here = dirname(fileURLToPath(import.meta.url));
// Dev (tsx on source) resolves the SQL beside the package; the bundled prod
// migrator is relocated by the deploy prefix-strip, so it sets MIGRATIONS_DIR.
const migrationsDir = process.env.MIGRATIONS_DIR ?? join(here, "..", "migrations");

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`migrate: missing env ${k}`);
  return v;
}

// Password hash for the seeded demo agents — MUST match apps/api/src/auth.ts
// verify format ("scrypt$<saltHex>$<hashHex>").
function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
}

async function main() {
  const pool = new pg.Pool({
    host: requireEnv("DB_HOST"),
    port: Number(process.env.DB_PORT ?? 5432),
    database: requireEnv("DB_NAME"),
    user: requireEnv("DB_SUPER_USER"),
    password: requireEnv("DB_SUPER_PASSWORD"),
    max: 1,
  });

  const migrations = ["0000_init.sql", "0001_discord.sql", "0002_operating_layer.sql", "0003_auth.sql", "0004_email.sql", "0005_search_grants.sql", "0006_kb.sql", "0007_documents.sql", "0008_model_config.sql", "0009_autoreply.sql", "0010_draft_traces.sql", "0011_message_meta.sql", "0012_autoreply_queue.sql", "0013_autoreply_jobs.sql", "0014_sources.sql", "0015_contacts.sql", "0016_webhooks.sql", "0017_broadcasts.sql", "0018_slack.sql", "0019_users_email_unique.sql", "0020_widget_keys.sql", "0021_better_auth.sql", "0022_kb_collections.sql", "0023_segments.sql", "0024_automations.sql", "0025_runner_runs.sql", "0026_flow_graph.sql", "0027_flow_docs.sql", "0028_automation_m2.sql", "0029_ticket_priority_tags.sql", "0030_api_keys.sql", "0031_macros.sql", "0032_ticket_notes.sql", "0033_sla.sql", "0034_note_mentions.sql", "0035_csat.sql", "0036_custom_fields.sql", "0037_ticket_types.sql", "0038_nps.sql", "0039_routing_rules.sql", "0040_surveys.sql", "0041_sla_business_hours.sql", "0042_sso_connections.sql", "0043_dogfood_l1.sql", "0045_sso_provider.sql", "0046_knowledge_gaps.sql", "0047_source_refresh.sql", "0048_ticket_merge.sql", "0049_ticket_snooze.sql", "0050_ticket_sentiment.sql", "0051_ticket_links.sql", "0052_audit_log.sql", "0053_ticket_reads.sql", "0054_kb_publishing.sql", "0055_accounts.sql", "0056_insight.sql", "0057_simulations.sql", "0058_translation.sql", "0059_contact_events.sql", "0060_avatars.sql", "0061_attachments.sql", "0062_omnichannel.sql", "0063_message_author.sql", "0064_broadcast_channel.sql", "0065_unsubscribe.sql", "0066_email_templates.sql", "0067_broadcast_blocks.sql", "0068_broadcast_scheduling.sql", "0069_broadcast_tracking.sql", "0070_teams.sql", "0071_routing_v2.sql", "0072_sweep.sql", "0073_ai_wave5.sql", "0074_widget_config.sql", "0075_widget_assistant_mode.sql", "0076_discord_thread_identity.sql", "0077_discord_identity_classification.sql", "0078_broadcast_channel_post.sql", "0081_flow_item_plane.sql", "0082_flow_execution_guards.sql", "0079_discord_ondemand.sql", "0080_discord_gateway_manager.sql", "0083_slack_triage.sql", "0084_tag_rules.sql", "0085_source_incremental.sql", "0086_source_sync_token.sql", "0087_classification_config.sql", "0088_discord_mirror.sql", "0089_discord_vip_channels.sql", "0090_contact_presence_company_fields.sql", "0091_binding_autoreply_mode.sql", "0092_tails_hygiene.sql", "0093_source_crawl_log.sql", "0094_email_sending_domains.sql", "0095_widget_identity_secret.sql", "0096_ticket_realtime_outbox.sql"];
  const c = await pool.connect();
  try {
    for (const file of migrations) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      await c.query(sql);
      console.log(`migrate: applied ${file}`);
    }

    // Roles are created password-less in SQL; set/rotate passwords from env.
    const appPw = c.escapeLiteral(requireEnv("APP_DB_PASSWORD"));
    const relayPw = c.escapeLiteral(requireEnv("RELAY_DB_PASSWORD"));
    await c.query(`ALTER ROLE app_user LOGIN PASSWORD ${appPw}`);
    await c.query(`ALTER ROLE event_relay LOGIN PASSWORD ${relayPw}`);
    // auth_user (better-auth's least-privilege DB principal, migration 0021) — sync its
    // password from env when configured (dual-run onward). Skipped if unset so a setup
    // without better-auth still migrates cleanly.
    if (process.env.AUTH_DB_PASSWORD) {
      await c.query(`ALTER ROLE auth_user LOGIN PASSWORD ${c.escapeLiteral(process.env.AUTH_DB_PASSWORD)}`);
    }

    // Demo seed — SKIPPED when DISABLE_DEMO_SEED=1 (self-hosted pilot, P3): a fresh install
    // gets zero demo tenants/creds/routes; the BOOTSTRAP_ADMIN_* block below creates the one
    // real workspace instead. Existing rows are never deleted by the flag — it only stops seeding.
    const demoSeed = process.env.DISABLE_DEMO_SEED !== "1";
    if (demoSeed) {
    // Seed demo tenants (superuser bypasses RLS).
    await c.query(`
      INSERT INTO tenants (id, name) VALUES
        ('11111111-1111-1111-1111-111111111111', 'Acme'),
        ('22222222-2222-2222-2222-222222222222', 'Globex'),
        ('33333333-3333-3333-3333-333333333333', 'TestCo')
      ON CONFLICT (id) DO NOTHING
    `);
    // TestCo (0092 hygiene) is the DEDICATED TEST TENANT: every api suite writes here, never
    // into Acme (the live demo workspace) — a crashed test can no longer wipe live config.
    // Globex stays the cross-tenant isolation partner.

    // Rename → Noola: migrate any pre-rename seeded routes in place (idempotent no-op after).
    await c.query(`
      UPDATE email_routes SET address = replace(address, '.pylon.test', '.noola.test')
       WHERE address LIKE '%.pylon.test'
    `);
    // …and re-subject any pending outbox rows so the relay never retries a subject no stream
    // matches after the pylon.events.* → noola.events.* flip (idempotent no-op after).
    await c.query(`
      UPDATE outbox SET subject = replace(subject, 'pylon.events.', 'noola.events.')
       WHERE subject LIKE 'pylon.events.%'
    `);

    // Seed demo email routes (support address → tenant) — must follow the tenants
    // above: email_routes.tenant_id FKs to tenants (0004 only creates the table).
    await c.query(`
      INSERT INTO email_routes (address, tenant_id) VALUES
        ('support@acme.noola.test',   '11111111-1111-1111-1111-111111111111'),
        ('support@globex.noola.test', '22222222-2222-2222-2222-222222222222'),
        ('support@testco.noola.test', '33333333-3333-3333-3333-333333333333')
      ON CONFLICT (address) DO NOTHING
    `);

    // Seed a demo widget key (Ask-AI embeddable widget) for Acme so the public
    // widget harness works with no agent creds. Empty allowlist = any origin (demo).
    await c.query(`
      INSERT INTO widget_keys (public_key, tenant_id, label) VALUES
        ('wk_demo_acme', '11111111-1111-1111-1111-111111111111', 'Demo widget (Acme)'),
        ('wk_test_testco', '33333333-3333-3333-3333-333333333333', 'Test widget (TestCo)')
      ON CONFLICT (public_key) DO NOTHING
    `);

    // Seed demo agents so assignment has real targets (slice 03).
    await c.query(`
      INSERT INTO users (tenant_id, id, email, name, role) VALUES
        ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000001','ales@acme.test','Aleš','agent'),
        ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000002','sam@acme.test','Sam','agent'),
        ('22222222-2222-2222-2222-222222222222','b0000000-0000-0000-0000-000000000001','mia@globex.test','Mia','agent'),
        ('33333333-3333-3333-3333-333333333333','c0000000-0000-0000-0000-000000000001','tess@testco.test','Tess','agent'),
        ('33333333-3333-3333-3333-333333333333','c0000000-0000-0000-0000-000000000002','tom@testco.test','Tom','agent')
      ON CONFLICT (tenant_id, id) DO NOTHING
    `);

    // Seed demo passwords (slice 04) so the frontend can log in. Demo only.
    for (const email of ["ales@acme.test", "sam@acme.test", "mia@globex.test", "tess@testco.test", "tom@testco.test"]) {
      await c.query("UPDATE users SET password_hash = $1 WHERE email = $2 AND password_hash IS NULL", [
        hashPassword("demo1234"),
        email,
      ]);
    }

    // Seed two example automations for Acme (Agent Studio) so the builder isn't empty on
    // first view. Both DISABLED — visible as templates to clone, inert until enabled, so the
    // demo/eval flows are never surprised by an auto-mutation. Idempotent on a stable id.
    await c.query(`
      INSERT INTO automations (tenant_id, id, name, enabled, trigger_event, conditions, actions) VALUES
        ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001',
         'Auto-assign Discord tickets to Aleš', false, 'ticket.created',
         '{"match":"all","conditions":[{"field":"channelType","op":"equals","value":"discord"}]}'::jsonb,
         '[{"type":"assign","assigneeId":"a0000000-0000-0000-0000-000000000001"}]'::jsonb),
        ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000002',
         'Escalate refund requests to Sam', false, 'message.received',
         '{"match":"any","conditions":[{"field":"body","op":"contains","value":"refund"},{"field":"body","op":"contains","value":"chargeback"}]}'::jsonb,
         '[{"type":"assign","assigneeId":"a0000000-0000-0000-0000-000000000002"}]'::jsonb)
      ON CONFLICT (tenant_id, id) DO NOTHING
    `);
    } // end demoSeed

    // Track A #2 dual-run — project the legacy seeded tenants/users FORWARD into the
    // better-auth identity tables so the demo users can sign in through better-auth in
    // parallel with the legacy path. One-directional + idempotent; no triggers exist, so
    // this never writes back into the authoritative users/tenants. Only runs once the
    // better-auth schema (0021) is present.
    if (process.env.AUTH_DB_PASSWORD) {
      await c.query(`
        INSERT INTO "organization" (id, name, slug, "createdAt")
        SELECT id::text, name,
               lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id::text, now()
        FROM tenants
        ON CONFLICT DO NOTHING
      `);
      await c.query(`
        INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        SELECT id::text, name, email, true, now(), now()
        FROM users
        ON CONFLICT DO NOTHING
      `);
      await c.query(`
        INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, u.id::text, 'credential', u.id::text, u.password_hash, now(), now()
        FROM users u
        WHERE u.password_hash IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "account" a WHERE a."userId" = u.id::text AND a."providerId" = 'credential'
          )
      `);
      await c.query(`
        INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
        SELECT gen_random_uuid()::text, u.tenant_id::text, u.id::text,
               CASE WHEN u.role IN ('owner','admin','agent','viewer') THEN u.role ELSE 'agent' END,
               now()
        FROM users u
        ON CONFLICT ("organizationId", "userId") DO NOTHING
      `);
      // Exactly one owner per org (earliest member). No trigger fires → only member.role changes.
      await c.query(`
        UPDATE "member" SET role = 'owner'
        WHERE id IN (
          SELECT DISTINCT ON ("organizationId") id FROM "member"
          ORDER BY "organizationId", "createdAt", id
        ) AND role <> 'owner'
      `);

      // First-run bootstrap (self-hosted, P3): when BOOTSTRAP_ADMIN_EMAIL is set and NO
      // organization exists yet, mint exactly one workspace + its owner from env
      // (BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD / BOOTSTRAP_ORG_NAME). A no-op the
      // moment any org exists, so re-runs (and later joiners via invites) never re-fire it.
      // Written into the better-auth tables — the reverse backfill directly below mirrors it
      // into the app tenants/users.
      const bootEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
      if (bootEmail) {
        const anyOrg = await c.query(`SELECT 1 FROM "organization" LIMIT 1`);
        if (anyOrg.rowCount === 0) {
          const bootPw = process.env.BOOTSTRAP_ADMIN_PASSWORD;
          if (!bootPw) throw new Error("BOOTSTRAP_ADMIN_EMAIL is set but BOOTSTRAP_ADMIN_PASSWORD is missing");
          const orgName = process.env.BOOTSTRAP_ORG_NAME || "Workspace";
          const orgId = crypto.randomUUID();
          const userId = crypto.randomUUID();
          const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
          await c.query(
            `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
            [orgId, orgName, `${slug}-${orgId.slice(0, 8)}`],
          );
          await c.query(
            `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, true, now(), now())`,
            [userId, bootEmail.split("@")[0], bootEmail],
          );
          await c.query(
            `INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
             VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
            [crypto.randomUUID(), userId, hashPassword(bootPw)],
          );
          await c.query(
            `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
             VALUES ($1, $2, $3, 'owner', now())`,
            [crypto.randomUUID(), orgId, userId],
          );
          console.log(`migrate: bootstrapped first workspace '${orgName}' + owner ${bootEmail}`);
        }
      }

      // Reverse backfill (better-auth → app) — the self-healing net for the runtime projection
      // (apps/api/src/projection.ts). Any org/member that exists in better-auth but is missing
      // its app tenants/users mirror (e.g. a runtime hook that swallowed a transient error) is
      // reconciled here on the next deploy. Superuser (bypasses RLS) — the trusted deploy
      // context, NOT the request-path/auth_user principal §9.1 warns about. Idempotent. Also
      // SYNCS users.role to the (allowlist-mapped) member.role, so the seeded owners (Aleš,
      // Mia) — promoted to owner in `member` but still 'agent' in the app `users` seed — read
      // correctly on the app side. Single-org today, so the member→users upsert never collides
      // with the global users_email_key (§9.5a).
      await c.query(`
        INSERT INTO tenants (id, name)
        SELECT o.id::uuid, o.name FROM "organization" o
        ON CONFLICT (id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO users (tenant_id, id, email, name, role)
        SELECT m."organizationId"::uuid, m."userId"::uuid, u.email, u.name,
               CASE WHEN m.role IN ('owner','admin','agent','viewer') THEN m.role ELSE 'agent' END
        FROM "member" m JOIN "user" u ON u.id = m."userId"
        ON CONFLICT (tenant_id, id)
        DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role
      `);
      console.log("migrate: better-auth projection ok (forward seed + reverse backfill)");
    }

    console.log(demoSeed ? "migrate: ok (roles + FORCE-RLS schema + demo tenants + agents + demo creds)" : "migrate: ok (roles + FORCE-RLS schema — demo seed disabled)");
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("migrate: FAILED", e);
  process.exit(1);
});
