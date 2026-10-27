import pg from "pg";
import { createHmac } from "node:crypto";
import { appPool, relayPool, withTenant } from "@repo/db";
import {
  verifySlackSignature,
  handleSlackEvent,
  routeSlackOutbound,
  listSlackConnections,
  upsertSlackConnection,
  deleteSlackConnection,
  __setSlackFetch,
} from "../src/slack.js";

// Slice-18 seam gate: proves the Slack channel verifies request signatures, echoes the
// url_verification challenge, resolves team→tenant (system read), ingests into
// ticket+message+outbox keyed by team:channel, dedupes on event_ts, ignores bot/subtype
// echoes + unconnected workspaces, posts outbound via chat.postMessage with the
// connection's bot token, masks the token in CRUD, and holds tenant isolation — all
// WITHOUT a live Slack app (fetch is injected). Exit 1 on any fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex

const TEAM_A = "SLACKTEST-team-acme";
const TEAM_B = "SLACKTEST-team-globex";
const TEAM_UN = "SLACKTEST-team-unmapped";
const CHAN_A = "C-slacktest-a";
const CHAN_B = "C-slacktest-b";
const MSG_A1 = "SLACKTEST hello from acme customer";
const SECRET = "slacktest-signing-secret";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

/** Slack's v0 signature over `v0:{ts}:{raw}`. */
function sign(ts: string, raw: string): string {
  return `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function main() {
  process.env.SLACK_SIGNING_SECRET = SECRET;

  const superPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER,
    password: process.env.DB_SUPER_PASSWORD,
    max: 1,
  });

  const clean = async () => {
    await superPool.query("DELETE FROM messages WHERE body LIKE 'SLACKTEST%'");
    await superPool.query("DELETE FROM messages WHERE idempotency_key LIKE 'slack:slacktest-%'");
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'SLACKTEST%'");
    await superPool.query("DELETE FROM outbox WHERE payload->'data'->>'body' LIKE 'SLACKTEST%'");
    await superPool.query("DELETE FROM slack_connections WHERE team_id LIKE 'SLACKTEST%'");
  };
  await clean();

  // ---- 1. signature verification (valid / invalid / stale / unsigned) ----
  {
    const raw = `{"type":"event_callback"}`;
    const ts = nowTs();
    check("valid signature verifies", verifySlackSignature(raw, ts, sign(ts, raw)) === true);
    check(
      "tampered signature rejected",
      verifySlackSignature(raw, ts, sign(ts, raw + "x")) === false,
    );
    check(
      "wrong-secret signature rejected",
      verifySlackSignature(raw, ts, `v0=${createHmac("sha256", "nope").update(`v0:${ts}:${raw}`).digest("hex")}`) === false,
    );
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 10); // 10 min old
    check("stale timestamp (>5min) rejected", verifySlackSignature(raw, staleTs, sign(staleTs, raw)) === false);
    check("missing signature rejected", verifySlackSignature(raw, ts, undefined) === false);
    check("missing timestamp rejected", verifySlackSignature(raw, undefined, sign(ts, raw)) === false);

    const saved = process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    check("no signing secret → verify fails (channel unconfigured)", verifySlackSignature(raw, ts, sign(ts, raw)) === false);
    process.env.SLACK_SIGNING_SECRET = saved;
  }

  // ---- 2. url_verification handshake echoes the challenge ----------------
  {
    const raw = JSON.stringify({ type: "url_verification", challenge: "SLACKTEST-challenge-xyz" });
    const r = await handleSlackEvent(raw);
    check(
      "url_verification → returns the challenge",
      r.kind === "url_verification" && r.challenge === "SLACKTEST-challenge-xyz",
    );
  }

  // connect two workspaces to two tenants (with bot tokens)
  await upsertSlackConnection(A, { team_id: TEAM_A, bot_token: "xoxb-acme-token" });
  await upsertSlackConnection(B, { team_id: TEAM_B, bot_token: "xoxb-globex-token" });

  // ---- 3. event_callback message → ingest under the workspace's tenant ---
  let acmeTicketId = "";
  {
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_A,
      event: { type: "message", channel: CHAN_A, text: MSG_A1, event_ts: "slacktest-a-1" },
    });
    const r = await handleSlackEvent(raw);
    check("connected workspace message → ingested", r.kind === "ingested");
    if (r.kind === "ingested") {
      check("first message is not a replay", r.result.replay === false);
      check(
        "ticket typed as the slack channel, keyed team:channel",
        r.result.channelType === "slack" && r.result.externalChannelId === `${TEAM_A}:${CHAN_A}`,
      );
      acmeTicketId = r.result.ticketId;
    }
    await withTenant(A, async (c) => {
      const t = await c.query(
        "SELECT channel_type, external_channel_id FROM tickets WHERE id = $1",
        [acmeTicketId],
      );
      check(
        "Acme sees the slack ticket (channel_type=slack, external id set)",
        t.rowCount === 1 && t.rows[0].channel_type === "slack" && t.rows[0].external_channel_id === `${TEAM_A}:${CHAN_A}`,
      );
      const m = await c.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1", [acmeTicketId]);
      check("Acme ticket carries exactly 1 message", m.rows[0].n === 1);
    });
    const ob = await relayPool.query(
      "SELECT subject FROM outbox WHERE payload->'data'->>'body' = $1",
      [MSG_A1],
    );
    check(
      "outbox event emitted with the per-tenant subject",
      ob.rowCount === 1 && ob.rows[0].subject === `noola.events.${A}`,
    );
  }

  // ---- 4. redelivery of the same event_ts dedupes -----------------------
  {
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_A,
      event: { type: "message", channel: CHAN_A, text: MSG_A1, event_ts: "slacktest-a-1" },
    });
    const r = await handleSlackEvent(raw);
    check("replayed event_ts → replay=true", r.kind === "ingested" && r.result.replay === true);
    await withTenant(A, async (c) => {
      const m = await c.query(
        "SELECT count(*)::int AS n FROM messages WHERE idempotency_key = 'slack:slacktest-a-1'",
      );
      check("no duplicate message for the replayed event_ts", m.rows[0].n === 1);
    });
  }

  // ---- 5. bot / subtype echoes are ignored (no echo loop) ---------------
  {
    const botRaw = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_A,
      event: { type: "message", channel: CHAN_A, text: "SLACKTEST our own reply", bot_id: "B123", event_ts: "slacktest-bot-1" },
    });
    const rb = await handleSlackEvent(botRaw);
    check("bot_id message ignored", rb.kind === "ignored");

    const subRaw = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_A,
      event: { type: "message", subtype: "message_changed", channel: CHAN_A, text: "SLACKTEST edited", event_ts: "slacktest-sub-1" },
    });
    const rs = await handleSlackEvent(subRaw);
    check("subtype message ignored", rs.kind === "ignored");

    const n = await superPool.query(
      "SELECT count(*)::int AS n FROM messages WHERE idempotency_key IN ('slack:slacktest-bot-1','slack:slacktest-sub-1')",
    );
    check("no message row created for bot/subtype echoes", n.rows[0].n === 0);
  }

  // ---- 6. an unconnected workspace is ignored (no leak) -----------------
  {
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_UN,
      event: { type: "message", channel: "C-nope", text: "SLACKTEST from nowhere", event_ts: "slacktest-un-1" },
    });
    const r = await handleSlackEvent(raw);
    check("unconnected workspace → ignored", r.kind === "ignored");
    const n = await superPool.query(
      "SELECT count(*)::int AS n FROM tickets WHERE external_channel_id = $1",
      [`${TEAM_UN}:C-nope`],
    );
    check("unconnected workspace created no ticket", n.rows[0].n === 0);
  }

  // ---- 7. cross-tenant isolation ----------------------------------------
  {
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_B,
      event: { type: "message", channel: CHAN_B, text: "SLACKTEST globex only", event_ts: "slacktest-b-1" },
    });
    const r = await handleSlackEvent(raw);
    check("globex workspace resolves + ingests", r.kind === "ingested" && r.result.channelType === "slack");
    await withTenant(A, async (c) => {
      const t = await c.query("SELECT count(*)::int AS n FROM tickets WHERE external_channel_id = $1", [`${TEAM_B}:${CHAN_B}`]);
      check("Acme cannot see Globex's slack ticket (isolation holds)", t.rows[0].n === 0);
    });
    await withTenant(B, async (c) => {
      const t = await c.query("SELECT count(*)::int AS n FROM tickets WHERE external_channel_id = $1", [`${TEAM_B}:${CHAN_B}`]);
      check("Globex sees its own slack ticket", t.rows[0].n === 1);
    });
  }

  // ---- 8. outbound: posts to chat.postMessage with the bot token --------
  {
    let captured: { url: string; auth: string | null; body: unknown } | null = null;
    __setSlackFetch(async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured = {
        url: String(url),
        auth: headers["authorization"] ?? headers["Authorization"] ?? null,
        body: JSON.parse(String(init?.body ?? "{}")),
      };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const ok = await routeSlackOutbound(
      { tenantId: A, channelType: "slack", externalChannelId: `${TEAM_A}:${CHAN_A}` },
      "SLACKTEST agent reply",
    );
    check("routeSlackOutbound delivers", ok.delivered === true);
    check(
      "posts to chat.postMessage with the connection's bot token + channel/text",
      captured !== null &&
        captured!.url === "https://slack.com/api/chat.postMessage" &&
        captured!.auth === "Bearer xoxb-acme-token" &&
        (captured!.body as { channel: string; text: string }).channel === CHAN_A &&
        (captured!.body as { channel: string; text: string }).text === "SLACKTEST agent reply",
    );

    // no-op for a non-slack ticket
    captured = null;
    const notSlack = await routeSlackOutbound(
      { tenantId: A, channelType: "discord", externalChannelId: CHAN_A }, "hi",
    );
    check("routeSlackOutbound no-ops for non-slack tickets", notSlack.delivered === false && notSlack.reason === "not-slack" && captured === null);

    // no-op when the connection has no token
    await upsertSlackConnection(A, { team_id: "SLACKTEST-team-notoken", bot_token: "" });
    captured = null;
    const noTok = await routeSlackOutbound(
      { tenantId: A, channelType: "slack", externalChannelId: `SLACKTEST-team-notoken:C-x` }, "hi",
    );
    check(
      "routeSlackOutbound reports disconnected with no token (no post)",
      noTok.delivered === false && noTok.reason === "slack-disconnected" && captured === null,
    );

    // a Slack ok:false reports not-delivered
    __setSlackFetch(async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }));
    const slackErr = await routeSlackOutbound(
      { tenantId: A, channelType: "slack", externalChannelId: `${TEAM_A}:${CHAN_A}` }, "hi",
    );
    check("slack ok:false → not delivered with the error reason", slackErr.delivered === false && slackErr.reason === "channel_not_found");

    __setSlackFetch(null);
  }

  // ---- 9. CRUD-lite + token masking -------------------------------------
  {
    const list = await listSlackConnections(A);
    const conn = list.find((c) => c.team_id === TEAM_A);
    check("listSlackConnections returns the tenant's connection", conn !== undefined);
    check("bot_token is masked to has_token (never echoed)", conn !== undefined && conn.has_token === true && !("bot_token" in conn));

    // omitting bot_token on a re-upsert keeps the stored token (write-only semantics)
    const toggled = await upsertSlackConnection(A, { team_id: TEAM_A, active: false });
    check("re-upsert without bot_token keeps has_token + toggles active", toggled.has_token === true && toggled.active === false);
    await upsertSlackConnection(A, { team_id: TEAM_A, active: true }); // restore

    // isolation: B's list never contains Acme's connection
    const bList = await listSlackConnections(B);
    check("tenant isolation: Globex cannot list Acme's connection", bList.every((c) => c.team_id !== TEAM_A));

    // A second tenant claiming the same workspace is rejected: the global unique team_id
    // index makes the upsert an ON CONFLICT, whose DO UPDATE targets the owning tenant's
    // row — invisible under RLS, so it raises 42501 (RLS USING rejection). The workspace
    // stays with its original tenant (no cross-tenant hijack).
    let clash = "";
    try {
      await upsertSlackConnection(B, { team_id: TEAM_A, bot_token: "xoxb-hijack" });
    } catch (e) {
      clash = (e as { code?: string }).code ?? "err";
    }
    check("a workspace maps to exactly one tenant (cross-tenant claim → 42501 RLS reject)", clash === "42501");
    const stillA = await relayPool.query("SELECT tenant_id FROM slack_connections WHERE team_id = $1", [TEAM_A]);
    check("workspace not hijacked — still owned by the original tenant", stillA.rowCount === 1 && stillA.rows[0].tenant_id === A);

    // delete
    if (conn) {
      const gone = await deleteSlackConnection(A, conn.id);
      check("deleteSlackConnection removes the connection", gone === true);
      const after = await listSlackConnections(A);
      check("connection is gone after delete", after.every((c) => c.team_id !== TEAM_A));
    }
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nSLACK SEAM: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nSLACK SEAM: all checks green");
}

main().catch((e) => {
  console.error("slack seam ERROR", e);
  process.exit(1);
});
