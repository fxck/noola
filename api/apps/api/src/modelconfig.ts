import { withTenant } from "@repo/db";
import {
  modelDriver,
  HttpChatModelDriver,
  clip,
  type ModelServingDriver,
  type ChatProvider,
} from "./model.js";
import { encryptSecret, decryptSecret, encryptionAvailable } from "./crypto.js";

// BYO per-tenant model config. One row per tenant selects the provider behind the
// AI drafts; the API key is encrypted at rest (crypto.ts) and never leaves the
// server. resolveModelDriver() turns a tenant's config into a live driver at
// request time — the process-global `modelDriver` (rule baseline) is the fallback
// whenever a tenant is on "managed", has no usable key, or encryption is off. This
// keeps the ModelServingDriver seam intact: call sites don't know which model ran.

export type ModelProvider = "managed" | ChatProvider;

/** The client-safe view — the key itself is never included, only whether one is set. */
export interface ModelConfigView {
  provider: ModelProvider;
  endpoint: string | null;
  model: string | null;
  hasKey: boolean;
}

export interface ModelConfigInput {
  provider: ModelProvider;
  endpoint?: string | null;
  model?: string | null;
  apiKey?: string;
}

interface Row {
  provider: ModelProvider;
  endpoint: string | null;
  model: string | null;
  key_cipher: string | null;
}

const DEFAULT_VIEW: ModelConfigView = { provider: "managed", endpoint: null, model: null, hasKey: false };

async function readRow(tenantId: string): Promise<Row | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT provider, endpoint, model, key_cipher FROM model_config WHERE tenant_id = current_tenant()",
    );
    return r.rowCount ? (r.rows[0] as Row) : null;
  });
}

function toView(row: Row | null): ModelConfigView {
  if (!row) return DEFAULT_VIEW;
  return { provider: row.provider, endpoint: row.endpoint, model: row.model, hasKey: !!row.key_cipher };
}

export async function getModelConfig(tenantId: string): Promise<ModelConfigView> {
  return toView(await readRow(tenantId));
}

/**
 * Upsert the tenant's config. provider "managed" clears everything (drops back to
 * the baseline). A non-empty apiKey replaces the stored key; an omitted/empty one
 * keeps the existing key (COALESCE). Returns the client-safe view.
 */
export async function putModelConfig(tenantId: string, input: ModelConfigInput): Promise<ModelConfigView> {
  if (input.provider === "managed") {
    await withTenant(tenantId, async (c) => {
      await c.query("DELETE FROM model_config WHERE tenant_id = current_tenant()");
    });
    return DEFAULT_VIEW;
  }

  if (!input.model || !input.model.trim()) {
    throw Object.assign(new Error("model is required for a hosted provider"), { statusCode: 400 });
  }
  if (input.provider === "custom" && !(input.endpoint && input.endpoint.trim())) {
    throw Object.assign(new Error("endpoint is required for a custom (OpenAI-compatible) provider"), {
      statusCode: 400,
    });
  }

  const newKey = input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : null;
  if (newKey && !encryptionAvailable()) {
    throw Object.assign(new Error("key storage unavailable (MODEL_KEY_SECRET not set)"), { statusCode: 503 });
  }
  const cipher = newKey ? encryptSecret(newKey) : null;
  // Capture the narrowed values before the closure — TS widens property narrowing
  // back across a function boundary (input is mutable), so bind them to consts.
  const provider = input.provider;
  const endpoint = input.endpoint ?? null;
  const model = input.model.trim();

  await withTenant(tenantId, async (c) => {
    // COALESCE keeps the existing key_cipher when no new key is supplied this call.
    await c.query(
      `INSERT INTO model_config (tenant_id, provider, endpoint, model, key_cipher, updated_at)
         VALUES (current_tenant(), $1, $2, $3, $4, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET provider   = EXCLUDED.provider,
             endpoint   = EXCLUDED.endpoint,
             model      = EXCLUDED.model,
             key_cipher = COALESCE(EXCLUDED.key_cipher, model_config.key_cipher),
             updated_at = now()`,
      [provider, endpoint, model, cipher],
    );
  });
  return toView(await readRow(tenantId));
}

/**
 * Resolve a tenant's config into a live model driver. Falls back to the rule
 * baseline (the process-global) whenever there's no usable hosted config — no key,
 * no model, "managed", or a key that won't decrypt. Cheap: one indexed row read.
 */
export async function resolveModelDriver(
  tenantId: string,
  override?: { model?: string },
): Promise<ModelServingDriver> {
  // Deterministic escape hatch for tests / CI / eval: force the rule baseline so runs
  // are reproducible and never spend a tenant's real key. Off in normal operation.
  if (process.env.FORCE_RULE_MODEL === "1") return modelDriver;
  const row = await readRow(tenantId).catch(() => null);
  if (!row || row.provider === "managed" || !row.key_cipher || !row.model) return modelDriver;
  const apiKey = decryptSecret(row.key_cipher);
  if (!apiKey) return modelDriver;
  // Per-node/per-run model selection (dogfood L0-F2): swap the model NAME within the tenant's
  // hosted provider + key. Endpoint/provider/credential stay the tenant's; a managed baseline
  // never reaches here, so the override simply has no effect there (honest degrade).
  return new HttpChatModelDriver({
    provider: row.provider as ChatProvider,
    endpoint: row.endpoint,
    model: (override?.model && override.model.trim()) || row.model,
    apiKey,
  });
}

/** Live reachability probe against the tenant's SAVED config. Baseline → always ok;
 *  a hosted config runs a tiny draft and reports success or the failure reason. */
export async function testModelConfig(tenantId: string): Promise<{ ok: boolean; error?: string }> {
  const driver = await resolveModelDriver(tenantId);
  if (driver === modelDriver) return { ok: true }; // the extractive baseline is always available
  try {
    const out = await driver.draftReply({
      customerMessage: "This is a connection test. Reply with a short greeting.",
      sources: [{ title: "Connection test", text: "Confirm the model responds." }],
    });
    return out.text.trim() ? { ok: true } : { ok: false, error: "empty response from model" };
  } catch (e) {
    return { ok: false, error: clip((e as Error).message, 200) };
  }
}
