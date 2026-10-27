import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { encryptionAvailable, decryptSecret } from "../src/crypto.js";
import {
  createIntegration,
  listIntegrations,
  getIntegration,
  updateIntegration,
  deleteIntegration,
  channelsOverview,
  resolveIntegration,
  resolveCredential,
} from "../src/integrations.js";

// Unified integrations registry seam:
//   • CRUD is RLS-scoped via withTenant (app_user) — a row lands in its tenant only;
//   • credentials are ENCRYPTED at rest (crypto.ts) and NEVER returned on reads (masked to
//     has_secret) — the improvement over the legacy plaintext connectors;
//   • an omitted secret on update is preserved, a new one replaces it;
//   • initial status reflects whether the connector is configured;
//   • channelsOverview reads the (empty, for a synthetic tenant) inbound-channel counts.
// Synthetic tenant UUID (never the seeded Acme/Globex data). Needs Postgres only.

const T = "dddddddd-0000-4000-8000-0000000000d1";
const B = "22222222-2222-2222-2222-222222222222"; // Globex (seeded) — cross-tenant guard

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query(`DELETE FROM integrations WHERE tenant_id IN ($1,$2)`, [T, B]);
    await superPool.query(`DELETE FROM tenants WHERE id = $1`, [T]);
  };
  await clean();
  await superPool.query(`INSERT INTO tenants (id, name) VALUES ($1,'IntgTest') ON CONFLICT (id) DO NOTHING`, [T]);

  check("MODEL_KEY_SECRET is set (encryption available)", encryptionAvailable());

  // ---- create (http kind with a secret) ----
  const http = await createIntegration(T, {
    kind: "http",
    name: "Ops webhook",
    config: { url: "https://example.com/hook", method: "POST" },
    secret: "s3cr3t-signing-key",
  });
  check("createIntegration returns a row with an id", typeof http.id === "string" && http.id.length > 0);
  check("configured connector gets status 'ok'", http.status === "ok");
  check("hasSecret is true when a secret was supplied", http.hasSecret === true);
  check("the raw secret is never returned on the row",
    !("secret" in (http as Record<string, unknown>)) && !("secret_enc" in (http as Record<string, unknown>)));

  // ---- secret is encrypted at rest, and round-trips ----
  const atRest = await superPool.query("SELECT secret_enc FROM integrations WHERE tenant_id=$1 AND id=$2", [T, http.id]);
  const blob = atRest.rows[0]?.secret_enc as string;
  check("secret is stored as a v1 cipher blob (not plaintext)", typeof blob === "string" && blob.startsWith("v1:") && !blob.includes("s3cr3t"));
  check("stored secret decrypts back to the original", decryptSecret(blob) === "s3cr3t-signing-key");

  // ---- list / get ----
  const list = await listIntegrations(T);
  check("listIntegrations returns the created row", list.some((r) => r.id === http.id));
  check("list rows never carry the secret blob", list.every((r) => !("secret" in (r as Record<string, unknown>))));
  const got = await getIntegration(T, http.id);
  check("getIntegration returns the row", got?.id === http.id && got?.name === "Ops webhook");

  // ---- update: rename, omit secret → secret preserved ----
  const renamed = await updateIntegration(T, http.id, { name: "Ops webhook v2" });
  check("update renames", renamed?.name === "Ops webhook v2");
  check("update without a secret keeps the stored one", renamed?.hasSecret === true);
  const stillEnc = await superPool.query("SELECT secret_enc FROM integrations WHERE tenant_id=$1 AND id=$2", [T, http.id]);
  check("the stored secret blob is unchanged when omitted", (stillEnc.rows[0]?.secret_enc as string) === blob);

  // ---- update: disable ----
  const disabled = await updateIntegration(T, http.id, { enabled: false });
  check("update can disable a connector", disabled?.enabled === false);

  // ---- status reflects configuration ----
  const slackUnset = await createIntegration(T, { kind: "slack", name: "Slack (no url yet)", config: {} });
  check("a connector missing its credential is 'unconfigured'", slackUnset.status === "unconfigured" && slackUnset.hasSecret === false);
  const email = await createIntegration(T, { kind: "email", name: "Alert email", config: { to: "ops@acme.test" } });
  check("an email connector with a recipient is 'ok'", email.status === "ok");

  // ---- credential resolution seam: the reusable primitive any node/tool binds a connector through ----
  const disc = await createIntegration(T, {
    kind: "discord", name: "Ops Discord", config: {},
    secret: "https://discord.com/api/webhooks/1/abc",
  });
  const rc = await resolveIntegration(T, disc.id);
  check("resolveIntegration returns the DECRYPTED secret (internal handle)", rc?.secret === "https://discord.com/api/webhooks/1/abc");
  check("resolveIntegration carries kind + name unmasked", rc?.kind === "discord" && rc?.name === "Ops Discord");
  const cred = await resolveCredential(T, { integrationId: disc.id }, { expectKind: ["discord"], requireSecret: true });
  check("resolveCredential resolves a valid, enabled, right-kind ref", cred.id === disc.id && cred.secret != null);
  const code = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); return "no-throw"; } catch (e) { return (e as { code?: string }).code ?? "err"; }
  };
  check("resolveCredential rejects a wrong-kind binding",
    (await code(() => resolveCredential(T, { integrationId: disc.id }, { expectKind: ["slack"] }))) === "wrong_kind");
  check("resolveCredential rejects an unknown integration",
    (await code(() => resolveCredential(T, { integrationId: "00000000-0000-4000-8000-000000000000" }))) === "not_found");
  check("resolveCredential enforces requireSecret",
    (await code(() => resolveCredential(T, { integrationId: email.id }, { requireSecret: true }))) === "missing_secret");
  await updateIntegration(T, disc.id, { enabled: false });
  check("resolveCredential rejects a disabled connector",
    (await code(() => resolveCredential(T, { integrationId: disc.id }))) === "disabled");
  check("resolveIntegration is tenant-scoped (B cannot resolve T's credential)",
    (await resolveIntegration(B, disc.id)) === null);

  // ---- RLS isolation: T's rows are invisible to another tenant ----
  const bList = await listIntegrations(B);
  check("integrations do not leak across tenants", !bList.some((r) => r.id === http.id));

  // ---- delete ----
  check("deleteIntegration removes the row", (await deleteIntegration(T, http.id)) === true);
  check("getIntegration is null after delete", (await getIntegration(T, http.id)) === null);
  check("deleteIntegration on a missing id returns false", (await deleteIntegration(T, http.id)) === false);

  // ---- channels overview (synthetic tenant → all zero, correct shape) ----
  const ov = await channelsOverview(T);
  check("channelsOverview returns the 5-channel shape, all zero for a fresh tenant",
    ov.slack === 0 && ov.discord === 0 && ov.email === 0 && ov.widget === 0 && ov.webhooks === 0);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nINTEGRATIONS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nINTEGRATIONS: all checks green");
}

main().catch((e) => { console.error("integrations seam ERROR", e); process.exit(1); });
