import pg from "pg";
import { appPool, relayPool, withTenant } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { __setSlackFetch, upsertSlackConnection } from "../src/slack.js";
import { handleSlackAskCommand, handleSlackDraftCommand, slackPostDraft, stashSlackDraft, getSlackDraft } from "../src/slack-commands.js";
import { putPolicy, getPolicy } from "../src/autoreply.js";
import { createArticle } from "../src/kb.js";
import { ensureChunksCollection, ensureKbCollection } from "../src/search.js";

// Slack on-demand /ask + /draft — the Slack twin of discord-ondemand, over the SAME answerOnDemand
// core: /ask answers with ambient mode OFF + records a distinct source='on_demand' decision + keeps
// the safety gates + doesn't touch the ambient throttle; /draft resolves the channel ticket and
// ingests nothing; Post ingests once (idempotent). Shared dev/stage DB — all data SLACKTEST/slacktest-
// prefixed. FORCE_RULE_MODEL=1 for determinism. Exit 1 on any fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const TEAM = "SLACKTEST-team";
const CH = "SLACKTEST-chan";
const MARK = "slacktestzarquonwidget";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  // Mock the Slack HTTP seam so routeSlackOutbound "delivers" without a live workspace.
  __setSlackFetch((async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch);

  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 2,
  });
  const clean = async () => {
    const t = "(SELECT id FROM tickets WHERE external_channel_id LIKE 'SLACKTEST-%')";
    await superPool.query(`DELETE FROM answer_claims WHERE message_id IN (SELECT id FROM messages WHERE ticket_id IN ${t})`);
    await superPool.query(`DELETE FROM autoreply_decisions WHERE ticket_id IN ${t}`);
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN ${t}`);
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'SLACKTEST-%'");
    await superPool.query("DELETE FROM slack_connections WHERE team_id LIKE 'SLACKTEST-%'");
    await superPool.query("DELETE FROM kb_articles WHERE title LIKE 'SLACKTEST%'");
    await superPool.query("DELETE FROM draft_traces WHERE query LIKE 'SLACKTEST%'");
    await superPool.query("DELETE FROM contacts WHERE external_id LIKE 'slacktest-%'");
  };
  await clean();

  await upsertSlackConnection(A, { team_id: TEAM, bot_token: "xoxb-slacktest", active: true, answer_bot: true });
  await ensureChunksCollection();
  await ensureKbCollection();
  await createArticle(A, "SLACKTEST Widgets guide", `The ${MARK} dashboard shows recent activity; drag its corner to resize.`);

  const saved = await getPolicy(A);
  await putPolicy(A, { mode: "off" }, { sweep: false }); // prove /ask bypasses mode

  // ── /ask answers with ambient mode OFF + records a distinct on_demand decision ──
  const ask = await handleSlackAskCommand({
    teamId: TEAM, channelId: CH, userId: "slacktest-user-1",
    text: `how do I resize the ${MARK}`, triggerId: "slacktest-trig-1",
  });
  check("/ask answers with ambient mode='off' (bypasses mode)", ask.status === "answered" && !!ask.text);
  check("/ask is public (in-channel)", ask.isPublic === true);

  const ticket = await withTenant(A, async (c) => {
    const r = await c.query("SELECT id FROM tickets WHERE channel_type = 'slack' AND external_channel_id = $1", [`${TEAM}:${CH}`]);
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
  check("/ask created the channel ticket", !!ticket);
  const decisions = await superPool.query("SELECT source, outcome, invoked_by_external_id FROM autoreply_decisions WHERE ticket_id = $1", [ticket]);
  check("/ask records exactly one decision", decisions.rowCount === 1);
  check("/ask decision is source='on_demand'", decisions.rows[0]?.source === "on_demand");
  check("/ask decision outcome auto_sent", decisions.rows[0]?.outcome === "auto_sent");
  check("/ask decision records the invoker", decisions.rows[0]?.invoked_by_external_id === "slacktest-user-1");

  const ambientCount = await withTenant(A, async (c) => {
    const r = await c.query("SELECT count(*)::int AS n FROM autoreply_decisions WHERE ticket_id = $1 AND outcome = 'auto_sent' AND source = 'ambient'", [ticket]);
    return r.rows[0].n as number;
  });
  check("ambient thread-cap query ignores the on_demand auto_send", ambientCount === 0);

  // ── safety gate: a risky /ask is HELD, private ──
  const risky = await handleSlackAskCommand({
    teamId: TEAM, channelId: "SLACKTEST-chan-risk", userId: "slacktest-user-2",
    text: "I demand a full refund and to cancel my account right now", triggerId: "slacktest-trig-risk",
  });
  check("/ask holds a risky question", risky.status === "held");
  check("/ask held reply is private", risky.isPublic === false);

  // ── not-connected workspace ──
  const unlinked = await handleSlackAskCommand({ teamId: "SLACKTEST-nope", channelId: CH, userId: "u", text: "hi", triggerId: "t" });
  check("/ask on an unconnected workspace → not_connected", unlinked.status === "not_connected");

  // ── /draft resolves the channel ticket, ingests NOTHING, Post ingests once ──
  const draftCh = "SLACKTEST-chan-draft";
  await ingestInbound({
    tenantId: A, body: `my ${MARK} won't resize`, authorType: "customer",
    idempotencyKey: "slacktest-seed-1", channelType: "slack", externalChannelId: `${TEAM}:${draftCh}`,
    identity: { externalId: "slacktest-cust" },
  });
  const draftTicket = await withTenant(A, async (c) => {
    const r = await c.query("SELECT id FROM tickets WHERE channel_type = 'slack' AND external_channel_id = $1", [`${TEAM}:${draftCh}`]);
    return r.rows[0].id as string;
  });
  const msgsBefore = await withTenant(A, async (c) => {
    const r = await c.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1", [draftTicket]);
    return r.rows[0].n as number;
  });
  const draft = await handleSlackDraftCommand({ teamId: TEAM, channelId: draftCh, text: "how to resize" });
  check("/draft resolves the channel ticket + returns a draft", draft.status === "drafted" && !!draft.text && draft.ticketId === draftTicket);
  const msgsAfterDraft = await withTenant(A, async (c) => {
    const r = await c.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1", [draftTicket]);
    return r.rows[0].n as number;
  });
  check("/draft ingests NOTHING (no new message)", msgsAfterDraft === msgsBefore);

  // stash + Post (idempotent)
  const token = stashSlackDraft({ teamId: TEAM, channelId: draftCh, ticketId: draftTicket, text: draft.text! });
  check("stashSlackDraft round-trips", getSlackDraft(token)?.text === draft.text);
  await slackPostDraft({ teamId: TEAM, channelId: draftCh, ticketId: draftTicket, text: draft.text!, postId: token });
  await slackPostDraft({ teamId: TEAM, channelId: draftCh, ticketId: draftTicket, text: draft.text!, postId: token });
  const agentMsgs = await withTenant(A, async (c) => {
    const r = await c.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1 AND author_type = 'agent'", [draftTicket]);
    return r.rows[0].n as number;
  });
  check("Post ingests exactly one agent reply (idempotent on postId)", agentMsgs === 1);

  await putPolicy(A, { mode: saved.mode }, { sweep: false });
  await clean();
  __setSlackFetch(null);
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  if (failures > 0) { console.error(`\nSLACK-ONDEMAND: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nSLACK on-demand: all checks green");
}

main().catch((e) => { console.error("slack-ondemand ERROR", e); process.exit(1); });
