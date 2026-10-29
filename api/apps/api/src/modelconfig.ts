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

/** What the model is used for. Search covers the docs-search query and every translation, general covers the remaining AI features. */
export type ModelJob = "answers" | "search" | "general";

/**
 * Thinking levels each provider is offered. Higher levels outgrow the drafts' token and time limits, and a custom
 * OpenAI-compatible endpoint gets none, as its support is unknown.
 */
export const PROVIDER_EFFORTS: Record<ChatProvider, readonly string[]> = {
  anthropic: ["low", "medium", "high"],
  openai: ["low", "medium", "high"],
  custom: [],
};

/** The client-safe view — the key itself is never included, only whether one is set. */
export interface ModelConfigView {
  provider: ModelProvider;
  endpoint: string | null;
  model: string | null;
  hasKey: boolean;
  /** Null runs each model at its own default. A search or general job with no model and no effort uses the answers settings. */
  effort: string | null;
  searchModel: string | null;
  searchEffort: string | null;
  generalModel: string | null;
  generalEffort: string | null;
}

/** For the job settings, omitted keeps the saved value and null clears it. */
export interface ModelConfigInput {
  provider: ModelProvider;
  endpoint?: string | null;
  model?: string | null;
  apiKey?: string;
  effort?: string | null;
  searchModel?: string | null;
  searchEffort?: string | null;
  generalModel?: string | null;
  generalEffort?: string | null;
}

interface Row {
  provider: ModelProvider;
  endpoint: string | null;
  model: string | null;
  key_cipher: string | null;
  effort: string | null;
  search_model: string | null;
  search_effort: string | null;
  general_model: string | null;
  general_effort: string | null;
}

const DEFAULT_VIEW: ModelConfigView = {
  provider: "managed", endpoint: null, model: null, hasKey: false,
  effort: null, searchModel: null, searchEffort: null, generalModel: null, generalEffort: null,
};

async function readRow(tenantId: string): Promise<Row | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT provider, endpoint, model, key_cipher, effort, search_model, search_effort, general_model, general_effort
         FROM model_config WHERE tenant_id = current_tenant()`,
    );
    return r.rowCount ? (r.rows[0] as Row) : null;
  });
}

function toView(row: Row | null): ModelConfigView {
  if (!row) return DEFAULT_VIEW;
  return {
    provider: row.provider, endpoint: row.endpoint, model: row.model, hasKey: !!row.key_cipher,
    effort: row.effort, searchModel: row.search_model, searchEffort: row.search_effort,
    generalModel: row.general_model, generalEffort: row.general_effort,
  };
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
  const jobs = mergeJobSettings(provider, input, await readRow(tenantId));

  await withTenant(tenantId, async (c) => {
    // COALESCE keeps the existing key_cipher when no new key is supplied this call.
    await c.query(
      `INSERT INTO model_config (tenant_id, provider, endpoint, model, key_cipher, effort,
                                 search_model, search_effort, general_model, general_effort, updated_at)
         VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET provider       = EXCLUDED.provider,
             endpoint       = EXCLUDED.endpoint,
             model          = EXCLUDED.model,
             key_cipher     = COALESCE(EXCLUDED.key_cipher, model_config.key_cipher),
             effort         = EXCLUDED.effort,
             search_model   = EXCLUDED.search_model,
             search_effort  = EXCLUDED.search_effort,
             general_model  = EXCLUDED.general_model,
             general_effort = EXCLUDED.general_effort,
             updated_at     = now()`,
      [provider, endpoint, model, cipher, jobs.effort, jobs.search_model, jobs.search_effort, jobs.general_model, jobs.general_effort],
    );
  });
  return toView(await readRow(tenantId));
}

type JobColumns = Pick<Row, "effort" | "search_model" | "search_effort" | "general_model" | "general_effort">;

/**
 * The job settings to save: each given value, else the saved one.
 * A saved model from another provider and a saved level the provider doesn't accept are dropped, while a given bad level is a 400.
 */
function mergeJobSettings(provider: ChatProvider, input: ModelConfigInput, saved: Row | null): JobColumns {
  const allowed = PROVIDER_EFFORTS[provider];
  const sameProvider = saved?.provider === provider;
  const pick = (given: string | null | undefined, kept: string | null | undefined, isEffort: boolean): string | null => {
    if (given === undefined) {
      if (isEffort) return kept && allowed.includes(kept) ? kept : null;
      return sameProvider ? (kept ?? null) : null;
    }
    const value = given?.trim() || null;
    if (isEffort && value && !allowed.includes(value)) {
      throw Object.assign(new Error(`thinking level must be one of: ${allowed.join(", ") || "none for this provider"}`), { statusCode: 400 });
    }
    if (!isEffort && value && value.length > 200) throw Object.assign(new Error("model name is too long"), { statusCode: 400 });
    return value;
  };
  return {
    effort: pick(input.effort, saved?.effort, true),
    search_model: pick(input.searchModel, saved?.search_model, false),
    search_effort: pick(input.searchEffort, saved?.search_effort, true),
    general_model: pick(input.generalModel, saved?.general_model, false),
    general_effort: pick(input.generalEffort, saved?.general_effort, true),
  };
}

/** The model and thinking level a job runs at. A job with neither of its own uses the answers settings. */
function jobSettings(row: Row, job: ModelJob): { model: string; effort: string | null } {
  const model = job === "search" ? row.search_model : job === "general" ? row.general_model : null;
  const effort = job === "search" ? row.search_effort : job === "general" ? row.general_effort : null;
  if (job === "answers" || (!model && !effort)) return { model: row.model ?? "", effort: row.effort };
  return { model: model ?? row.model ?? "", effort };
}

/**
 * Resolve a tenant's config into a live model driver. Falls back to the rule
 * baseline (the process-global) whenever there's no usable hosted config — no key,
 * no model, "managed", or a key that won't decrypt. Cheap: one indexed row read.
 */
export async function resolveModelDriver(
  tenantId: string,
  override?: { model?: string; job?: ModelJob },
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
  const job = jobSettings(row, override?.job ?? "answers");
  return new HttpChatModelDriver({
    provider: row.provider as ChatProvider,
    endpoint: row.endpoint,
    model: (override?.model && override.model.trim()) || job.model,
    apiKey,
    effort: job.effort,
  });
}

/** The models the saved provider serves the saved key, for the model picker. Empty for the built-in model or without a key. */
export async function listAvailableModels(tenantId: string): Promise<string[]> {
  const driver = await resolveModelDriver(tenantId);
  return driver instanceof HttpChatModelDriver ? driver.listModels() : [];
}

export interface ModelJobTest {
  job: ModelJob;
  model: string;
  effort: string | null;
  ok: boolean;
  error?: string;
}

/** Live reachability probe against the tenant's SAVED config. Baseline → always ok;
 *  a hosted config runs a tiny draft and reports success or the failure reason. */
export async function testModelConfig(tenantId: string): Promise<{ ok: boolean; error?: string; jobs: ModelJobTest[] }> {
  const driver = await resolveModelDriver(tenantId);
  if (driver === modelDriver) return { ok: true, jobs: [] }; // the extractive baseline is always available
  let answers: { ok: boolean; error?: string };
  try {
    const out = await driver.draftReply({
      customerMessage: "This is a connection test. Reply with a short greeting.",
      sources: [{ title: "Connection test", text: "Confirm the model responds." }],
    });
    answers = out.text.trim() ? { ok: true } : { ok: false, error: "empty response from model" };
  } catch (e) {
    answers = { ok: false, error: clip((e as Error).message, 200) };
  }
  // A job with its own model or thinking level is tested too, since a model can reject a level it doesn't support.
  const jobs: ModelJobTest[] = [{ job: "answers", model: driver.name, effort: driver.effort ?? null, ...answers }];
  for (const job of ["search", "general"] as const) {
    const d = await resolveModelDriver(tenantId, { job });
    if (d.name === driver.name && (d.effort ?? null) === (driver.effort ?? null)) continue;
    try {
      const out = await d.complete!("You are a connection test.", "Reply with the single word OK.");
      jobs.push({ job, model: d.name, effort: d.effort ?? null, ...(out.trim() ? { ok: true } : { ok: false, error: "empty response from model" }) });
    } catch (e) {
      jobs.push({ job, model: d.name, effort: d.effort ?? null, ok: false, error: clip((e as Error).message, 200) });
    }
  }
  const failed = jobs.find((j) => !j.ok);
  return { ok: !failed, error: failed?.error, jobs };
}
