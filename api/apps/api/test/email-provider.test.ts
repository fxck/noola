import assert from "node:assert";
import pg from "pg";

// crypto.ts reads MODEL_KEY_SECRET at call time — ensure encryption is available before we touch the
// provider store (any value works; this is the at-rest key for the encrypted columns).
process.env.MODEL_KEY_SECRET = process.env.MODEL_KEY_SECRET || "test-model-key-secret-🔑";

const {
  saveTenantEmailProvider, getTenantEmailProvider, deleteTenantEmailProvider,
  tenantEmailProviderCreds, resolveTenantByInboundHandle, rotateInboundHandle,
} = await import("../src/email-provider.js");

// BYO Resend provider store: encrypted round-trip, write-only masking, partial update, and the
// pre-tenant inbound-handle resolution the per-tenant webhook route relies on.
const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const KEY = "re_test_byo_key_ABC123";
const WHSEC = "whsec_test_byo_signing_secret";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER,
    password: process.env.DB_SUPER_PASSWORD,
    max: 1,
  });
  const clean = async () => { await superPool.query("DELETE FROM email_provider_settings WHERE tenant_id = $1", [A]); };
  await clean();

  try {
    // Save both credentials → status masks the secrets, mints an inbound handle.
    const saved = await saveTenantEmailProvider(A, { apiKey: KEY, webhookSecret: WHSEC });
    check("save reports hasApiKey", saved.hasApiKey === true);
    check("save reports hasWebhookSecret", saved.hasWebhookSecret === true);
    check("save mints an inbound handle", typeof saved.inboundHandle === "string" && saved.inboundHandle.length > 20);

    // Reads never expose plaintext — only the boolean flags.
    const got = await getTenantEmailProvider(A);
    check("get masks the secrets (no plaintext fields)", !!got && !("apiKey" in got) && !("webhookSecret" in got));

    // The key round-trips through decryption for the send path; default provider is resend.
    const creds = await tenantEmailProviderCreds(A);
    check("tenantEmailProviderCreds decrypts the stored key", creds?.apiKey === KEY);
    check("default provider is resend", creds?.provider === "resend");

    // Pre-tenant handle resolution decrypts both secrets + names the tenant + provider (the inbound path).
    const byHandle = await resolveTenantByInboundHandle(saved.inboundHandle);
    check("handle resolves to the tenant", byHandle?.tenantId === A);
    check("handle resolution carries the provider", byHandle?.provider === "resend");
    check("handle resolution decrypts the api key", byHandle?.apiKey === KEY);
    check("handle resolution decrypts the webhook secret", byHandle?.webhookSecret === WHSEC);
    check("unknown handle resolves to null", (await resolveTenantByInboundHandle("nope-not-a-handle")) === null);

    // Switching provider to SendGrid updates it (and keeps the key); inbound URL path follows provider.
    await saveTenantEmailProvider(A, { provider: "sendgrid" });
    check("provider switches to sendgrid", (await getTenantEmailProvider(A))?.provider === "sendgrid");
    check("sendgrid creds keep the key", (await tenantEmailProviderCreds(A))?.provider === "sendgrid");
    check("handle now resolves as sendgrid", (await resolveTenantByInboundHandle(saved.inboundHandle))?.provider === "sendgrid");
    await saveTenantEmailProvider(A, { provider: "resend" });

    // Partial update: setting only the webhook secret leaves the api key intact.
    const NEW_WHSEC = "whsec_rotated";
    const patched = await saveTenantEmailProvider(A, { webhookSecret: NEW_WHSEC });
    check("partial update keeps the api key", (await tenantEmailProviderCreds(A))?.apiKey === KEY);
    check("partial update replaces the webhook secret", (await resolveTenantByInboundHandle(patched.inboundHandle))?.webhookSecret === NEW_WHSEC);

    // Rotating the handle invalidates the old URL.
    const oldHandle = patched.inboundHandle;
    const rotated = await rotateInboundHandle(A);
    check("rotate mints a fresh handle", typeof rotated === "string" && rotated !== oldHandle);
    check("old handle no longer resolves", (await resolveTenantByInboundHandle(oldHandle)) === null);

    // Clearing the api key with an empty string drops it but keeps the row.
    await saveTenantEmailProvider(A, { apiKey: "" });
    check("empty string clears the api key", (await tenantEmailProviderCreds(A)) === null);
    check("clearing the key keeps the row", (await getTenantEmailProvider(A))?.hasApiKey === false);

    // Delete removes the row entirely (revert to shared env).
    check("delete removes the row", (await deleteTenantEmailProvider(A)) === true);
    check("provider gone after delete", (await getTenantEmailProvider(A)) === null);
  } finally {
    await clean();
    await superPool.end();
  }

  if (failures) { console.error(`\nEMAIL-PROVIDER: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nEMAIL-PROVIDER: all checks green");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
