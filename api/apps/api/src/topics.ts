import { withTenant } from "@repo/db";
import { resolveModelDriver } from "./modelconfig.js";
import { getTopicRules, DEFAULT_TOPIC_RULES } from "./classification.js";

// Topics explorer — assign every ticket ONE primary topic (distinct from the multi-label `tags`),
// then roll topics up into volume + trend so a team can see what customers actually contact them
// about and whether a topic is rising. Classification mirrors autotag's discipline: a hosted model
// picks from a fixed vocabulary, the deterministic keyword classifier is the always-on floor, and
// the whole thing is best-effort off the ingest path — a miss just leaves the ticket on 'general'.

// The primary-topic vocabulary. Kept aligned with autotag's tag vocabulary, plus 'general' as the
// catch-all so a topic is never null after classification.
export const TOPIC_VOCAB = [
  "billing", "bug", "how-to", "feature-request", "account", "refund", "cancellation",
  "security", "complaint", "integration", "outage", "shipping", "sales", "general",
] as const;

/**
 * Deterministic single-topic classifier — the floor under the hosted-model topic pick. First ENABLED
 * rule with a matching keyword (substring, case-insensitive, subject+body) wins → its topic; 'general'
 * when nothing matches. The keyword→topic rules are now the tenant's `topic_rules` config (0087);
 * `rules` defaults to the built-in seed so callers without a tenant (tests) still classify.
 */
export function ruleTopic(
  subject: string,
  body: string,
  rules: Array<{ topic: string; keywords: string[] }> = DEFAULT_TOPIC_RULES,
): string {
  const text = `${subject ?? ""} ${body ?? ""}`.toLowerCase();
  for (const r of rules) {
    if (r.keywords.some((k) => k && text.includes(k.toLowerCase()))) return r.topic;
  }
  return "general";
}

const SYSTEM_PROMPT =
  "You categorize an incoming customer-support ticket into exactly ONE topic. Respond with ONLY the " +
  "single topic word, no punctuation or prose. Choose from: " +
  TOPIC_VOCAB.join(", ") +
  ". If none fit, answer 'general'.";

function parseTopic(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/[^a-z-]+/g, "");
  return (TOPIC_VOCAB as readonly string[]).includes(t) ? t : null;
}

/** Classify via the tenant driver, falling back to the deterministic rule topic on any failure or
 *  when the driver has no generative `complete`. */
export async function classifyTopic(tenantId: string, subject: string, body: string): Promise<string> {
  const driver = await resolveModelDriver(tenantId);
  if (driver.complete) {
    try {
      const raw = await driver.complete(
        SYSTEM_PROMPT,
        `Subject: ${subject || "(none)"}\n\nMessage:\n${(body ?? "").slice(0, 1500)}`,
      );
      const topic = parseTopic(raw);
      if (topic) return topic;
    } catch {
      /* fall through to the deterministic topic */
    }
  }
  return ruleTopic(subject, body, await getTopicRules(tenantId));
}

/** Classify a new ticket and stamp its primary topic (best-effort; never throws into ingest). */
export async function assignTicketTopic(
  tenantId: string,
  ticketId: string,
  subject: string,
  body: string,
): Promise<void> {
  try {
    const topic = await classifyTopic(tenantId, subject, body);
    await withTenant(tenantId, async (c) => {
      await c.query("UPDATE tickets SET topic = $1 WHERE id = $2", [topic, ticketId]);
    });
  } catch {
    /* topic assignment is advisory — a failure must never affect ingest */
  }
}

export interface TopicSummary {
  topic: string;
  total: number;
  open: number;
  negative: number; // open tickets on this topic carrying negative sentiment
  last14: number; // tickets opened in the last 14 days
  prev14: number; // the 14 days before that — the trend denominator
  trend: number; // percent change last14 vs prev14 (rounded); 0 when no prior volume
  spark: number[]; // 14 daily counts, oldest → newest
  surge: boolean; // recent volume spiked meaningfully vs baseline — worth an alert
  surgeRatio: number; // last14 / prev14 (0 when no prior volume)
}

// A topic surges when its recent volume is materially above its own baseline AND the absolute
// volume is non-trivial (so a jump from 1→2 on a rare topic doesn't cry wolf).
const SURGE_RATIO = 1.5;
const SURGE_MIN_VOLUME = 4;
function isSurge(last14: number, prev14: number): boolean {
  return prev14 >= 1 && last14 >= SURGE_MIN_VOLUME && last14 >= prev14 * SURGE_RATIO;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * The Topics explorer payload: one row per topic with volume, open/negative pressure, a 14-day
 * spark, and a last-14 vs prev-14 trend. One round-trip, RLS-scoped. Ordered by total volume.
 */
export async function listTopics(tenantId: string): Promise<TopicSummary[]> {
  return withTenant(tenantId, async (c) => {
    const rollup = await c.query(
      `SELECT COALESCE(topic, 'general') AS topic,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'open' AND sentiment = 'negative')::int AS negative,
              count(*) FILTER (WHERE created_at > now() - interval '14 days')::int AS last14,
              count(*) FILTER (WHERE created_at > now() - interval '28 days'
                                 AND created_at <= now() - interval '14 days')::int AS prev14
         FROM tickets
        GROUP BY COALESCE(topic, 'general')`,
    );
    // Per-topic 14-day daily spark, in one pass.
    const sparkR = await c.query(
      `SELECT COALESCE(topic, 'general') AS topic,
              (now()::date - date_trunc('day', created_at)::date) AS days_ago,
              count(*)::int AS count
         FROM tickets
        WHERE created_at > now() - interval '14 days'
        GROUP BY 1, 2`,
    );
    const sparks = new Map<string, number[]>();
    for (const row of sparkR.rows) {
      const topic = row.topic as string;
      const daysAgo = num(row.days_ago);
      if (daysAgo < 0 || daysAgo > 13) continue;
      const arr = sparks.get(topic) ?? new Array(14).fill(0);
      arr[13 - daysAgo] = num(row.count); // index 13 = today, index 0 = 13 days ago
      sparks.set(topic, arr);
    }

    return rollup.rows
      .map((r): TopicSummary => {
        const last14 = num(r.last14);
        const prev14 = num(r.prev14);
        const trend = prev14 > 0 ? Math.round(((last14 - prev14) / prev14) * 100) : 0;
        return {
          topic: r.topic as string,
          total: num(r.total),
          open: num(r.open),
          negative: num(r.negative),
          last14,
          prev14,
          trend,
          spark: sparks.get(r.topic as string) ?? new Array(14).fill(0),
          surge: isSurge(last14, prev14),
          surgeRatio: prev14 > 0 ? Math.round((last14 / prev14) * 10) / 10 : 0,
        };
      })
      .sort((a, b) => b.total - a.total);
  });
}

export interface TopicTicket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  sentiment: string | null;
  created_at: string;
}

/** Drill-down: the tickets on one topic, newest first. */
export async function ticketsForTopic(
  tenantId: string,
  topic: string,
  limit = 100,
): Promise<TopicTicket[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, subject, status, priority, sentiment, created_at
         FROM tickets
        WHERE COALESCE(topic, 'general') = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [topic, Math.min(Math.max(limit, 1), 200)],
    );
    return r.rows as TopicTicket[];
  });
}

// ── Reclassify sweep (Wave 5 item 21) ────────────────────────────────────────
// 'general' is where classification misses pool — early tickets pre-dating rule/vocab
// improvements, and model outages. The sweep re-runs classification over the general
// bucket (newest first, bounded) and moves what now classifies. Sequential on purpose:
// the hosted classifier is rate-limited; a bounded batch keeps the request snappy.

export interface ReclassifyResult {
  scanned: number;
  reclassified: number;
  byTopic: Record<string, number>;
}

export async function reclassifyGeneral(tenantId: string, limit = 200): Promise<ReclassifyResult> {
  const rows = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.id, t.subject, COALESCE(fm.body, '') AS body
         FROM tickets t
         LEFT JOIN LATERAL (
           SELECT m.body FROM messages m
            WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id AND m.author_type = 'customer'
            ORDER BY m.created_at ASC LIMIT 1
         ) fm ON true
        WHERE COALESCE(t.topic, 'general') = 'general'
        ORDER BY t.created_at DESC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return r.rows as Array<{ id: string; subject: string; body: string }>;
  });

  const byTopic: Record<string, number> = {};
  let reclassified = 0;
  for (const t of rows) {
    const topic = await classifyTopic(tenantId, t.subject ?? "", t.body ?? "").catch(() => "general");
    if (topic === "general") continue;
    await withTenant(tenantId, async (c) => {
      await c.query("UPDATE tickets SET topic = $1 WHERE id = $2", [topic, t.id]);
    });
    byTopic[topic] = (byTopic[topic] ?? 0) + 1;
    reclassified++;
  }
  return { scanned: rows.length, reclassified, byTopic };
}
