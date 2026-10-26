import pg from "pg";
import { appPool, relayPool, withTenant } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { __setSlackFetch, upsertSlackConnection } from "../src/slack.js";
import { createCompany } from "../src/companies.js";
import {
  applySlackAction, handleSlackReaction, refreshSlackCard, recordSlackCsat,
  setChannelAccount, applyChannelAccount, listChannelAccounts,
} from "../src/slack-triage.js";

// Slack triage layer — in-Slack ticket management. Proves the action core (close/reopen/snooze/
// priority/note/assign-by-email/unassign) drives the SAME ticket engine, emoji reactions map to
// actions, the status card is posted + stored, CSAT records, and channel→account binding rolls a
// contact up to a company. Slack HTTP is mocked by URL (chat.postMessage/update + users.info). Shared
// dev/stage DB — TRIAGETEST/triagetest- prefixed. FORCE_RULE_MODEL=1. Exit 1 on any fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const TEAM = "TRIAGETEST-team";
const CH = "TRIAGETEST-chan";

let failures = 0;
let AGENT_EMAIL = "agent@acme.test";
const OUTSIDER = "U-triagetest-outsider";
const NO_EMAIL = "U-triagetest-noemail";
const NO_SCOPE = "U-triagetest-noscope";
const LINKED = "U-triagetest-linked";
const REFUSED = "Only teammates can do that. If you are one, add your Slack member ID to your Noola profile.";
const userInfoCalls: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  // Mock Slack HTTP by URL: users.info → the seeded agent's email (an unknown email for the outsider); chat.* → ok + a ts.
  __setSlackFetch((async (url: string) => {
    const u = String(url);
    if (u.includes("users.info")) {
      const who = new URL(u).searchParams.get("user") ?? "";
      userInfoCalls.push(who);
      if (who === NO_EMAIL || who === LINKED) return { ok: true, json: async () => ({ ok: true, user: { profile: {} } }) } as unknown as Response;
      if (who === NO_SCOPE) return { ok: true, json: async () => ({ ok: false, error: "missing_scope" }) } as unknown as Response;
      const email = who === OUTSIDER ? "triagetest-outsider@example.test" : AGENT_EMAIL;
      return { ok: true, json: async () => ({ ok: true, user: { profile: { email } } }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({ ok: true, ts: "1700000000.000100" }) } as unknown as Response;
  }) as unknown as typeof fetch);

  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 2,
  });
  const clean = async () => {
    const t = "(SELECT id FROM tickets WHERE external_channel_id LIKE 'TRIAGETEST-%')";
    await superPool.query(`DELETE FROM ticket_notes WHERE ticket_id IN ${t}`);
    await superPool.query(`DELETE FROM csat_responses WHERE ticket_id IN ${t}`);
    await superPool.query(`DELETE FROM slack_ticket_cards WHERE ticket_id IN ${t}`);
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN ${t}`);
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'TRIAGETEST-%'");
    await superPool.query("DELETE FROM slack_channel_accounts WHERE team_id LIKE 'TRIAGETEST-%'");
    await superPool.query("DELETE FROM slack_connections WHERE team_id LIKE 'TRIAGETEST-%'");
    // Null the FK before deleting the company: contacts_company_fk is a COMPOSITE (tenant_id,
    // company_id) ON DELETE SET NULL, which would try to null tenant_id too (NOT NULL) on delete.
    await superPool.query("UPDATE contacts SET company_id = NULL WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'TRIAGETEST%')");
    await superPool.query("DELETE FROM contacts WHERE external_id LIKE 'triagetest-%'");
    await superPool.query("DELETE FROM companies WHERE name LIKE 'TRIAGETEST%'");
    await superPool.query("DELETE FROM agent_channel_identities WHERE external_id = $1", [LINKED]);
  };
  await clean();

  // A seeded agent whose email we can match on for assign-to-me.
  const agent = await superPool.query("SELECT id, email FROM users WHERE tenant_id = $1 AND email IS NOT NULL ORDER BY created_at ASC LIMIT 1", [A]);
  const agentId = agent.rows[0].id as string;
  AGENT_EMAIL = agent.rows[0].email as string;

  await upsertSlackConnection(A, { team_id: TEAM, bot_token: "xoxb-triagetest", active: true });

  const ext = `${TEAM}:${CH}`;
  const seed = await ingestInbound({
    tenantId: A, body: "TRIAGETEST my thing is broken", authorType: "customer",
    idempotencyKey: "triagetest-seed-1", channelType: "slack", externalChannelId: ext,
    identity: { externalId: "triagetest-cust" },
  });
  const ticketId = seed.ticketId;
  const brief = async () => withTenant(A, async (c) => {
    const r = await c.query("SELECT status, priority, assignee_id, snoozed_until FROM tickets WHERE id = $1", [ticketId]);
    return r.rows[0];
  });

  // ── action core ──
  await applySlackAction({ teamId: TEAM, channelId: CH, actorId: "U1", kind: "priority", value: "high" });
  check("priority action → high", (await brief()).priority === "high");

  await applySlackAction({ teamId: TEAM, channelId: CH, actorId: "U1", kind: "snooze", value: "1d" });
  check("snooze action → snoozed_until set", !!(await brief()).snoozed_until);

  await applySlackAction({ teamId: TEAM, channelId: CH, actorId: "U1", actorName: "Sam", kind: "note", value: "internal: escalate to eng" });
  const notes = await superPool.query("SELECT count(*)::int AS n FROM ticket_notes WHERE ticket_id = $1", [ticketId]);
  check("note action → an internal note is created", notes.rows[0].n === 1);
  const noteAuthor = await superPool.query("SELECT author_id FROM ticket_notes WHERE ticket_id = $1", [ticketId]);
  check("note action → the note is authored by the resolved teammate", noteAuthor.rows[0]?.author_id === agentId);

  // ── a non-teammate is refused every action, and nothing is written ──
  const outsiderNote = await applySlackAction({ teamId: TEAM, channelId: CH, actorId: OUTSIDER, actorName: "Eve", kind: "note", value: "TRIAGETEST sneaky" });
  check("note by a non-teammate → refused", !outsiderNote.ok && outsiderNote.message === REFUSED);
  const notesAfter = await superPool.query("SELECT count(*)::int AS n FROM ticket_notes WHERE ticket_id = $1", [ticketId]);
  check("note by a non-teammate writes no note", notesAfter.rows[0].n === 1);
  const outsiderClose = await applySlackAction({ teamId: TEAM, channelId: CH, actorId: OUTSIDER, kind: "close" });
  check("close by a non-teammate → refused", !outsiderClose.ok && outsiderClose.message === REFUSED);
  check("close by a non-teammate leaves the ticket open", (await brief()).status === "open");
  await handleSlackReaction(TEAM, CH, "white_check_mark", OUTSIDER);
  check("✅ reaction by a non-teammate leaves the ticket open", (await brief()).status === "open");
  check("a non-teammate miss is cached (users.info called once)", userInfoCalls.filter((x) => x === OUTSIDER).length === 1);

  const noEmailClose = await applySlackAction({ teamId: TEAM, channelId: CH, actorId: NO_EMAIL, kind: "close" });
  await handleSlackReaction(TEAM, CH, "white_check_mark", NO_EMAIL);
  check("a user without an e-mail is refused", !noEmailClose.ok && noEmailClose.message === REFUSED && (await brief()).status === "open");
  check("a user without an e-mail is cached (users.info called once)", userInfoCalls.filter((x) => x === NO_EMAIL).length === 1);

  // A teammate who linked their Slack member ID in their profile acts even without a matching e-mail.
  await superPool.query(
    "INSERT INTO agent_channel_identities (tenant_id, user_id, channel_type, external_id) VALUES ($1, $2, 'slack', $3) ON CONFLICT DO NOTHING",
    [A, agentId, LINKED],
  );
  const linkedNote = await applySlackAction({ teamId: TEAM, channelId: CH, actorId: LINKED, kind: "note", value: "TRIAGETEST linked note" });
  check("a linked Slack member ID counts as a teammate", linkedNote.ok === true);
  check("the linked lookup needs no users.info call", !userInfoCalls.includes(LINKED));

  const noScopeClose = await applySlackAction({ teamId: TEAM, channelId: CH, actorId: NO_SCOPE, kind: "close" });
  await handleSlackReaction(TEAM, CH, "white_check_mark", NO_SCOPE);
  check("a non-ok users.info reply refuses the caller", !noScopeClose.ok && (await brief()).status === "open");
  check("a non-ok users.info reply is not cached (users.info called twice)", userInfoCalls.filter((x) => x === NO_SCOPE).length === 2);

  const assign = await applySlackAction({ teamId: TEAM, channelId: CH, actorId: "U-slack", kind: "assign_me" });
  check("assign_me → matches the Slack user to a Noola agent by email", assign.ok && (await brief()).assignee_id === agentId);

  await applySlackAction({ teamId: TEAM, channelId: CH, actorId: "U1", kind: "unassign" });
  check("unassign → assignee cleared", (await brief()).assignee_id === null);

  // ── emoji-reaction triage ──
  await handleSlackReaction(TEAM, CH, "white_check_mark", "U1");
  check("✅ reaction → ticket closed", (await brief()).status === "closed");
  await handleSlackReaction(TEAM, CH, "arrows_counterclockwise", "U1");
  check("🔄 reaction → ticket reopened", (await brief()).status === "open");
  await handleSlackReaction(TEAM, CH, "pizza", "U1"); // unmapped → no-op
  check("an unmapped reaction is a no-op", (await brief()).status === "open");

  // ── status card persisted ──
  await refreshSlackCard(A, TEAM, CH, ticketId);
  const card = await superPool.query("SELECT message_ts, channel FROM slack_ticket_cards WHERE ticket_id = $1", [ticketId]);
  check("status card row is stored with a message ts", card.rowCount === 1 && !!card.rows[0].message_ts);
  check("status card records the slack channel", card.rows[0].channel === CH);

  // ── CSAT ──
  const csat = await recordSlackCsat(A, ticketId, 5);
  check("CSAT rating records a response", csat === true);
  const csatRow = await superPool.query("SELECT rating FROM csat_responses WHERE ticket_id = $1", [ticketId]);
  check("CSAT stored rating = 5", csatRow.rows[0]?.rating === 5);

  // ── account binding ──
  const company = await createCompany(A, { name: "TRIAGETEST Acme Corp" });
  await setChannelAccount(A, TEAM, CH, company.id);
  check("channel-account binding is listed", (await listChannelAccounts(A)).some((x) => x.channel === CH && x.company_id === company.id));
  await applyChannelAccount(A, TEAM, CH, seed.contactId);
  const contact = await withTenant(A, async (c) => {
    const r = await c.query("SELECT company_id FROM contacts WHERE id = $1", [seed.contactId]);
    return r.rows[0];
  });
  check("ingest in a bound channel rolls the contact up to the company", contact.company_id === company.id);

  // unconnected workspace guard
  const un = await applySlackAction({ teamId: "TRIAGETEST-nope", channelId: CH, actorId: "U1", kind: "close" });
  check("action on an unconnected workspace is refused", !un.ok);

  await clean();
  __setSlackFetch(null);
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  if (failures > 0) { console.error(`\nSLACK-TRIAGE: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nSLACK triage: all checks green");
}

main().catch((e) => { console.error("slack-triage ERROR", e); process.exit(1); });
