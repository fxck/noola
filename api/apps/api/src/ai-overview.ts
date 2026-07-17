import { withTenant } from "@repo/db";
import { getModelConfig } from "./modelconfig.js";
import { getPersona, DEFAULT_PERSONA } from "./persona.js";
import { getPolicy } from "./autoreply.js";
import { listSimulations } from "./simulate.js";

// The governable-AI overview (Wave 5 item 22) — ONE aggregate behind the settings hub
// that packages the story: which model answers (BYO), in whose voice (persona), under
// what guardrails (policy + kill switch + confidence routing), with what human oversight
// (approval queue), how it is evaluated (test bench), and where the audit trail lives
// (draft traces + agent runs). Everything here is already built; this endpoint makes it
// legible as one governed system instead of six scattered settings pages.

export interface AiOverview {
  model: { provider: string; model: string | null; hasKey: boolean };
  persona: { configured: boolean; tone: string };
  policy: {
    mode: string;
    killSwitch: boolean;
    minConfidence: number | null;
    channelOverrides: number;
    publicSourceKinds: string[];
  };
  queue: { pending: number };
  lastEval: { label: string; avgScore: number | null; autoSendRate: number; createdAt: string } | null;
  activity7d: {
    drafts: number;
    autoSent: number;
    held: number;
    agentRuns: number;
    deflected: number;
  };
}

export async function getAiOverview(tenantId: string): Promise<AiOverview> {
  const [model, persona, policy, sims, counts] = await Promise.all([
    getModelConfig(tenantId),
    getPersona(tenantId).catch(() => DEFAULT_PERSONA),
    getPolicy(tenantId),
    listSimulations(tenantId, 1).catch(() => []),
    withTenant(tenantId, async (c) => {
      const r = await c.query(
        `SELECT
           (SELECT count(*)::int FROM autoreply_queue WHERE status = 'pending') AS pending,
           (SELECT count(*)::int FROM draft_traces WHERE created_at > now() - interval '7 days') AS drafts,
           (SELECT count(*)::int FROM autoreply_decisions WHERE outcome = 'auto_sent' AND created_at > now() - interval '7 days') AS auto_sent,
           (SELECT count(*)::int FROM autoreply_decisions WHERE outcome <> 'auto_sent' AND created_at > now() - interval '7 days') AS held,
           (SELECT count(*)::int FROM agent_runs WHERE created_at > now() - interval '7 days') AS agent_runs,
           (SELECT count(*)::int FROM draft_traces WHERE source = 'live' AND ticket_id IS NULL AND created_at > now() - interval '7 days') AS deflected`,
      );
      return r.rows[0] as Record<string, number>;
    }),
  ]);

  const last = sims[0] ?? null;
  const publicScope = policy.source_scopes?.public;
  return {
    model: { provider: model.provider, model: model.model, hasKey: model.hasKey },
    persona: {
      configured:
        persona.tone !== DEFAULT_PERSONA.tone ||
        !!persona.instructions?.trim() || !!persona.signature?.trim() || !!persona.guardrails?.trim(),
      tone: persona.tone,
    },
    policy: {
      mode: policy.mode,
      killSwitch: policy.kill_switch,
      minConfidence: policy.min_confidence,
      channelOverrides: Object.keys(policy.channel_modes ?? {}).length,
      publicSourceKinds: Array.isArray(publicScope) && publicScope.length > 0 ? publicScope : ["kb"],
    },
    queue: { pending: Number(counts.pending) || 0 },
    lastEval: last
      ? { label: last.label, avgScore: last.avg_score, autoSendRate: last.auto_send_rate, createdAt: last.created_at }
      : null,
    activity7d: {
      drafts: Number(counts.drafts) || 0,
      autoSent: Number(counts.auto_sent) || 0,
      held: Number(counts.held) || 0,
      agentRuns: Number(counts.agent_runs) || 0,
      deflected: Number(counts.deflected) || 0,
    },
  };
}
