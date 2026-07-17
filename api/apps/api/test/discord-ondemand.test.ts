import pg from "pg";
import { appPool, relayPool, withTenant } from "@repo/db";
import { linkGuild, handleInboundMessage } from "../src/discord.js";
import { handleAskCommand, handleDraftCommand, postDraft } from "../src/discord-commands.js";
import { answerOnDemand, putPolicy, checkHardGates, getPolicy } from "../src/autoreply.js";
import { claimAnswer } from "../src/answer-claims.js";
import { createArticle } from "../src/kb.js";
import { ensureChunksCollection, ensureKbCollection } from "../src/search.js";

// Discord Phase 5 — on-demand /ask + /draft. Proves the spec's verify criteria (§12): /ask answers
// with AMBIENT MODE OFF (explicit request bypasses policy.mode), records a DISTINCT source='on_demand'
// decision, keeps the safety gates (a risky /ask is held), enforces its OWN hourly cap, and the
// reciprocal filter keeps on_demand rows OUT of the ambient throttle; /draft resolves the thread
// ticket, ingests NOTHING, and only Post ingests the answer. Runs against the shared dev/stage DB —
// all data ODTEST/odtest- prefixed. Exit 1 on any fail. Set FORCE_RULE_MODEL=1 for determinism.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const GUILD = "ODTEST-guild";
const PARENT = "odtest-parent";
const MARK = "odtestzarquonwidget"; // distinctive KB word

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 2,
  });
  const clean = async () => {
    const t = "(SELECT id FROM tickets WHERE external_thread_id LIKE 'odtest-%')";
    await superPool.query(`DELETE FROM answer_claims WHERE message_id IN (SELECT id FROM messages WHERE ticket_id IN ${t})`);
    await superPool.query(`DELETE FROM autoreply_decisions WHERE ticket_id IN ${t}`);
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN ${t}`);
    await superPool.query("DELETE FROM tickets WHERE external_thread_id LIKE 'odtest-%'");
    await superPool.query("DELETE FROM discord_channel_bindings WHERE guild_id LIKE 'ODTEST%'");
    await superPool.query("DELETE FROM discord_links WHERE guild_id LIKE 'ODTEST%'");
    await superPool.query("DELETE FROM kb_articles WHERE title LIKE 'ODTEST%'");
    await superPool.query("DELETE FROM draft_traces WHERE query LIKE 'ODTEST%'");
    await superPool.query("DELETE FROM contacts WHERE external_id LIKE 'odtest-%'");
  };
  await clean();

  await linkGuild(GUILD, A);
  await superPool.query(
    "INSERT INTO discord_channel_bindings (guild_id, channel_id, tenant_id, mode) VALUES ($1,$2,$3,'staffed') ON CONFLICT DO NOTHING",
    [GUILD, PARENT, A],
  );
  await ensureChunksCollection();
  await ensureKbCollection();
  await createArticle(A, "ODTEST Widgets guide", `The ${MARK} dashboard shows recent activity; drag its corner to resize.`);

  // Ambient auto-reply is OFF for Acme throughout — proves /ask bypasses policy.mode. Preserve/restore.
  const saved = await getPolicy(A);
  await putPolicy(A, { mode: "off" }, { sweep: false });

  // ── checkHardGates (pure) ──
  const pol = await getPolicy(A);
  check("checkHardGates: a clean question is not gated", checkHardGates(pol, "how do I resize a widget").reason === null);
  check("checkHardGates: a risky question trips a guardrail", (checkHardGates(pol, "please give me a refund and my money back").reason ?? "").startsWith("guardrail") || checkHardGates(pol, "cancel my subscription and refund everything now").reason !== null);

  // ── /ask answers with ambient mode OFF + records a distinct on_demand decision ──
  const askThread = "odtest-thread-ask";
  const ask = await handleAskCommand({
    guildId: GUILD, channelId: askThread, parentId: PARENT, threadKind: "text_thread", threadName: "ODTEST ask thread",
    invokerId: "odtest-user-1", invokerDisplayName: "Nova", invokerAvatarUrl: null, invokerRoleIds: [],
    query: `how do I resize the ${MARK}`, interactionId: "odtest-int-1",
  });
  check("/ask answers even with ambient mode='off' (bypasses mode)", ask.status === "answered" && !!ask.text);
  check("/ask is public by default (ondemand_public)", ask.isPublic === true);

  const askTicket = await withTenant(A, async (c) => {
    const r = await c.query("SELECT id FROM tickets WHERE external_thread_id = $1", [askThread]);
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
  check("/ask created the thread ticket", !!askTicket);
  const askDecisions = await superPool.query(
    "SELECT source, outcome, invoked_by_external_id FROM autoreply_decisions WHERE ticket_id = $1", [askTicket],
  );
  check("/ask records exactly one decision", askDecisions.rowCount === 1);
  check("/ask decision is source='on_demand'", askDecisions.rows[0]?.source === "on_demand");
  check("/ask decision outcome auto_sent", askDecisions.rows[0]?.outcome === "auto_sent");
  check("/ask decision records the invoker", askDecisions.rows[0]?.invoked_by_external_id === "odtest-user-1");

  // The /ask question message ingested with skipAutoreply ⇒ only the on_demand claim was taken; a
  // late ambient/automation answerer would find the claim gone and stand down (no double-post).
  const askMsg = await withTenant(A, async (c) => {
    const r = await c.query("SELECT id FROM messages WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 1", [askTicket]);
    return r.rows[0].id as string;
  });
  check("/ask took the turn's claim (a rival answerer is locked out)", (await claimAnswer(A, askMsg, "autoreply")) === false);

  // ── the reciprocal filter: on_demand rows do NOT count toward the ambient thread cap ──
  const ambientThreadCount = await withTenant(A, async (c) => {
    const r = await c.query(
      "SELECT count(*)::int AS n FROM autoreply_decisions WHERE ticket_id = $1 AND outcome = 'auto_sent' AND source = 'ambient'", [askTicket],
    );
    return r.rows[0].n as number;
  });
  check("ambient thread-cap query ignores the on_demand auto_send", ambientThreadCount === 0);

  // ── safety gate: a risky /ask is HELD (never answered publicly) ──
  const risky = await handleAskCommand({
    guildId: GUILD, channelId: "odtest-thread-risk", parentId: PARENT, threadKind: "text_thread", threadName: "ODTEST risk",
    invokerId: "odtest-user-2", invokerDisplayName: "Rex", invokerAvatarUrl: null, invokerRoleIds: [],
    query: "I demand a full refund and to cancel my account right now", interactionId: "odtest-int-risk",
  });
  check("/ask holds a risky question (not answered)", risky.status === "held");
  check("/ask held reply is private (never public)", risky.isPublic === false);

  // ── on-demand hourly cap (deterministic: clear prior on_demand rows so the count starts at 0) ──
  await superPool.query("DELETE FROM autoreply_decisions WHERE source = 'on_demand' AND ticket_id IN (SELECT id FROM tickets WHERE external_thread_id LIKE 'odtest-%')");
  await putPolicy(A, { max_ondemand_per_hour: 1 }, { sweep: false });
  const capA = await answerOnDemandFor(superPool, "odtest-thread-cap-a", "odtest-int-capa"); // consumes the 1 slot
  const capB = await answerOnDemandFor(superPool, "odtest-thread-cap-b", "odtest-int-capb"); // over the cap
  check("on-demand cap: first answer under the cap succeeds", capA === "answered_first");
  check("on-demand cap: the next answer is rate-limited", capB === "ondemand_rate_limited");
  await putPolicy(A, { max_ondemand_per_hour: 120 }, { sweep: false });

  // ── /draft: resolves the thread ticket, ingests NOTHING, then Post ingests the answer ──
  const draftThread = "odtest-thread-draft";
  // Seed a real ticket on the thread via a customer message (mode is off, so no ambient fires).
  await handleInboundMessage({
    guildId: GUILD, channelId: draftThread, authorId: "odtest-cust", content: `my ${MARK} won't resize`,
    discordMessageId: "odtest-seed-1", threadId: draftThread, parentId: PARENT, threadKind: "text_thread",
    authorDisplayName: "Ada", isBotOrWebhook: false,
  });
  const draftTicket = await withTenant(A, async (c) => {
    const r = await c.query("SELECT id FROM tickets WHERE external_thread_id = $1", [draftThread]);
    return r.rows[0].id as string;
  });
  const msgsBefore = await withTenant(A, async (c) => {
    const r = await c.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1", [draftTicket]);
    return r.rows[0].n as number;
  });
  const draft = await handleDraftCommand({ guildId: GUILD, channelId: draftThread, query: "how to resize" });
  check("/draft resolves the thread ticket + returns a draft", draft.status === "drafted" && !!draft.text && draft.ticketId === draftTicket);
  const msgsAfterDraft = await withTenant(A, async (c) => {
    const r = await c.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1", [draftTicket]);
    return r.rows[0].n as number;
  });
  check("/draft ingests NOTHING (no new message)", msgsAfterDraft === msgsBefore);
  const noDraftDecision = await superPool.query("SELECT count(*)::int AS n FROM autoreply_decisions WHERE ticket_id = $1", [draftTicket]);
  check("/draft records no decision", noDraftDecision.rows[0].n === 0);

  // Post the draft → one agent reply is ingested; a repeat Post (same postId) is idempotent.
  await postDraft({ guildId: GUILD, channelId: draftThread, ticketId: draftTicket, text: draft.text!, postId: "odtest-post-1" });
  await postDraft({ guildId: GUILD, channelId: draftThread, ticketId: draftTicket, text: draft.text!, postId: "odtest-post-1" });
  const msgsAfterPost = await withTenant(A, async (c) => {
    const r = await c.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1 AND author_type = 'agent'", [draftTicket]);
    return r.rows[0].n as number;
  });
  check("Post ingests exactly one agent reply (idempotent on postId)", msgsAfterPost === 1);

  // restore Acme's policy
  await putPolicy(A, { mode: saved.mode, max_ondemand_per_hour: saved.max_ondemand_per_hour }, { sweep: false });
  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  if (failures > 0) { console.error(`\nDISCORD-ONDEMAND: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nDISCORD PHASE 5 (on-demand): all checks green");
}

/** Run /ask on a fresh thread; return 'answered_first' | 'ondemand_rate_limited' for the cap test. */
async function answerOnDemandFor(superPool: pg.Pool, thread: string, interactionId: string): Promise<string> {
  const res = await handleAskCommand({
    guildId: GUILD, channelId: thread, parentId: PARENT, threadKind: "text_thread", threadName: "ODTEST cap",
    invokerId: "odtest-user-cap", invokerDisplayName: "Cap", invokerAvatarUrl: null, invokerRoleIds: [],
    query: `resize the ${MARK}`, interactionId,
  });
  if (res.status === "answered") return "answered_first";
  const ticket = await superPool.query("SELECT id FROM tickets WHERE external_thread_id = $1", [thread]);
  if (ticket.rowCount) {
    const d = await superPool.query("SELECT reason FROM autoreply_decisions WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1", [ticket.rows[0].id]);
    return (d.rows[0]?.reason as string) ?? res.status;
  }
  return res.status;
}

main().catch((e) => { console.error("discord-ondemand ERROR", e); process.exit(1); });
