import { withTenant, relayPool } from "@repo/db";
import { EVENT_TYPES } from "@repo/contracts";
import { classifyRisk } from "./model.js";
import { getRiskKeywords } from "./classification.js";
import { suggestForQuery, type Suggestion } from "./copilot.js";
import { ingestInbound } from "./ingest.js";
import { updateTraceGate } from "./trace.js";
import { routeOutbound } from "./discord.js";
import { routeEmailOutbound } from "./email.js";
import { routeSlackOutbound } from "./slack.js";
import { getDiscordSender } from "./discord-gateway.js";
import { claimAnswer } from "./answer-claims.js";

// Autoreply: turns the assist-only copilot into an optional, per-tenant, guardrailed
// AUTO-SEND. Default is off. Auto-send fires ONLY when retrieval corroborates (≥ N
// distinct source kinds cited), no business guardrail trips, the channel is allowed,
// caps aren't hit, and the tenant set mode='auto'. Every evaluated inbound customer
// message writes exactly one autoreply_decisions row (the idempotency anchor), and
// the actual send reuses ingestInbound with a deterministic idempotencyKey — belt +
// braces so a redelivery can never double-send.

export type AutoreplyMode = "off" | "suggest_only" | "auto";
export type ChannelMode = "auto" | "suggest_only" | "skip";

export interface AutoreplyPolicy {
  mode: AutoreplyMode;
  min_agreement: number;
  min_top_score: number;
  /** Per-channel routing override; a channel absent here inherits (see effectiveChannelMode). */
  channel_modes: Record<string, ChannelMode>;
  /** Model-confidence floor for auto-send; null = gate off. */
  min_confidence: number | null;
  /** Per-audience retrieval scoping ({public, agent} → allowed source kinds). */
  source_scopes: Record<string, string[]>;
  max_auto_per_thread: number;
  max_auto_per_hour: number;
  kill_switch: boolean;
  /** On-demand /ask master switch (independent of `mode`; /ask bypasses the ambient mode). */
  ondemand_enabled: boolean;
  /** Hourly ceiling for on-demand answers, counted ONLY over source='on_demand' rows. */
  max_ondemand_per_hour: number;
}

export interface AutoreplyPolicyPatch {
  mode?: AutoreplyMode;
  min_agreement?: number;
  min_top_score?: number;
  channel_modes?: Record<string, ChannelMode>;
  min_confidence?: number | null;
  source_scopes?: Record<string, string[]>;
  max_auto_per_thread?: number;
  max_auto_per_hour?: number;
  kill_switch?: boolean;
  ondemand_enabled?: boolean;
  max_ondemand_per_hour?: number;
}

const DEFAULT_POLICY: AutoreplyPolicy = {
  mode: "off",
  min_agreement: 2,
  min_top_score: 0,
  channel_modes: { synthetic: "auto", discord: "auto" },
  min_confidence: null,
  source_scopes: {},
  max_auto_per_thread: 3,
  max_auto_per_hour: 30,
  kill_switch: false,
  ondemand_enabled: true,
  max_ondemand_per_hour: 120,
};

/**
 * Resolve what one channel does under the policy. The global mode is a CEILING — a
 * per-channel entry can only restrict, never escalate: under global 'suggest_only' a
 * channel is suggest_only (or skip), never auto; under global 'auto' the explicit entry
 * is honored and an UNLISTED channel degrades to suggest_only, so auto-SEND always takes
 * global auto AND an explicit per-channel opt-in.
 */
export function effectiveChannelMode(policy: AutoreplyPolicy, channel: string): ChannelMode {
  const explicit = policy.channel_modes?.[channel];
  if (policy.mode === "suggest_only") return explicit === "skip" ? "skip" : "suggest_only";
  // policy.mode === 'auto' ('off' never reaches here — the feature gate short-circuits).
  return explicit ?? "suggest_only";
}

const POLICY_COLS =
  "mode, min_agreement, min_top_score, channel_modes, min_confidence, source_scopes, max_auto_per_thread, max_auto_per_hour, kill_switch, ondemand_enabled, max_ondemand_per_hour";

export async function getPolicy(tenantId: string): Promise<AutoreplyPolicy> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${POLICY_COLS} FROM autoreply_policy WHERE tenant_id = current_tenant()`);
    return r.rowCount ? (r.rows[0] as AutoreplyPolicy) : DEFAULT_POLICY;
  });
}

/** Upsert the tenant's policy (partial patch; unset fields keep their current/default value).
 *  On a transition INTO a working mode this fire-and-forgets a backlog sweep — pass
 *  { sweep: false } to suppress it (tests that drive enqueueBacklog/drainJobs themselves). */
export async function putPolicy(
  tenantId: string,
  patch: AutoreplyPolicyPatch,
  opts?: { sweep?: boolean },
): Promise<AutoreplyPolicy> {
  const cur = await getPolicy(tenantId);
  const next: AutoreplyPolicy = {
    mode: patch.mode ?? cur.mode,
    min_agreement: patch.min_agreement ?? cur.min_agreement,
    min_top_score: patch.min_top_score ?? cur.min_top_score,
    channel_modes: patch.channel_modes ?? cur.channel_modes,
    // min_confidence is nullable — undefined keeps, explicit null clears the floor.
    min_confidence: patch.min_confidence === undefined ? cur.min_confidence : patch.min_confidence,
    source_scopes: patch.source_scopes ?? cur.source_scopes,
    max_auto_per_thread: patch.max_auto_per_thread ?? cur.max_auto_per_thread,
    max_auto_per_hour: patch.max_auto_per_hour ?? cur.max_auto_per_hour,
    kill_switch: patch.kill_switch ?? cur.kill_switch,
    ondemand_enabled: patch.ondemand_enabled ?? cur.ondemand_enabled,
    max_ondemand_per_hour: patch.max_ondemand_per_hour ?? cur.max_ondemand_per_hour,
  };
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO autoreply_policy
         (tenant_id, mode, min_agreement, min_top_score, channel_modes, min_confidence, source_scopes, max_auto_per_thread, max_auto_per_hour, kill_switch, ondemand_enabled, max_ondemand_per_hour, updated_at)
       VALUES (current_tenant(), $1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         mode = EXCLUDED.mode, min_agreement = EXCLUDED.min_agreement, min_top_score = EXCLUDED.min_top_score,
         channel_modes = EXCLUDED.channel_modes, min_confidence = EXCLUDED.min_confidence,
         source_scopes = EXCLUDED.source_scopes, max_auto_per_thread = EXCLUDED.max_auto_per_thread,
         max_auto_per_hour = EXCLUDED.max_auto_per_hour, kill_switch = EXCLUDED.kill_switch,
         ondemand_enabled = EXCLUDED.ondemand_enabled, max_ondemand_per_hour = EXCLUDED.max_ondemand_per_hour, updated_at = now()`,
      [next.mode, next.min_agreement, next.min_top_score, JSON.stringify(next.channel_modes),
       next.min_confidence, JSON.stringify(next.source_scopes),
       next.max_auto_per_thread, next.max_auto_per_hour, next.kill_switch,
       next.ondemand_enabled, next.max_ondemand_per_hour],
    );
  });
  // On transition INTO a working mode (auto or suggest_only), sweep the existing backlog
  // of tickets awaiting a reply into jobs and drain them live — fire-and-forget so the
  // policy PUT returns immediately. auto → auto-send; suggest_only → drafts land in the
  // approval queue. Off→off or same-mode PUTs (e.g. tuning a knob) don't re-sweep.
  const enteredWorking = (next.mode === "auto" || next.mode === "suggest_only") && next.mode !== cur.mode;
  if (enteredWorking && (opts?.sweep ?? true)) {
    void enqueueBacklog(tenantId).then(() => drainJobs(tenantId)).catch(() => {});
  }
  return next;
}

export interface DecisionRow {
  id: string;
  message_id: string;
  ticket_id: string;
  outcome: string;
  reason: string;
  agreement: number | null;
  top_score: number | null;
  confidence: number | null;
  risk_tags: string[];
  sent_message_id: string | null;
  trace_id: string | null;
  created_at: string;
}

export async function listDecisionsForTicket(tenantId: string, ticketId: string): Promise<DecisionRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, message_id, ticket_id, outcome, reason, agreement, top_score, confidence,
              risk_tags, sent_message_id, trace_id, created_at
         FROM autoreply_decisions WHERE ticket_id = $1 ORDER BY created_at DESC`,
      [ticketId],
    );
    return r.rows as DecisionRow[];
  });
}

interface DecisionInput {
  messageId: string;
  ticketId: string;
  outcome: "assist" | "auto_sent" | "suppressed";
  reason: string;
  agreement: number | null;
  topScore: number | null;
  confidence: number | null;
  riskTags: string[];
  sentMessageId: string | null;
  traceId: string | null;
  /** 'ambient' = the auto-reply engine's own turn (default); 'on_demand' = an explicit /ask.
   *  Kept out of every rate cap the OTHER source counts, so /ask never tightens the ambient
   *  throttle and vice versa (§5.3). */
  source?: "ambient" | "on_demand";
  /** The external actor (Discord user id) who invoked an on-demand answer, for auditing. */
  invokedByExternalId?: string | null;
}

/** Insert the decision row, guarded by the UNIQUE(tenant_id, message_id) idempotency
 *  index. Returns the new id, or null if a decision for this message already exists
 *  (a replay/redelivery) — the caller treats null as "already handled". */
async function recordDecision(tenantId: string, d: DecisionInput): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO autoreply_decisions
         (tenant_id, message_id, ticket_id, outcome, reason, agreement, top_score, confidence, risk_tags, sent_message_id, trace_id, source, invoked_by_external_id)
       VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id, message_id) DO NOTHING
       RETURNING id`,
      [d.messageId, d.ticketId, d.outcome, d.reason, d.agreement, d.topScore, d.confidence, d.riskTags, d.sentMessageId, d.traceId, d.source ?? "ambient", d.invokedByExternalId ?? null],
    );
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
}

export interface EvaluateResult {
  outcome: "assist" | "auto_sent" | "suppressed";
  reason: string;
  decisionId: string;
  sentMessageId?: string;
  /** The approval-queue item id, when the draft was held for human review. */
  queueItemId?: string;
  /** Generation-stats receipt (same shape as messages.meta) for sent/held drafts. */
  meta?: Record<string, unknown>;
}

interface TriggerContext {
  body: string;
  authorType: string;
  whoseTurn: string;
  channelType: string;
  externalChannelId: string | null;
  subject: string;
  assistantEnabled: boolean;
  supportMode: string;
  /** Discord: the containing channel/forum (thread tickets) — binding-mode lookup key. */
  externalParentId: string | null;
  externalGuildId: string | null;
}

/** Per-binding AI-mode override (discord): the ticket's channel binding may pin this conversation
 *  surface to off/suggest/auto regardless of the channel-type mode — "auto-answer ONLY in the
 *  #help forum" without flipping all of discord. Most-specific-wins: binding > channel_modes >
 *  global. NULL/absent binding → inherit. Relay-scoped read (bindings are a pre-tenant table). */
async function discordBindingMode(ctx: TriggerContext): Promise<ChannelMode | null> {
  if (ctx.channelType !== "discord" || !ctx.externalGuildId) return null;
  const keys = [ctx.externalParentId, ctx.externalChannelId].filter(Boolean) as string[];
  if (!keys.length) return null;
  const r = await relayPool.query(
    `SELECT autoreply_mode FROM discord_channel_bindings
      WHERE guild_id = $1 AND channel_id = ANY($2::text[]) AND autoreply_mode IS NOT NULL LIMIT 1`,
    [ctx.externalGuildId, keys],
  );
  const m = r.rowCount ? (r.rows[0].autoreply_mode as string) : null;
  return m === "off" ? "skip" : m === "suggest" ? "suggest_only" : m === "auto" ? "auto" : null;
}

async function loadContext(tenantId: string, ticketId: string, messageId: string): Promise<TriggerContext | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT m.body, m.author_type, t.whose_turn, t.channel_type, t.external_channel_id, t.subject, t.assistant_enabled, t.support_mode,
              t.external_parent_id, t.external_guild_id
         FROM messages m JOIN tickets t ON t.id = m.ticket_id AND t.tenant_id = m.tenant_id
        WHERE m.id = $1 AND m.ticket_id = $2 LIMIT 1`,
      [messageId, ticketId],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return {
      body: row.body, authorType: row.author_type, whoseTurn: row.whose_turn,
      channelType: row.channel_type, externalChannelId: row.external_channel_id, subject: row.subject,
      assistantEnabled: row.assistant_enabled, supportMode: row.support_mode ?? "staffed",
      externalParentId: row.external_parent_id ?? null, externalGuildId: row.external_guild_id ?? null,
    };
  });
}

export interface HardGateResult {
  riskTags: string[];
  /** The kill switch tripped (global AUTOREPLY_KILL or the per-tenant kill_switch). */
  killed: boolean;
  /** A terminal SAFETY reason ('kill' or 'guardrail:...'), or null when it's safe to answer. */
  reason: string | null;
}

/**
 * The SAFETY gates both the ambient auto-reply engine and an explicit on-demand /ask must honor:
 * the global kill switch, the per-tenant kill_switch, and the classifyRisk guardrails. Distinct
 * from policy.mode / assistant_enabled / channel 'skip', which are ambient routing decisions an
 * explicit human request (/ask) is allowed to bypass. Pure (no I/O) so both call sites share it.
 */
export function checkHardGates(
  policy: AutoreplyPolicy,
  body: string,
  extraRisk?: Array<{ riskTag: string; keywords: string[] }>,
): HardGateResult {
  const killed = process.env.AUTOREPLY_KILL === "1" || policy.kill_switch;
  const riskTags = classifyRisk(body, extraRisk);
  const reason = killed ? "kill" : riskTags.length ? `guardrail:${riskTags.join(",")}` : null;
  return { riskTags, killed, reason };
}

export interface OnDemandResult {
  outcome: "answered" | "suppressed";
  reason: string;
  /** The answer to post publicly, or null when suppressed (held/capped/claimed). */
  text: string | null;
  decisionId: string | null;
}

/**
 * On-demand answer for an explicit /ask (Discord Phase 5). Unlike ambient autoreply this BYPASSES
 * policy.mode + assistant_enabled + per-channel routing (an explicit human request is not ambient),
 * but STILL honors the safety gates (checkHardGates — kill switch + classifyRisk; a risky /ask is
 * held, never answered publicly) and its OWN hourly cap (max_ondemand_per_hour, counted only over
 * source='on_demand' so it never touches the ambient throttle). Retrieval is FORCED to KB-only
 * regardless of the tenant's public source_scopes (§5.3 #2 — re-assert at the command layer, don't
 * trust the tenant scope). Records exactly one source='on_demand' decision (idempotent on messageId),
 * and takes the 'on_demand' answer claim so ambient autoreply / automations don't also answer this
 * turn. The caller (the Discord command handler) posts `text` when outcome==='answered'.
 */
export async function answerOnDemand(args: {
  tenantId: string;
  ticketId: string;
  messageId: string;
  query: string;
  invokedByExternalId: string | null;
}): Promise<OnDemandResult> {
  const { tenantId, ticketId, messageId, query, invokedByExternalId } = args;
  const nulls = { agreement: null, topScore: null, confidence: null, sentMessageId: null, traceId: null };
  const policy = await getPolicy(tenantId);
  if (!policy.ondemand_enabled) {
    return { outcome: "suppressed", reason: "ondemand_disabled", text: null, decisionId: null };
  }

  // Safety gates — a risky /ask is held, not answered in public.
  const gate = checkHardGates(policy, query, await getRiskKeywords(tenantId));
  if (gate.reason) {
    const id = await recordDecision(tenantId, {
      messageId, ticketId, outcome: "suppressed", reason: gate.reason, ...nulls,
      riskTags: gate.riskTags, source: "on_demand", invokedByExternalId,
    });
    return { outcome: "suppressed", reason: gate.reason, text: null, decisionId: id };
  }

  // On-demand hourly cap — counts ONLY source='on_demand' auto-sends (never the ambient rows).
  const capped = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT count(*)::int AS n FROM autoreply_decisions WHERE source = 'on_demand' AND outcome = 'auto_sent' AND created_at > now() - interval '1 hour'",
    );
    return (r.rows[0].n as number) >= policy.max_ondemand_per_hour;
  });
  if (capped) {
    const id = await recordDecision(tenantId, {
      messageId, ticketId, outcome: "suppressed", reason: "ondemand_rate_limited", ...nulls,
      riskTags: gate.riskTags, source: "on_demand", invokedByExternalId,
    });
    return { outcome: "suppressed", reason: "ondemand_rate_limited", text: null, decisionId: id };
  }

  // Draft — public audience, but KB-only FORCED (do not trust the tenant's public source_scopes).
  const suggestion = await suggestForQuery(tenantId, query, {
    ticketId, messageId, source: "live", audience: "public", forceScope: ["kb"],
  });

  // Arbitration: take the turn's single claim as 'on_demand'. A lost claim ⇒ another answerer
  // (an automations `message.received` reply) already posted this turn ⇒ stand down.
  if (!(await claimAnswer(tenantId, messageId, "on_demand"))) {
    const id = await recordDecision(tenantId, {
      messageId, ticketId, outcome: "suppressed", reason: "claimed_elsewhere",
      agreement: suggestion.retrieval.agreement, topScore: suggestion.retrieval.topScore,
      confidence: suggestion.confidence, sentMessageId: null, traceId: suggestion.traceId,
      riskTags: gate.riskTags, source: "on_demand", invokedByExternalId,
    });
    return { outcome: "suppressed", reason: "claimed_elsewhere", text: null, decisionId: id };
  }

  const id = await recordDecision(tenantId, {
    messageId, ticketId, outcome: "auto_sent", reason: "ondemand_sent",
    agreement: suggestion.retrieval.agreement, topScore: suggestion.retrieval.topScore,
    confidence: suggestion.confidence, sentMessageId: null, traceId: suggestion.traceId,
    riskTags: gate.riskTags, source: "on_demand", invokedByExternalId,
  });
  if (suggestion.traceId) await updateTraceGate(tenantId, suggestion.traceId, { outcome: "auto_sent", reason: "ondemand_sent", riskTags: gate.riskTags });
  return { outcome: "answered", reason: "ondemand_sent", text: suggestion.draft, decisionId: id };
}

/**
 * Evaluate one inbound customer message for autoreply. Idempotent (guarded by the
 * decision unique index + the send idempotencyKey), post-commit (never in the ingest
 * txn). Returns the decision, or null when the feature is off / the message isn't a
 * candidate / it was already evaluated. Safe to call fire-and-forget.
 */
export async function evaluateAutoreply(
  tenantId: string,
  ticketId: string,
  messageId: string,
): Promise<EvaluateResult | null> {
  const policy = await getPolicy(tenantId);
  if (policy.mode === "off") return null; // feature disabled — no work, no audit noise
  return evaluateForMessage(tenantId, ticketId, messageId, policy);
}

/**
 * The reusable draft/decision core. Assumes policy.mode !== 'off' (the caller has
 * already gated on that). Invoked both from the inbound hook (with the fresh message
 * id) and from the backlog drainer (with a ticket's resolved latest customer message
 * id). Returns the decision, or null when the message isn't a candidate / was already
 * evaluated (idempotency replay).
 */
async function evaluateForMessage(
  tenantId: string,
  ticketId: string,
  messageId: string,
  policy: AutoreplyPolicy,
): Promise<EvaluateResult | null> {
  const ctx = await loadContext(tenantId, ticketId, messageId);
  if (!ctx) return null;
  // Only inbound customer messages where the ball is on us are candidates.
  if (ctx.authorType !== "customer" || ctx.whoseTurn !== "us") return null;
  // The AI is muted on this conversation (visitor asked for a human, or the assistant was
  // switched off). The bot must not answer past a handoff — the human owns it now.
  if (ctx.assistantEnabled === false) return null;

  const gate = checkHardGates(policy, ctx.body, await getRiskKeywords(tenantId));
  const riskTags = gate.riskTags;
  // Per-channel routing (item 18): what THIS channel does with the message. 'skip' is a
  // terminal suppression; 'suggest_only' and 'auto' pick the branch below. A per-binding
  // override (e.g. auto-answer ONLY the #help forum) beats the channel-type mode.
  const channelMode = (await discordBindingMode(ctx)) ?? effectiveChannelMode(policy, ctx.channelType);

  // Terminal suppressions decided WITHOUT drafting (cheap, no model I/O). Precedence preserved:
  // kill > channel_skipped > guardrail (kill and guardrail come from the shared safety gate;
  // channel_skipped is ambient-only routing an explicit /ask is allowed to bypass).
  const hardReason =
    gate.killed ? "kill"
    : channelMode === "skip" ? "channel_skipped"
    : gate.riskTags.length ? `guardrail:${gate.riskTags.join(",")}`
    : null;
  if (hardReason) {
    const id = await recordDecision(tenantId, {
      messageId, ticketId, outcome: "suppressed", reason: hardReason,
      agreement: null, topScore: null, confidence: null, riskTags, sentMessageId: null, traceId: null,
    });
    return id ? { outcome: "suppressed", reason: hardReason, decisionId: id } : null;
  }

  // Draft + retrieve (records a draft_trace). Needed for both suggest_only and auto.
  const suggestion = await suggestForQuery(tenantId, ctx.body, { ticketId, messageId, source: "live" });
  const agreement = suggestion.retrieval.agreement;
  const topScore = suggestion.retrieval.topScore;
  const confidence = suggestion.confidence;
  const cited = suggestion.citations.length;

  const stampGate = async (outcome: string, reason: string) => {
    if (suggestion.traceId) await updateTraceGate(tenantId, suggestion.traceId, { outcome, reason, riskTags });
  };

  const draftMeta = suggestionMeta(suggestion, "suggested");

  // suggest_only never sends — the draft is ready for a human. The CHANNEL mode decides
  // (an explicit per-channel 'auto' upgrades a suggest_only tenant default and vice versa).
  if (channelMode === "suggest_only") {
    await stampGate("assist", "suggest_only");
    const id = await recordDecision(tenantId, {
      messageId, ticketId, outcome: "assist", reason: "suggest_only",
      agreement, topScore, confidence, riskTags, sentMessageId: null, traceId: suggestion.traceId,
    });
    // Queue the draft for human review (idempotent on message_id).
    const queueItemId = await enqueueSuggestion(tenantId, {
      ticketId, messageId, draftBody: suggestion.draft,
      meta: draftMeta, reason: "suggest_only",
    });
    return id
      ? { outcome: "assist", reason: "suggest_only", decisionId: id, queueItemId: queueItemId ?? undefined, meta: draftMeta }
      : null;
  }

  // channelMode === 'auto' from here. Gate on corroboration first, then the optional
  // model-confidence floor (item 18) — either failure holds the draft for human review.
  const gatePass = agreement >= policy.min_agreement && cited >= 1 && topScore >= policy.min_top_score;
  // A set floor with a null confidence (uncalibrated driver) holds — conservative default.
  const confidencePass =
    policy.min_confidence == null || (confidence != null && confidence >= policy.min_confidence);
  if (!gatePass || !confidencePass) {
    const holdReason = !gatePass ? "weak_retrieval" : "low_confidence";
    await stampGate("suppressed", holdReason);
    const id = await recordDecision(tenantId, {
      messageId, ticketId, outcome: "suppressed", reason: holdReason,
      agreement, topScore, confidence, riskTags, sentMessageId: null, traceId: suggestion.traceId,
    });
    // The draft exists but was held by the gate — queue it for human review.
    const queueItemId = await enqueueSuggestion(tenantId, {
      ticketId, messageId, draftBody: suggestion.draft,
      meta: draftMeta, reason: holdReason,
    });
    return id
      ? { outcome: "suppressed", reason: holdReason, decisionId: id, queueItemId: queueItemId ?? undefined, meta: draftMeta }
      : null;
  }

  // Rate / thread caps — count prior auto-sends before committing this one. "Deflect once"
  // (§5.5): a community-mode thread gets AT MOST ONE ambient AI deflection, so its effective
  // per-thread cap is clamped to 1 regardless of the configured max_auto_per_thread. Staffed
  // threads keep the configured cap. No new column — a mode-conditional clamp here.
  const effectiveThreadCap = ctx.supportMode === "community" ? 1 : policy.max_auto_per_thread;
  // ⚠ Both caps count ONLY ambient auto-sends (source='ambient'). On-demand /ask answers may also
  // land as auto_sent rows, so without this filter every /ask would silently tighten the ambient
  // throttle (§5.3, the reciprocal half of the source split).
  const capReason = await withTenant(tenantId, async (c) => {
    const thread = await c.query(
      "SELECT count(*)::int AS n FROM autoreply_decisions WHERE ticket_id = $1 AND outcome = 'auto_sent' AND source = 'ambient'",
      [ticketId],
    );
    if ((thread.rows[0].n as number) >= effectiveThreadCap) return "thread_cap";
    const hour = await c.query(
      "SELECT count(*)::int AS n FROM autoreply_decisions WHERE outcome = 'auto_sent' AND source = 'ambient' AND created_at > now() - interval '1 hour'",
    );
    if ((hour.rows[0].n as number) >= policy.max_auto_per_hour) return "rate_limited";
    return null;
  });
  if (capReason) {
    await stampGate("suppressed", capReason);
    const id = await recordDecision(tenantId, {
      messageId, ticketId, outcome: "suppressed", reason: capReason,
      agreement, topScore, confidence, riskTags, sentMessageId: null, traceId: suggestion.traceId,
    });
    return id ? { outcome: "suppressed", reason: capReason, decisionId: id } : null;
  }

  // Arbitration (§5.2): claim the turn only now that every gate has passed. A lost claim ⇒ another
  // answerer (automations reply / on-demand) already posted this turn ⇒ stand down (do not re-check,
  // do not post). Taken at the LAST moment so a gate-bail never consumes the turn's single claim.
  if (!(await claimAnswer(tenantId, messageId, "autoreply"))) {
    const id = await recordDecision(tenantId, {
      messageId, ticketId, outcome: "suppressed", reason: "claimed_elsewhere",
      agreement, topScore, confidence, riskTags, sentMessageId: null, traceId: suggestion.traceId,
    });
    return id ? { outcome: "suppressed", reason: "claimed_elsewhere", decisionId: id } : null;
  }

  // Auto-send: reuse the agent-reply path. The deterministic idempotencyKey dedupes
  // the SEND even if this evaluation somehow runs twice (belt + braces with the
  // decision unique index). Auto-sent messages are author_type='agent', so they can
  // never trigger another autoreply.
  const sent = await ingestInbound({
    tenantId, body: suggestion.draft, authorType: "agent", ticketId,
    idempotencyKey: `autoreply:${messageId}`,
  });
  // Attach generation stats to the sent AI message so the UI can render them inline.
  // Real signals come straight from the Suggestion we already computed; under the rule
  // baseline model is "rule" and tokensIn/out are null (extractive, no LLM usage).
  const meta = suggestionMeta(suggestion, "autoreply");
  await withTenant(tenantId, async (c) => {
    await c.query("UPDATE messages SET auto = true, meta = $2::jsonb WHERE id = $1", [
      sent.messageId,
      JSON.stringify(meta),
    ]);
  });
  // Dispatch to the origin channel (same as /tickets/:id/reply). Synthetic has no
  // external endpoint — the outbox event still updates the live inbox.
  if (ctx.channelType === "email") {
    await routeEmailOutbound({ tenantId, externalChannelId: ctx.externalChannelId, ticketId }, ctx.subject, suggestion.draft).catch(() => {});
  } else if (ctx.channelType === "slack") {
    await routeSlackOutbound({ tenantId, channelType: ctx.channelType, externalChannelId: ctx.externalChannelId }, suggestion.draft).catch(() => {});
  } else if (ctx.channelType === "discord") {
    await routeOutbound({ channelType: ctx.channelType, externalChannelId: ctx.externalChannelId }, suggestion.draft, getDiscordSender()).catch(() => {});
  }

  await stampGate("auto_sent", "sent");
  const id = await recordDecision(tenantId, {
    messageId, ticketId, outcome: "auto_sent", reason: "sent",
    agreement, topScore, confidence, riskTags, sentMessageId: sent.messageId, traceId: suggestion.traceId,
  });
  // If the decision insert lost the idempotency race, another evaluation already
  // recorded + sent (dedup'd by idempotencyKey) — report that outcome without erroring.
  return id
    ? { outcome: "auto_sent", reason: "sent", decisionId: id, sentMessageId: sent.messageId, meta }
    : null;
}

// ---- Approval queue ------------------------------------------------------
// Drafts that were NOT auto-sent (suggest_only mode, or auto-mode drafts held by the
// weak-retrieval gate) land in autoreply_queue as reviewable items. A human can Send
// the draft as-is, Edit+Send an override, or Dismiss it. Sending reuses the same
// agent-reply path the auto-sender uses (ingestInbound + meta + channel dispatch).

/** The generation stats blob attached to a drafted reply (same shape as messages.meta).
 *  Under the rule baseline model is "rule" and tokensIn/out are null (extractive). */
function suggestionMeta(s: Suggestion, kind: string): Record<string, unknown> {
  return {
    kind,
    model: s.model,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    latencyMs: s.latencyMs,
    confidence: s.confidence,
    sources: s.retrieval.perCitation.length,
    citedKinds: s.retrieval.citedKinds,
    agreement: s.retrieval.agreement,
    traceId: s.traceId,
  };
}

interface EnqueueInput {
  ticketId: string;
  messageId: string;
  draftBody: string;
  meta: Record<string, unknown>;
  reason: "suggest_only" | "weak_retrieval" | "low_confidence";
}

/** Insert a reviewable draft. Idempotent on (tenant_id, message_id) — a re-ingest of
 *  the same customer message no-ops rather than queuing a duplicate. Returns the queue
 *  item id (the existing row's id on a conflict), so a backlog job can record it as its
 *  result_message_id. The DO UPDATE is a no-op write purely to force RETURNING on conflict. */
async function enqueueSuggestion(tenantId: string, input: EnqueueInput): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO autoreply_queue (tenant_id, ticket_id, message_id, draft_body, meta, reason)
       VALUES (current_tenant(), $1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (tenant_id, message_id) DO UPDATE SET reason = autoreply_queue.reason
       RETURNING id`,
      [input.ticketId, input.messageId, input.draftBody, JSON.stringify(input.meta), input.reason],
    );
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
}

export interface QueueItem {
  id: string;
  ticket_id: string;
  ticket_subject: string | null;
  message_id: string;
  draft_body: string;
  meta: Record<string, unknown> | null;
  reason: string;
  status: string;
  created_at: string;
}

/** Pending items, newest first, with the ticket subject joined in for display. */
export async function listQueue(tenantId: string): Promise<QueueItem[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT q.id, q.ticket_id, t.subject AS ticket_subject, q.message_id, q.draft_body,
              q.meta, q.reason, q.status, q.created_at
         FROM autoreply_queue q
         LEFT JOIN tickets t ON t.id = q.ticket_id AND t.tenant_id = q.tenant_id
        WHERE q.status = 'pending'
        ORDER BY q.created_at DESC`,
    );
    return r.rows as QueueItem[];
  });
}

export type QueueActionResult =
  | { ok: true; message: { ticketId: string; messageId: string; delivered: boolean } }
  | { ok: false; code: 404 | 409 };

/** Send a pending queue item as an agent reply through the SAME path the auto-sender
 *  uses. `body` overrides the stored draft (Edit+Send). Idempotent on the send via a
 *  deterministic idempotencyKey. Returns 404 if the item is gone, 409 if non-pending. */
export async function sendQueued(
  tenantId: string,
  id: string,
  body?: string,
): Promise<QueueActionResult> {
  const item = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT q.id, q.ticket_id, q.draft_body, q.meta, q.status,
              t.channel_type, t.external_channel_id, t.subject
         FROM autoreply_queue q
         JOIN tickets t ON t.id = q.ticket_id AND t.tenant_id = q.tenant_id
        WHERE q.id = $1 LIMIT 1`,
      [id],
    );
    return r.rowCount ? r.rows[0] : null;
  });
  if (!item) return { ok: false, code: 404 };
  if (item.status !== "pending") return { ok: false, code: 409 };

  const outBody = body ?? (item.draft_body as string);

  // Reuse the agent-reply core. The deterministic idempotencyKey dedupes the SEND even
  // if this runs twice; the status flip below is the queue-side guard.
  const sent = await ingestInbound({
    tenantId, body: outBody, authorType: "agent", ticketId: item.ticket_id,
    idempotencyKey: `queue:${id}`,
  });
  // Carry the draft's generation stats onto the sent message, relabelled queued_sent.
  const meta = { ...((item.meta as Record<string, unknown>) ?? {}), kind: "queued_sent" };
  await withTenant(tenantId, async (c) => {
    await c.query("UPDATE messages SET meta = $2::jsonb WHERE id = $1", [
      sent.messageId,
      JSON.stringify(meta),
    ]);
  });

  // Dispatch to the origin channel (same as the auto-sender / /tickets/:id/reply).
  let delivered = true;
  if (item.channel_type === "email") {
    const o = await routeEmailOutbound(
      { tenantId, externalChannelId: item.external_channel_id, ticketId: item.ticket_id }, item.subject, outBody,
    ).catch(() => ({ delivered: false as boolean }));
    delivered = o.delivered;
  } else if (item.channel_type === "slack") {
    const o = await routeSlackOutbound(
      { tenantId, channelType: item.channel_type, externalChannelId: item.external_channel_id }, outBody,
    ).catch(() => ({ delivered: false as boolean }));
    delivered = o.delivered;
  } else if (item.channel_type === "discord") {
    const o = await routeOutbound(
      { channelType: item.channel_type, externalChannelId: item.external_channel_id }, outBody, getDiscordSender(),
    ).catch(() => ({ delivered: false as boolean }));
    delivered = o.delivered;
  }

  await withTenant(tenantId, async (c) => {
    await c.query(
      "UPDATE autoreply_queue SET status = 'sent', decided_at = now() WHERE id = $1 AND status = 'pending'",
      [id],
    );
  });

  return { ok: true, message: { ticketId: sent.ticketId, messageId: sent.messageId, delivered } };
}

export type DismissResult = { ok: true } | { ok: false; code: 404 | 409 };

/** Dismiss a pending item (no send). 404 if gone, 409 if already non-pending. */
export async function dismissQueued(tenantId: string, id: string): Promise<DismissResult> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT status FROM autoreply_queue WHERE id = $1 LIMIT 1", [id]);
    if (!r.rowCount) return { ok: false, code: 404 };
    if (r.rows[0].status !== "pending") return { ok: false, code: 409 };
    await c.query(
      "UPDATE autoreply_queue SET status = 'dismissed', decided_at = now() WHERE id = $1",
      [id],
    );
    return { ok: true };
  });
}

// ---- Backlog jobs --------------------------------------------------------
// Turning on auto (or suggest_only) mode shouldn't only react to the NEXT inbound
// message — it should sweep the EXISTING backlog of tickets awaiting a reply into a
// visible JOB QUEUE and work through them live. enqueueBacklog snapshots the backlog
// into `queued` jobs (one per ticket, idempotent via the partial unique index);
// drainJobs claims them one at a time, runs the same draft/decision core, and drives
// each to a terminal status while emitting an outbox event per transition so the edge
// relays live UI updates.

/** How long a `processing` job may sit before a fresh drain reclaims it as stale. */
const STALE_PROCESSING = "5 minutes";

/**
 * The message a job should act on: the ticket's latest inbound CUSTOMER message, but
 * only while the ticket is still a candidate (open + the ball is on us). Returns null
 * when the ticket is closed, the turn has flipped, or there's no customer message —
 * the drainer maps that to a `skipped` job.
 */
async function latestCustomerMessage(tenantId: string, ticketId: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT m.id
         FROM messages m
         JOIN tickets t ON t.id = m.ticket_id AND t.tenant_id = m.tenant_id
        WHERE m.ticket_id = $1 AND m.author_type = 'customer'
          AND t.status = 'open' AND t.whose_turn = 'us' AND t.support_mode = 'staffed'
        ORDER BY m.created_at DESC
        LIMIT 1`,
      [ticketId],
    );
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
}

/**
 * Snapshot the backlog of tickets awaiting a reply (open + whose_turn='us' — the same
 * predicate as the inbox "Needs reply" view) into `queued` jobs, one per ticket. The
 * partial unique index (tenant_id, ticket_id WHERE status IN queued|processing) means a
 * ticket that already has an active job is skipped — so a second sweep while jobs are in
 * flight adds nothing. Returns the number of jobs newly enqueued.
 */
export async function enqueueBacklog(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO autoreply_jobs (tenant_id, ticket_id)
         SELECT current_tenant(), t.id
           FROM tickets t
          WHERE t.status = 'open' AND t.whose_turn = 'us' AND t.support_mode = 'staffed'
       ON CONFLICT (tenant_id, ticket_id) WHERE status IN ('queued','processing')
         DO NOTHING
       RETURNING id`,
    );
    return r.rowCount ?? 0;
  });
}

interface ClaimedJob {
  id: string;
  ticket_id: string;
}

/** Atomically claim the oldest queued job (FOR UPDATE SKIP LOCKED → safe under concurrent
 *  drains), flipping it to `processing`. Returns null when the queue is drained. */
async function claimNextJob(tenantId: string): Promise<ClaimedJob | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE autoreply_jobs SET status = 'processing', started_at = now()
         WHERE id = (
           SELECT id FROM autoreply_jobs
            WHERE tenant_id = current_tenant() AND status = 'queued'
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1)
       RETURNING id, ticket_id`,
    );
    return r.rowCount ? (r.rows[0] as ClaimedJob) : null;
  });
}

interface JobOutcome {
  status: "sent" | "held" | "skipped" | "error";
  reason: string;
  messageId: string | null;
  resultMessageId: string | null;
  meta: Record<string, unknown> | null;
}

/** Run the reusable core for one claimed job and map its result onto a terminal job
 *  status. `sent` = auto-sent; `held` = a draft parked in the approval queue (suggest_only
 *  / weak_retrieval) or otherwise suppressed (guardrail / cap / kill); `skipped` = the
 *  ticket is no longer a candidate or was already evaluated; `error` = a caught exception. */
async function runJob(tenantId: string, job: ClaimedJob, policy: AutoreplyPolicy): Promise<JobOutcome> {
  try {
    const messageId = await latestCustomerMessage(tenantId, job.ticket_id);
    if (!messageId) {
      return { status: "skipped", reason: "not_a_candidate", messageId: null, resultMessageId: null, meta: null };
    }
    const res = await evaluateForMessage(tenantId, job.ticket_id, messageId, policy);
    if (!res) {
      // core returned null → an idempotency replay (a decision already exists).
      return { status: "skipped", reason: "already_evaluated", messageId, resultMessageId: null, meta: null };
    }
    if (res.outcome === "auto_sent") {
      return { status: "sent", reason: res.reason, messageId, resultMessageId: res.sentMessageId ?? null, meta: res.meta ?? null };
    }
    // assist (suggest_only) or suppressed (weak_retrieval / guardrail / cap / kill) → held.
    return { status: "held", reason: res.reason, messageId, resultMessageId: res.queueItemId ?? null, meta: res.meta ?? null };
  } catch (e) {
    return { status: "error", reason: (e as Error).message.slice(0, 500), messageId: null, resultMessageId: null, meta: null };
  }
}

/** Write the terminal status + finished_at (and the resolved message id / receipt). */
async function finishJob(tenantId: string, jobId: string, o: JobOutcome): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE autoreply_jobs
          SET status = $2, reason = $3, message_id = COALESCE($4, message_id),
              result_message_id = $5, meta = $6::jsonb, finished_at = now()
        WHERE id = $1`,
      [jobId, o.status, o.reason, o.messageId, o.resultMessageId, o.meta ? JSON.stringify(o.meta) : null],
    );
  });
}

/** Emit an outbox row per job transition so the edge relays it and the UI updates live.
 *  Same transactional-outbox pattern as the ingest core, on the per-tenant subject. */
async function emitJobEvent(tenantId: string, jobId: string, ticketId: string, status: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const envelope = {
      id: jobId,
      type: EVENT_TYPES.autoreplyJob,
      tenantId,
      ticketId,
      occurredAt: new Date().toISOString(),
      data: { jobId, ticketId, status },
    };
    await c.query(
      "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), $1, 'noola.events.' || current_tenant(), $2::jsonb)",
      [EVENT_TYPES.autoreplyJob, JSON.stringify(envelope)],
    );
  });
}

/**
 * Background drainer — fire-and-forget; NEVER call this in the request path without
 * `void`. Reclaims any stale `processing` jobs (resumable after a crash/redeploy), then
 * claims + runs queued jobs one at a time (sequential, to stay under model rate limits).
 * The per-tenant rate cap (max_auto_per_hour) is enforced inside the core, so a job that
 * hits it lands as `held` with reason 'rate_limited'.
 */
export async function drainJobs(tenantId: string): Promise<void> {
  const policy = await getPolicy(tenantId);
  // Resumable: a fresh drain re-claims jobs a previous (crashed) drain left processing.
  await withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE autoreply_jobs SET status = 'queued', started_at = NULL
        WHERE status = 'processing' AND started_at < now() - interval '${STALE_PROCESSING}'`,
    );
  });
  for (;;) {
    const job = await claimNextJob(tenantId);
    if (!job) break;
    const outcome = await runJob(tenantId, job, policy);
    await finishJob(tenantId, job.id, outcome);
    await emitJobEvent(tenantId, job.id, job.ticket_id, outcome.status);
  }
}

export interface JobItem {
  id: string;
  ticket_id: string;
  ticket_subject: string | null;
  status: string;
  reason: string;
  result_message_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobCounts {
  queued: number;
  processing: number;
  sent: number;
  held: number;
  skipped: number;
  error: number;
}

/** The job list (active statuses first, then most-recent), plus per-status counts over
 *  ALL of the tenant's jobs (not just the returned page). LEFT JOIN tickets for subject. */
export async function listJobs(tenantId: string): Promise<{ jobs: JobItem[]; counts: JobCounts }> {
  return withTenant(tenantId, async (c) => {
    const jr = await c.query(
      `SELECT j.id, j.ticket_id, t.subject AS ticket_subject, j.status, j.reason,
              j.result_message_id, j.meta, j.created_at, j.started_at, j.finished_at
         FROM autoreply_jobs j
         LEFT JOIN tickets t ON t.id = j.ticket_id AND t.tenant_id = j.tenant_id
        ORDER BY (j.status IN ('queued','processing')) DESC, j.created_at DESC
        LIMIT 100`,
    );
    const cr = await c.query(
      "SELECT status, count(*)::int AS n FROM autoreply_jobs GROUP BY status",
    );
    const counts: JobCounts = { queued: 0, processing: 0, sent: 0, held: 0, skipped: 0, error: 0 };
    for (const row of cr.rows) {
      if (row.status in counts) counts[row.status as keyof JobCounts] = row.n as number;
    }
    return { jobs: jr.rows as JobItem[], counts };
  });
}
