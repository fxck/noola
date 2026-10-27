import { createHmac, timingSafeEqual } from "node:crypto";
import { relayPool, withTenant } from "@repo/db";
import { ingestInbound, type IngestResult } from "./ingest.js";
import { suggestForQuery } from "./copilot.js";
import { mdToSlack } from "./channels/format.js";

// The Slack channel — a lightweight peer to Discord and email, riding the same
// ingestInbound() spine. Inbound Slack Events API messages become tickets
// (channel_type 'slack'); agent replies + auto-sends post back via chat.postMessage.
//
// Tenant resolution keys on the Slack workspace (team_id) via slack_connections.
// UNLIKE discord_links / email_routes, slack_connections is tenant-scoped under
// FORCE-RLS (it holds a per-tenant bot_token secret) — but the inbound team_id→tenant
// lookup happens BEFORE any tenant context exists, so it runs on the event_relay
// (BYPASSRLS) role, the same system-read path discord.ts/email.ts use. The ticket is
// keyed by `${team_id}:${channel}` (one thread per Slack channel). Idempotency is the
// Slack event_ts. Bot echoes (our own outbound) carry a bot_id/subtype → ignored, so
// replies can never loop back into a ticket.
//
// "Wired but inert" until credentials are configured: SLACK_SIGNING_SECRET gates the
// signature check, and a per-connection bot_token gates outbound. Both absent → no-ops.

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const SLACK_UPDATE_URL = "https://slack.com/api/chat.update";
const SLACK_USERINFO_URL = "https://slack.com/api/users.info";
const POST_TIMEOUT_MS = 5_000;
const MAX_SKEW_SEC = 60 * 5; // reject events older than 5 minutes (replay guard)

// ---- Test seam: the fetch used for chat.postMessage ----------------------
// Production uses the global fetch; tests inject a capturing fetch so the suite is
// network-free (mirrors webhooks.__setWebhookFetch).
type FetchFn = typeof fetch;
let slackFetch: FetchFn = (...args) => globalThis.fetch(...args);
export function __setSlackFetch(fn: FetchFn | null): void {
  slackFetch = fn ?? ((...args) => globalThis.fetch(...args));
}

// ---- signature verification (Slack v0 scheme) ----------------------------

/**
 * Verify a Slack request signature. Slack signs `v0:{timestamp}:{rawBody}` with
 * HMAC-SHA256 keyed by the app's signing secret, sending it as `v0=<hex>` in the
 * X-Slack-Signature header alongside X-Slack-Request-Timestamp. We recompute and
 * constant-time compare. Rejects when: the signing secret is unset, the timestamp is
 * missing/old (>5 min — replay guard), or the digest doesn't match. Returns false
 * (never throws) so a bad request is a clean 401 at the route.
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false; // channel not configured — cannot trust anything
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SEC) return false; // stale → replay

  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  // Constant-time compare; length-guard first (timingSafeEqual throws on length mismatch).
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---- tenant routing (system-read via relayPool / BYPASSRLS) --------------

/** Resolve a Slack workspace (team_id) to its tenant. Reads slack_connections on the
 *  BYPASSRLS relay role — this runs BEFORE any tenant context exists (it is how we find
 *  the tenant), so it can't sit behind RLS. Only ACTIVE connections resolve. */
export async function resolveTenantByTeam(teamId: string): Promise<string | null> {
  const r = await relayPool.query(
    "SELECT tenant_id FROM slack_connections WHERE team_id = $1 AND active = true LIMIT 1",
    [teamId],
  );
  return r.rowCount ? (r.rows[0].tenant_id as string) : null;
}

// ---- inbound seam (testable without a live Slack app) --------------------

export type SlackHandleResult =
  | { kind: "url_verification"; challenge: string }
  | { kind: "ingested"; result: IngestResult; teamId: string; channel: string }
  | { kind: "answered"; delivered: boolean }
  | { kind: "reaction"; teamId: string; channel: string; reaction: string; userId: string }
  | { kind: "ignored"; reason: string };

interface SlackEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    channel?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    event_ts?: string;
    reaction?: string;                              // reaction_added: the emoji name
    item?: { type?: string; channel?: string; ts?: string }; // reaction_added: the reacted message
  };
}

/**
 * The inbound seam (tested without a live Slack app): parse the Events API envelope
 * and dispatch. `url_verification` → echo the challenge (the one-time handshake).
 * `event_callback` with a plain user `message` (no bot_id / subtype) → resolve the
 * workspace's tenant (system read) and ingest into ticket+message+outbox, keyed by
 * `${team_id}:${channel}`. Bot echoes (our own outbound), non-message events, and
 * messages from an unconnected workspace are IGNORED (Slack still gets a 200 ack).
 * The Slack event_ts is the idempotency key, so a retried delivery dedupes for free.
 */
export async function handleSlackEvent(rawBody: string): Promise<SlackHandleResult> {
  let env: SlackEnvelope;
  try {
    env = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return { kind: "ignored", reason: "unparseable body" };
  }

  if (env.type === "url_verification") {
    return { kind: "url_verification", challenge: env.challenge ?? "" };
  }

  if (env.type !== "event_callback" || !env.event) {
    return { kind: "ignored", reason: `unhandled type ${env.type ?? "none"}` };
  }

  const ev = env.event;

  // ---- Emoji-reaction triage (Slack triage layer) -------------------------
  // A reaction on any message in a connected channel triages that channel's ticket (the caller maps
  // the emoji → action). Own-bot reactions and reactions in unconnected workspaces are ignored.
  if (ev.type === "reaction_added" && ev.reaction && ev.item?.channel && env.team_id && ev.user && !ev.bot_id) {
    const tid = await resolveTenantByTeam(env.team_id);
    if (!tid) return { kind: "ignored", reason: "unconnected workspace" };
    return { kind: "reaction", teamId: env.team_id, channel: ev.item.channel, reaction: ev.reaction, userId: ev.user };
  }

  // ---- Answer-bot lane (Wave 5 item 20) -----------------------------------
  // @mentioning the bot is a QUESTION, not a support ticket: answer it in-thread from the
  // knowledge base (the Kapa/answer-bot motion), grounded + cited, no ticket created.
  // Plain channel messages below keep creating tickets — the two lanes coexist.
  if (ev.type === "app_mention" && !ev.bot_id) {
    if (!env.team_id || !ev.channel || !ev.text) {
      return { kind: "ignored", reason: "missing team/channel/text" };
    }
    const conn = await connectionByTeam(env.team_id);
    if (!conn) return { kind: "ignored", reason: "unconnected workspace" };
    if (!conn.answer_bot) return { kind: "ignored", reason: "answer bot disabled" };
    const delivered = await answerMention(conn.tenant_id, env.team_id, ev);
    return { kind: "answered", delivered };
  }

  // Only plain user messages. bot_id = our own (and any bot) echo; subtype = edits,
  // joins, channel_topic, etc. — never a fresh customer message. Filtering both here
  // (belt) plus idempotency (braces) means an agent reply can't loop back into a ticket.
  if (ev.type !== "message" || ev.bot_id || ev.subtype) {
    return { kind: "ignored", reason: "bot/subtype/non-message" };
  }
  if (!env.team_id || !ev.channel || !ev.text) {
    return { kind: "ignored", reason: "missing team/channel/text" };
  }

  const tenantId = await resolveTenantByTeam(env.team_id);
  if (!tenantId) return { kind: "ignored", reason: "unconnected workspace" };

  const result = await ingestInbound({
    tenantId,
    body: ev.text,
    authorType: "customer",
    idempotencyKey: `slack:${ev.event_ts || ev.ts}`,
    channelType: "slack",
    externalChannelId: `${env.team_id}:${ev.channel}`,
    identity: { externalId: ev.user ?? null },
  });
  return { kind: "ingested", result, teamId: env.team_id, channel: ev.channel };
}

// ---- answer-bot lane ------------------------------------------------------

/** Workspace connection incl. the answer-bot flag (relay read — pre-tenant). */
async function connectionByTeam(teamId: string): Promise<{ tenant_id: string; answer_bot: boolean } | null> {
  const r = await relayPool.query(
    "SELECT tenant_id, answer_bot FROM slack_connections WHERE team_id = $1 AND active = true LIMIT 1",
    [teamId],
  );
  return r.rowCount ? (r.rows[0] as { tenant_id: string; answer_bot: boolean }) : null;
}

// Slack redelivers events on slow acks; the ingest lane dedupes via idempotencyKey, this
// lane has no store — a bounded in-memory set stops a redelivery double-answering.
const answeredEvents = new Set<string>();
const ANSWERED_CAP = 500;
function alreadyAnswered(eventTs: string): boolean {
  if (answeredEvents.has(eventTs)) return true;
  answeredEvents.add(eventTs);
  if (answeredEvents.size > ANSWERED_CAP) {
    const first = answeredEvents.values().next().value as string;
    answeredEvents.delete(first);
  }
  return false;
}

/** Strip the leading <@UBOT> mention (and any stray user mentions) from the question text. */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Answer an @mention in-thread: run the PUBLIC-audience RAG core (published KB only by
 * default — a Slack workspace can include customers) and post the grounded answer with
 * citation titles back where the question was asked. Returns delivered.
 */
async function answerMention(
  tenantId: string,
  teamId: string,
  ev: { channel?: string; text?: string; ts?: string; thread_ts?: string; event_ts?: string },
): Promise<boolean> {
  const eventTs = ev.event_ts || ev.ts || "";
  if (eventTs && alreadyAnswered(eventTs)) return false;
  const question = stripMentions(ev.text ?? "");
  if (question.length < 3) return false;

  const token = await botTokenFor(tenantId, teamId);
  if (!token) return false;

  let text: string;
  try {
    const s = await suggestForQuery(tenantId, question, { audience: "public", source: "live" });
    const sources = [...new Set(s.citations.map((c) => c.title))].slice(0, 3);
    text = s.draft + (sources.length ? `\n\n_Sources: ${sources.join(" · ")}_` : "");
  } catch {
    text = "Sorry — I couldn't find an answer to that right now.";
  }
  // Reply in the question's thread (thread_ts when the mention was already threaded).
  return postMessage(token, ev.channel ?? "", mdToSlack(text), ev.thread_ts ?? ev.ts);
}

// ---- outbound seam -------------------------------------------------------

/** Low-level chat.postMessage call. Returns delivered (best-effort, 5s timeout). */
async function postMessage(token: string, channel: string, text: string, threadTs?: string): Promise<boolean> {
  if (!channel) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await slackFetch(SLACK_POST_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Parse the `${team_id}:${channel}` external id back into its parts. */
function parseExternal(external: string): { teamId: string; channel: string } | null {
  const i = external.indexOf(":");
  if (i <= 0 || i >= external.length - 1) return null;
  return { teamId: external.slice(0, i), channel: external.slice(i + 1) };
}

/** Look up the bot token for a workspace within the tenant (RLS-scoped read). */
async function botTokenFor(tenantId: string, teamId: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT bot_token FROM slack_connections WHERE team_id = $1 AND active = true LIMIT 1",
      [teamId],
    );
    const tok = r.rowCount ? (r.rows[0].bot_token as string) : "";
    return tok ? tok : null;
  });
}

/**
 * The outbound seam: post an agent reply back to the ticket's origin Slack channel via
 * chat.postMessage, authed with the connection's bot token. No-ops (with a reason) for
 * non-Slack tickets, a malformed external id, or when there's no active connection/token
 * — returning the same delivered/reason shape as the Discord/email seams so a caller can
 * log per-send. Best-effort with a 5s timeout; a Slack `ok:false` reports as not-delivered.
 */
export async function routeSlackOutbound(
  routing: { tenantId: string; channelType?: string; externalChannelId?: string | null },
  body: string,
): Promise<{ delivered: boolean; reason?: string }> {
  if (routing.channelType !== undefined && routing.channelType !== "slack") {
    return { delivered: false, reason: "not-slack" };
  }
  if (!routing.externalChannelId) return { delivered: false, reason: "no-channel" };
  const parts = parseExternal(routing.externalChannelId);
  if (!parts) return { delivered: false, reason: "bad-external-id" };

  const token = await botTokenFor(routing.tenantId, parts.teamId);
  if (!token) return { delivered: false, reason: "slack-disconnected" };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await slackFetch(SLACK_POST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      // Agents author markdown; Slack renders mrkdwn — adapt at the wire (channels/format.ts).
      body: JSON.stringify({ channel: parts.channel, text: mdToSlack(body) }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { delivered: false, reason: `http ${res.status}` };
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!j.ok) return { delivered: false, reason: j.error ?? "slack-error" };
    return { delivered: true };
  } catch (e) {
    return { delivered: false, reason: (e as Error).message ?? "post failed" };
  } finally {
    clearTimeout(t);
  }
}

// ---- Block Kit posters (triage cards / CSAT prompts) ---------------------
// Post/update rich Block Kit messages with the connection's bot token. Return the message ts so a
// card can be edited in place (chat.update). Best-effort with a 5s timeout — a failed post degrades
// to "no card", never throwing into the caller.

/** Post a Block Kit message; returns { ok, ts } (ts is the message id used for later chat.update). */
export async function postSlackBlocks(
  tenantId: string, teamId: string, channel: string, blocks: unknown[], text: string, threadTs?: string,
): Promise<{ ok: boolean; ts: string | null }> {
  const token = await botTokenFor(tenantId, teamId);
  if (!token || !channel) return { ok: false, ts: null };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await slackFetch(SLACK_POST_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, blocks, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
      signal: ctrl.signal,
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string };
    return { ok: j.ok === true, ts: j.ts ?? null };
  } catch {
    return { ok: false, ts: null };
  } finally {
    clearTimeout(t);
  }
}

/** Edit an existing Block Kit message in place (chat.update). Returns delivered. */
export async function updateSlackMessage(
  tenantId: string, teamId: string, channel: string, ts: string, blocks: unknown[], text: string,
): Promise<boolean> {
  const token = await botTokenFor(tenantId, teamId);
  if (!token || !channel || !ts) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await slackFetch(SLACK_UPDATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, ts, blocks, text }),
      signal: ctrl.signal,
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Resolve a Slack user's email (users.info) — the bridge from a Slack actor to a Noola agent (match
 *  by email). Best-effort; null when the scope is missing / the user has no shared email. */
export async function resolveSlackUserEmail(tenantId: string, teamId: string, userId: string): Promise<string | null> {
  const token = await botTokenFor(tenantId, teamId);
  if (!token || !userId) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await slackFetch(`${SLACK_USERINFO_URL}?user=${encodeURIComponent(userId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; user?: { profile?: { email?: string } } };
    return j.ok ? (j.user?.profile?.email ?? null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- CRUD-lite for connections -------------------------------------------

export interface SlackConnectionRow {
  id: string;
  team_id: string;
  has_token: boolean;
  active: boolean;
  answer_bot: boolean;
  created_at: string;
}

// bot_token is deliberately masked to a has_token flag — never echoed by list/get.
const CONN_COLS =
  "id, team_id, (bot_token IS NOT NULL AND bot_token <> '') AS has_token, active, answer_bot, created_at";

export async function listSlackConnections(tenantId: string): Promise<SlackConnectionRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${CONN_COLS} FROM slack_connections ORDER BY created_at DESC LIMIT 200`);
    return r.rows as SlackConnectionRow[];
  });
}

/**
 * Upsert a workspace→tenant connection (onboarding: the customer installs the Slack app,
 * we bind team_id + store its xoxb- bot token). Idempotent on team_id: re-upserting the
 * same workspace updates the token/active flag. An omitted bot_token KEEPS the stored one
 * (write-only semantics), so a toggle-active call never wipes the credential. The unique
 * team_id index means a workspace maps to exactly one tenant.
 */
export async function upsertSlackConnection(
  tenantId: string,
  input: { team_id: string; bot_token?: string; active?: boolean; answer_bot?: boolean },
): Promise<SlackConnectionRow> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO slack_connections (tenant_id, team_id, bot_token, active, answer_bot)
       VALUES (current_tenant(), $1, COALESCE($2, ''), COALESCE($3, true), COALESCE($4, true))
       ON CONFLICT (team_id) DO UPDATE SET
         bot_token  = COALESCE($2, slack_connections.bot_token),
         active     = COALESCE($3, slack_connections.active),
         answer_bot = COALESCE($4, slack_connections.answer_bot)
       RETURNING ${CONN_COLS}`,
      [input.team_id, input.bot_token ?? null, input.active ?? null, input.answer_bot ?? null],
    );
    return r.rows[0] as SlackConnectionRow;
  });
}

export async function deleteSlackConnection(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM slack_connections WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
