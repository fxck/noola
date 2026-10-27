import pg from "pg";
import { withTenant } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { __setSlackFetch, upsertSlackConnection } from "../src/slack.js";
import { upsertSurveySettings } from "../src/surveys.js";
import { runAutomations } from "../src/automations.js";
import { bulkTickets } from "../src/tickets.js";

// CSAT-on-close → one seeded ticket.closed flow (STUDIO-SEEDED-FLOWS.md #2):
//   • the managed survey seed flow fires on ticket.closed and delivers channel-aware — Slack tickets
//     get the native Block Kit 1-5★ prompt (action_id csat_rate); other channels get the text prompt;
//   • once-per-ticket (flow_dedupe) — a second close never re-surveys;
//   • bulkTickets("close") returns only the ids that actually transitioned (so the bulk route emits
//     ticket.closed exactly once per real close).
// Synthetic tenant. Slack HTTP mocked by URL. Needs Postgres. FORCE_RULE_MODEL=1.

const T = "eeeeeeee-2222-4000-8000-0000000000c1";
const TEAM = "CSATCLOSE-team";
const CH = "CSATCLOSE-chan";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

// Capture every Slack HTTP call so we can assert the CSAT prompt was posted.
const slackPosts: Array<{ url: string; body: string }> = [];

async function surveyDetail(ticketId: string): Promise<string> {
  return withTenant(T, async (c) => {
    const r = await c.query(
      `SELECT actions_result FROM automation_runs WHERE ticket_id = $1 AND trigger_event = 'ticket.closed'
         ORDER BY created_at DESC LIMIT 1`,
      [ticketId],
    );
    const results = (r.rows[0]?.actions_result as Array<{ type: string; detail: string }>) ?? [];
    return results.find((x) => x.type === "survey")?.detail ?? "";
  });
}

async function main() {
  __setSlackFetch((async (url: string, init?: RequestInit) => {
    slackPosts.push({ url: String(url), body: typeof init?.body === "string" ? init.body : "" });
    return { ok: true, json: async () => ({ ok: true, ts: "1700000000.000200" }) } as unknown as Response;
  }) as unknown as typeof fetch);

  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 2,
  });
  const clean = async () => {
    const t = "(SELECT id FROM tickets WHERE tenant_id = $1)";
    await superPool.query(`DELETE FROM automation_runs WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM csat_responses WHERE ticket_id IN ${t}`, [T]);
    await superPool.query(`DELETE FROM flow_dedupe WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN ${t}`, [T]);
    await superPool.query(`DELETE FROM automations WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM tickets WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM contacts WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM slack_connections WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM survey_settings WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM tenants WHERE id = $1`, [T]);
  };
  await clean();
  await superPool.query(`INSERT INTO tenants (id, name) VALUES ($1,'CsatCloseTest') ON CONFLICT (id) DO NOTHING`, [T]);

  await upsertSlackConnection(T, { team_id: TEAM, bot_token: "xoxb-csatclose", active: true });
  // Enable CSAT + project the managed ticket.closed → survey seed flow.
  await upsertSurveySettings(T, { csatEnabled: true, npsEnabled: false });
  const seedCount = await withTenant(T, async (c) =>
    (await c.query("SELECT count(*)::int n FROM automations WHERE managed_by = 'surveys' AND enabled")).rows[0].n as number);
  check("survey seed flow projected on ticket.closed", seedCount === 1);

  // A Slack ticket + a widget ticket, both via the real ingest core.
  const slackSeed = await ingestInbound({
    tenantId: T, body: "slack thing broke", authorType: "customer", idempotencyKey: "csatclose-slack-1",
    channelType: "slack", externalChannelId: `${TEAM}:${CH}`, identity: { externalId: "csatclose-slack-cust" },
  });
  const widgetSeed = await ingestInbound({
    tenantId: T, body: "widget thing broke", authorType: "customer", idempotencyKey: "csatclose-widget-1",
    channelType: "widget", identity: { externalId: "csatclose-widget-cust" },
  });
  const slackTicket = slackSeed.ticketId;
  const widgetTicket = widgetSeed.ticketId;
  slackPosts.length = 0; // ignore ingest-time Slack chatter

  // ---- Slack ticket close → Block Kit CSAT prompt ----
  await runAutomations(T, "ticket.closed", { ticketId: slackTicket });
  check("slack close: survey action delivered the Slack CSAT prompt", (await surveyDetail(slackTicket)).includes("Slack CSAT"));
  check("slack close: a Block Kit csat_rate prompt was posted to Slack", slackPosts.some((p) => p.body.includes("csat_rate")));

  // ---- widget ticket close → text survey (NOT a Slack post) ----
  const slackPostsBefore = slackPosts.length;
  await runAutomations(T, "ticket.closed", { ticketId: widgetTicket });
  const wDetail = await surveyDetail(widgetTicket);
  check("widget close: survey action delivered a text survey (not the Slack prompt)",
    wDetail.includes("survey") && !wDetail.includes("Slack"));
  check("widget close: no Slack post for a non-Slack ticket", slackPosts.length === slackPostsBefore);
  const widgetMsg = await withTenant(T, async (c) =>
    (await c.query("SELECT count(*)::int n FROM messages WHERE ticket_id = $1 AND author_type = 'agent' AND body ILIKE '%rate the support%'", [widgetTicket])).rows[0].n as number);
  check("widget close: the text CSAT prompt landed as an agent message", widgetMsg >= 1);

  // ---- once-per-ticket dedupe ----
  slackPosts.length = 0;
  await runAutomations(T, "ticket.closed", { ticketId: slackTicket });
  check("re-close: survey is NOT sent again (flow_dedupe)", (await surveyDetail(slackTicket)).includes("already sent"));
  check("re-close: no second Slack CSAT prompt", !slackPosts.some((p) => p.body.includes("csat_rate")));

  // ---- bulkTickets close returns only transitioned ids ----
  const ids = await withTenant(T, async (c) => {
    const mk = async (status: string) => (await c.query(
      "INSERT INTO tickets (tenant_id, subject, channel_type, status) VALUES (current_tenant(),'bulk','widget',$1) RETURNING id", [status],
    )).rows[0].id as string;
    return { open1: await mk("open"), open2: await mk("open"), closed: await mk("closed") };
  });
  const affected = await bulkTickets(T, [ids.open1, ids.open2, ids.closed], "close", null);
  check("bulk close returns only the 2 open→closed transitions (already-closed excluded)",
    affected.length === 2 && affected.includes(ids.open1) && affected.includes(ids.open2) && !affected.includes(ids.closed));

  await clean();
  await superPool.end();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
