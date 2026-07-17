import pg from "pg";
import { appPool, relayPool, withTenant } from "@repo/db";
import {
  handleInboundMessage,
  routeOutbound,
  linkGuild,
  handleThreadCreate,
  handleMessageUpdate,
  handleMessageDelete,
  type InboundDiscordMessage,
} from "../src/discord.js";
import { claimAnswer } from "../src/answer-claims.js";
import {
  classifyDiscordAuthor,
  setDiscordClassification,
  upsertAgentChannelIdentity,
} from "../src/discord-classify.js";
import { listTickets } from "../src/tickets.js";
import { putPolicy, evaluateAutoreply } from "../src/autoreply.js";
import { createArticle } from "../src/kb.js";
import { suggestReply } from "../src/copilot.js";
import { ensureChunksCollection, ensureKbCollection } from "../src/search.js";

// Discord rework Phase 1 gate: proves thread = ticket (keyed on the thread id, not the contact),
// per-message external author identity, channel scoping (bindings), content-union ingest,
// the message/thread lifecycle handlers, and single-answer arbitration — all WITHOUT a live gateway.
// Exit 1 on any fail. Runs against the shared dev/stage DB, so all data is DISCTEST/disctest- prefixed.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex

const GUILD_A = "DISCTEST-guild-acme";
const GUILD_B = "DISCTEST-guild-globex";
const GUILD_UN = "DISCTEST-guild-unmapped";
const PARENT_BOUND = "disctest-parent-bound";
const PARENT_UNBOUND = "disctest-parent-unbound";
const PARENT_COMMUNITY = "disctest-parent-community"; // GUILD_A, mode='community' (Phase 3)
const PARENT_B_COMM = "disctest-parent-b-comm";       // GUILD_B community (deflect-once isolation)
const PARENT_B_STAFF = "disctest-parent-b-staff";     // GUILD_B staffed control
const MARK = "disctestwidgetzarquon";                 // distinctive KB word for deterministic retrieval

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

/** A thread inbound with the common Discord shape filled in. */
function thread(over: Partial<InboundDiscordMessage> & { threadId: string; discordMessageId: string; authorId: string }): InboundDiscordMessage {
  return {
    guildId: GUILD_A,
    channelId: over.threadId,          // a thread message's channelId IS the thread id (discord.js)
    content: "DISCTEST question",
    parentId: PARENT_BOUND,
    threadKind: "text_thread",
    authorDisplayName: "Nova",
    ...over,
  };
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER,
    password: process.env.DB_SUPER_PASSWORD,
    max: 1,
  });

  const clean = async () => {
    await superPool.query("DELETE FROM answer_claims WHERE message_id IN (SELECT id FROM messages WHERE body LIKE 'DISCTEST%')");
    // Phase 3 (deflect-once): autoreply rows keyed on the DISCTEST thread-tickets — purge before the
    // tickets so nothing dangles (the AI agent reply the deflect posts carries no DISCTEST body).
    const discTickets = "SELECT id FROM tickets WHERE external_thread_id LIKE 'disctest-%' OR external_channel_id LIKE 'disctest-%'";
    await superPool.query(`DELETE FROM answer_claims WHERE message_id IN (SELECT id FROM messages WHERE ticket_id IN (${discTickets}))`);
    await superPool.query(`DELETE FROM autoreply_jobs WHERE ticket_id IN (${discTickets})`);
    await superPool.query(`DELETE FROM autoreply_queue WHERE ticket_id IN (${discTickets})`);
    await superPool.query(`DELETE FROM autoreply_decisions WHERE ticket_id IN (${discTickets})`);
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN (${discTickets})`);
    await superPool.query("DELETE FROM message_attachments WHERE storage_key LIKE 'disctest-%'");
    await superPool.query("DELETE FROM messages WHERE body LIKE 'DISCTEST%'");
    await superPool.query("DELETE FROM messages WHERE idempotency_key LIKE 'discord:disctest-%'");
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'disctest-%'");
    await superPool.query("DELETE FROM tickets WHERE external_thread_id LIKE 'disctest-%'");
    await superPool.query("DELETE FROM outbox WHERE payload->'data'->>'body' LIKE 'DISCTEST%'");
    await superPool.query("DELETE FROM discord_channel_bindings WHERE guild_id LIKE 'DISCTEST%'");
    await superPool.query("DELETE FROM discord_links WHERE guild_id LIKE 'DISCTEST%'");
    await superPool.query("DELETE FROM agent_channel_identities WHERE external_id LIKE 'disctest-%'");
    await superPool.query("DELETE FROM kb_articles WHERE title LIKE 'DISCTEST%'");
    await superPool.query("DELETE FROM draft_traces WHERE query LIKE 'DISCTEST%'");
    // The deflect-once test drives tenant B's autoreply policy to 'auto'; reset it so the shared
    // tenant isn't left auto-answering (mirrors autoreply.test's policy cleanup).
    await superPool.query("DELETE FROM autoreply_policy WHERE tenant_id = $1", [B]);
  };
  await clean();

  // link two servers to two tenants; explicitly bind ONE parent channel per guild (allow-list mode).
  await linkGuild(GUILD_A, A);
  await linkGuild(GUILD_B, B);
  await relayPool.query(
    "INSERT INTO discord_channel_bindings (guild_id, channel_id, tenant_id, mode) VALUES ($1,$2,$3,'staffed') ON CONFLICT DO NOTHING",
    [GUILD_A, PARENT_BOUND, A],
  );

  // 1 — unmapped guild creates nothing (no leak)
  {
    const r = await handleInboundMessage(thread({ guildId: GUILD_UN, parentId: "disctest-parent-un", threadId: "disctest-thread-un", authorId: "u1", discordMessageId: "disctest-un-1", content: "DISCTEST nowhere" }));
    check("unmapped guild → handleInboundMessage returns null", r === null);
  }

  // 2 — two threads from the SAME author → TWO tickets (thread key, not contact-collapse)
  let ticketA1 = "", ticketA2 = "";
  {
    const r1 = await handleInboundMessage(thread({ threadId: "disctest-thread-a1", authorId: "cust-same", discordMessageId: "disctest-a1", content: "DISCTEST thread one" }));
    const r2 = await handleInboundMessage(thread({ threadId: "disctest-thread-a2", authorId: "cust-same", discordMessageId: "disctest-a2", content: "DISCTEST thread two" }));
    ticketA1 = r1?.ticketId ?? ""; ticketA2 = r2?.ticketId ?? "";
    check("two threads → two distinct tickets", Boolean(ticketA1) && Boolean(ticketA2) && ticketA1 !== ticketA2);
    check("thread ticket typed discord + keyed on the thread id", r1?.channelType === "discord" && r1?.externalChannelId === "disctest-thread-a1");
  }

  // 3 — two DIFFERENT authors in ONE thread → ONE ticket, two distinct external authors
  {
    const r1 = await handleInboundMessage(thread({ threadId: "disctest-thread-multi", authorId: "cust-x", authorDisplayName: "Xander", discordMessageId: "disctest-m1", content: "DISCTEST from x" }));
    const r2 = await handleInboundMessage(thread({ threadId: "disctest-thread-multi", authorId: "cust-y", authorDisplayName: "Yara", discordMessageId: "disctest-m2", content: "DISCTEST from y" }));
    check("two authors, one thread → one ticket", r1?.ticketId === r2?.ticketId && Boolean(r1?.ticketId));
    await withTenant(A, async (c) => {
      const m = await c.query(
        "SELECT author_external_name FROM messages WHERE ticket_id = $1 AND body LIKE 'DISCTEST%' ORDER BY created_at ASC",
        [r1!.ticketId],
      );
      const names = m.rows.map((x) => x.author_external_name as string);
      check("both external authors captured distinctly", names.includes("Xander") && names.includes("Yara"));
    });
  }

  // 4 — a thread whose parent is UNBOUND (guild is in allow-list mode) → no ticket
  {
    const r = await handleInboundMessage(thread({ parentId: PARENT_UNBOUND, threadId: "disctest-thread-unbound", authorId: "cust-z", discordMessageId: "disctest-ub-1", content: "DISCTEST general chatter" }));
    check("unbound-parent message → no ticket (scoping)", r === null);
  }

  // 5 — content union: attachment-only, embed-only, forum-title-only each still create a ticket
  {
    const att = await handleInboundMessage(thread({ threadId: "disctest-thread-att", authorId: "cust-a", discordMessageId: "disctest-att-1", content: "", attachments: [{ url: "disctest-cdn/pic.png", filename: "pic.png", contentType: "image/png", size: 1234 }] }));
    check("attachment-only message → ticket created", att !== null && !att.replay);
    const emb = await handleInboundMessage(thread({ threadId: "disctest-thread-emb", authorId: "cust-b", discordMessageId: "disctest-emb-1", content: "", embeds: [{ title: "DISCTEST embed title", description: null, url: null }] }));
    check("embed-only message → ticket created", emb !== null);
    const forum = await handleInboundMessage(thread({ threadId: "disctest-thread-forum", authorId: "cust-c", discordMessageId: "disctest-forum-1", content: "", threadKind: "forum_post", threadName: "DISCTEST forum starter", parentId: PARENT_BOUND }));
    check("forum-title-only starter → ticket created", forum !== null);
  }

  // 6 — handleThreadCreate seats the owner on a pre-created ticket
  {
    const r = await handleThreadCreate({
      guildId: GUILD_A, threadId: "disctest-thread-seed", parentId: PARENT_BOUND, ownerId: "owner-1",
      name: "DISCTEST seeded thread", kind: "forum_post", ownerDisplayName: "Owner One",
    });
    check("handleThreadCreate seats a ticket", r !== null);
    await withTenant(A, async (c) => {
      const m = await c.query(
        "SELECT author_external_name FROM messages WHERE ticket_id = $1 LIMIT 1",
        [r!.ticketId],
      );
      check("seated message carries the owner identity", m.rows[0]?.author_external_name === "Owner One");
    });
  }

  // 7 — MessageUpdate edits in place (no new row); retarget-gate keeps whose_turn='us'
  {
    const r = await handleInboundMessage(thread({ threadId: "disctest-thread-edit", authorId: "cust-e", discordMessageId: "disctest-edit-1", content: "DISCTEST original" }));
    const before = r!.messageId;
    const ok = await handleMessageUpdate({ guildId: GUILD_A, messageId: "disctest-edit-1", newContent: "DISCTEST edited body" });
    check("handleMessageUpdate returns true", ok === true);
    await withTenant(A, async (c) => {
      const m = await c.query("SELECT id, body FROM messages WHERE idempotency_key = 'discord:disctest-edit-1'");
      check("edit updates the SAME row in place", m.rowCount === 1 && m.rows[0].id === before && m.rows[0].body === "DISCTEST edited body");
      const t = await c.query("SELECT whose_turn FROM tickets WHERE id = $1", [r!.ticketId]);
      check("Discord customer reply → whose_turn='us' (retarget-gate kept)", t.rows[0].whose_turn === "us");
    });
  }

  // 8 — MessageDelete tombstones + closes a sole-customer-message ticket
  {
    const r = await handleInboundMessage(thread({ threadId: "disctest-thread-del", authorId: "cust-d", discordMessageId: "disctest-del-1", content: "DISCTEST to be deleted" }));
    const ok = await handleMessageDelete({ guildId: GUILD_A, messageId: "disctest-del-1" });
    check("handleMessageDelete returns true", ok === true);
    await withTenant(A, async (c) => {
      const m = await c.query("SELECT deleted_at FROM messages WHERE idempotency_key = 'discord:disctest-del-1'");
      check("deleted message is soft-tombstoned (row kept)", m.rowCount === 1 && m.rows[0].deleted_at !== null);
      const t = await c.query("SELECT status FROM tickets WHERE id = $1", [r!.ticketId]);
      check("sole-message delete closes the ticket", t.rows[0].status === "closed");
    });
  }

  // 9 — redelivery of the same discord message id dedupes
  {
    const r = await handleInboundMessage(thread({ threadId: "disctest-thread-a1", authorId: "cust-same", discordMessageId: "disctest-a1", content: "DISCTEST thread one" }));
    check("replayed discord message id → replay=true", r?.replay === true);
  }

  // 10 — cross-tenant isolation holds
  {
    await relayPool.query(
      "INSERT INTO discord_channel_bindings (guild_id, channel_id, tenant_id, mode) VALUES ($1,$2,$3,'staffed') ON CONFLICT DO NOTHING",
      [GUILD_B, "disctest-parent-b", B],
    );
    const r = await handleInboundMessage(thread({ guildId: GUILD_B, parentId: "disctest-parent-b", threadId: "disctest-thread-b", authorId: "gcust", discordMessageId: "disctest-b-1", content: "DISCTEST globex only" }));
    check("globex guild resolves + ingests", r !== null && r?.channelType === "discord");
    await withTenant(A, async (c) => {
      const t = await c.query("SELECT count(*)::int AS n FROM tickets WHERE external_thread_id = 'disctest-thread-b'");
      check("Acme cannot see Globex's discord thread-ticket (isolation)", t.rows[0].n === 0);
    });
  }

  // 11 — arbitration primitive: exactly one claimant wins a turn
  {
    const mid = "00000000-0000-0000-0000-0000000000aa";
    await superPool.query("DELETE FROM answer_claims WHERE message_id = $1", [mid]); // super: app_user has no DELETE on answer_claims (prune is event_relay's job)
    const first = await claimAnswer(A, mid, "autoreply");
    const second = await claimAnswer(A, mid, "automations");
    check("first claimant wins the turn", first === true);
    check("second claimant stands down (already claimed)", second === false);
    await superPool.query("DELETE FROM answer_claims WHERE message_id = $1", [mid]); // super: app_user has no DELETE on answer_claims (prune is event_relay's job)
  }

  // 12 — outbound routing seam is unchanged (mock sender)
  {
    const cap: { channelId: string; content: string }[] = [];
    const send = async (channelId: string, content: string) => { cap.push({ channelId, content }); };
    const okd = await routeOutbound({ channelType: "discord", externalChannelId: "disctest-thread-a1" }, "DISCTEST agent reply", send);
    check("routeOutbound delivers to the thread channel", okd.delivered === true && cap.length === 1 && cap[0].channelId === "disctest-thread-a1");
    const nond = await routeOutbound({ channelType: "synthetic", externalChannelId: null }, "hi", send);
    check("routeOutbound no-ops for non-discord", nond.delivered === false && cap.length === 1);
    const disc = await routeOutbound({ channelType: "discord", externalChannelId: "disctest-thread-a1" }, "hi", null);
    check("routeOutbound reports disconnected when the gateway is off", disc.delivered === false && disc.reason === "discord-disconnected");
  }

  // ── Phase 2 — identity classification ──────────────────────────────────────
  const TEAM_ROLE = "disctest-role-team";
  const RESP_ROLE = "disctest-role-resp";
  const IGN_ROLE = "disctest-role-ignore";
  await setDiscordClassification(GUILD_A, A, {
    teamRoleIds: [TEAM_ROLE],
    responderRoleIds: [RESP_ROLE],
    ignoreRoleIds: [IGN_ROLE],
  });

  // 13 — a community responder (responder role) → author_kind 'community', NO phantom contact, AI
  //      stands down (whose_turn flips to 'customer'); still a first-class message identity.
  {
    const r = await handleInboundMessage(thread({
      threadId: "disctest-thread-comm", authorId: "mod-1", authorDisplayName: "ModMona",
      discordMessageId: "disctest-comm-1", content: "DISCTEST mod answer", roleIds: [RESP_ROLE],
    }));
    check("community responder → ingested (not dropped)", r !== null);
    await withTenant(A, async (c) => {
      const m = await c.query(
        "SELECT author_type, author_kind, author_contact_id, author_external_name FROM messages WHERE idempotency_key = 'discord:disctest-comm-1'",
      );
      check("community message is author_kind='community'", m.rows[0]?.author_kind === "community");
      check("community message is author_type='agent' (an answer)", m.rows[0]?.author_type === "agent");
      check("community responder mints NO phantom contact", m.rows[0]?.author_contact_id === null);
      check("community responder kept as a message-level identity", m.rows[0]?.author_external_name === "ModMona");
      const t = await c.query("SELECT whose_turn, contact_id FROM tickets WHERE external_thread_id = 'disctest-thread-comm'");
      check("community answer stands the AI down (whose_turn='customer')", t.rows[0]?.whose_turn === "customer");
      check("mod-first community thread ticket has no customer contact", t.rows[0]?.contact_id === null);
    });
  }

  // 14 — a team-role member (no registered seat) → author_type 'agent'/author_kind 'agent', no seat id.
  {
    const r = await handleInboundMessage(thread({
      threadId: "disctest-thread-team", authorId: "staff-noseat", authorDisplayName: "StaffSam",
      discordMessageId: "disctest-team-1", content: "DISCTEST team reply", roleIds: [TEAM_ROLE],
    }));
    check("team-role member → ingested as agent", r !== null);
    await withTenant(A, async (c) => {
      const m = await c.query("SELECT author_kind, author_id, author_contact_id FROM messages WHERE idempotency_key = 'discord:disctest-team-1'");
      check("team-role message is author_kind='agent'", m.rows[0]?.author_kind === "agent");
      check("team-role member with no seat has null author_id", m.rows[0]?.author_id === null);
      check("team-role member mints no phantom contact", m.rows[0]?.author_contact_id === null);
    });
  }

  // 15 — an ignore-role author is dropped entirely.
  {
    const r = await handleInboundMessage(thread({
      threadId: "disctest-thread-ign", authorId: "botlike", discordMessageId: "disctest-ign-1",
      content: "DISCTEST noise", roleIds: [IGN_ROLE],
    }));
    check("ignore-role author → dropped (null)", r === null);
  }

  // 16 — explicit teammate mark (agent_channel_identities) resolves the Noola seat, and OUTRANKS a
  //      role (precedence explicit-mark > role): even carrying the responder role, they stay a seated agent.
  {
    const u = await superPool.query("SELECT id FROM users WHERE tenant_id = $1 LIMIT 1", [A]);
    const seatId = u.rows[0]?.id as string | undefined;
    check("a Noola user exists to seat the teammate", Boolean(seatId));
    if (seatId) {
      await upsertAgentChannelIdentity(A, seatId, "disctest-teammate-1");
      const r = await handleInboundMessage(thread({
        threadId: "disctest-thread-seat", authorId: "disctest-teammate-1", authorDisplayName: "SeatedSue",
        discordMessageId: "disctest-seat-1", content: "DISCTEST seated reply", roleIds: [RESP_ROLE],
      }));
      check("registered teammate → ingested as agent", r !== null);
      await withTenant(A, async (c) => {
        const m = await c.query("SELECT author_kind, author_id FROM messages WHERE idempotency_key = 'discord:disctest-seat-1'");
        check("teammate mark resolves the Noola seat (author_id set)", m.rows[0]?.author_id === seatId);
        check("explicit mark outranks the responder role (author_kind='agent')", m.rows[0]?.author_kind === "agent");
      });
    }
  }

  // 17 — classifier unit: default (no roles) → customer/seeker; unconfigured guild → customer.
  {
    const seeker = await classifyDiscordAuthor({ tenantId: A, guildId: GUILD_A, authorId: "rando", roleIds: [] });
    check("no-role author classifies as a customer/seeker", seeker.authorType === "customer" && seeker.authorKind === "customer");
    const resp = await classifyDiscordAuthor({ tenantId: A, guildId: GUILD_A, authorId: "mod-2", roleIds: [RESP_ROLE] });
    check("responder role classifies as community", resp.authorKind === "community" && resp.authorType === "agent");
  }

  // ── Phase 3 — operating modes (staffed / community) ────────────────────────────────────────
  // Flipping a binding to mode='community' turns on the community contract: the thread is still
  // ingested (record + KB + analytics) with support_mode='community' frozen at create, but it is
  // NOT agent work (excluded from the needs-reply queue) and the AI "deflects once" (§5.1/§5.5).
  await relayPool.query(
    "INSERT INTO discord_channel_bindings (guild_id, channel_id, tenant_id, mode) VALUES ($1,$2,$3,'community') ON CONFLICT DO NOTHING",
    [GUILD_A, PARENT_COMMUNITY, A],
  );

  // 18 — community activation: a community-bound channel is INGESTED (not dropped, as in Phase 1),
  //      the ticket freezes support_mode='community', and whose_turn stays 'us' (deflect-eligible).
  let commTicketId: string | null = null;
  {
    const comm = await handleInboundMessage(thread({
      parentId: PARENT_COMMUNITY, threadId: "disctest-thread-commmode", authorId: "seeker-c",
      discordMessageId: "disctest-commmode-1", content: "DISCTEST community question", skipAutoreply: true,
    }));
    check("community-bound channel → still ingested (Phase 3, not dropped)", comm !== null);
    commTicketId = comm?.ticketId ?? null;
    await withTenant(A, async (c) => {
      const t = await c.query("SELECT support_mode, whose_turn FROM tickets WHERE external_thread_id = 'disctest-thread-commmode'");
      check("community thread freezes support_mode='community'", t.rows[0]?.support_mode === "community");
      check("community thread keeps whose_turn='us' (deflect-eligible, §5.1)", t.rows[0]?.whose_turn === "us");
    });
  }

  // 19 — read-site sweep: a staffed thread shows in the needs-reply queue; a community thread does NOT.
  {
    const staffed = await handleInboundMessage(thread({
      threadId: "disctest-thread-staffnr", authorId: "seeker-s",
      discordMessageId: "disctest-staffnr-1", content: "DISCTEST staffed needs-reply", skipAutoreply: true,
    }));
    const rows = await listTickets(A, "needs_reply");
    const ids = rows.map((r) => r.id);
    check("staffed thread appears in the needs-reply queue", staffed !== null && ids.includes(staffed!.ticketId));
    check("community thread EXCLUDED from the needs-reply queue (read-site sweep)", commTicketId !== null && !ids.includes(commTicketId));
  }

  // 20 — deflect once (§5.5): on tenant B, a community thread auto-answers AT MOST once — the second
  //      customer turn is capped even though max_auto_per_thread is 3; a staffed control still answers
  //      the second turn (the clamp is community-specific). Uses real retrieval (KB-corroborated).
  {
    await ensureChunksCollection();
    await ensureKbCollection();
    await relayPool.query(
      "INSERT INTO discord_channel_bindings (guild_id, channel_id, tenant_id, mode) VALUES ($1,$2,$3,'community'),($1,$4,$3,'staffed') ON CONFLICT DO NOTHING",
      [GUILD_B, PARENT_B_COMM, B, PARENT_B_STAFF],
    );
    await createArticle(B, "DISCTEST Widgets guide", `The ${MARK} dashboard widget shows recent activity; drag its corner to resize and the layout saves per user.`);
    // auto mode, discord channel auto, configured thread cap 3 → only the community clamp limits to 1.
    await putPolicy(B, {
      mode: "auto", channel_modes: { discord: "auto", synthetic: "auto" },
      min_agreement: 1, min_top_score: 0, min_confidence: null, max_auto_per_thread: 3, kill_switch: false,
    }, { sweep: false });

    const strong = `DISCTEST how do I set up the ${MARK} dashboard widget on my home screen?`;
    const bComm = (dm: string, tid: string) => thread({
      guildId: GUILD_B, parentId: PARENT_B_COMM, threadId: tid, authorId: "seeker-bc",
      discordMessageId: dm, content: strong, skipAutoreply: true,
    });
    // Ingest turn 1 (skipAutoreply → no hook race), then warm retrieval before evaluating.
    const c1 = await handleInboundMessage(bComm("disctest-deflect-1", "disctest-thread-bdeflect"));
    let agreement = 0;
    for (let i = 0; i < 25 && c1; i++) {
      const s = await suggestReply(B, c1.ticketId);
      agreement = s.retrieval.agreement;
      if (agreement >= 1 && s.citations.length >= 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check("deflect-once: retrieval corroborates the seeded KB (agreement >= 1)", agreement >= 1);
    const first = c1 ? await evaluateAutoreply(B, c1.ticketId, c1.messageId) : null;
    check("deflect-once: first community turn auto-sends", first?.outcome === "auto_sent");
    // Turn 2 in the SAME community thread → the community clamp (effective cap 1) suppresses it.
    const c2 = await handleInboundMessage(bComm("disctest-deflect-2", "disctest-thread-bdeflect"));
    const second = c2 ? await evaluateAutoreply(B, c2.ticketId, c2.messageId) : null;
    check("deflect-once: second community turn suppressed by the thread cap", second?.outcome === "suppressed");
    check("deflect-once: suppression reason is thread_cap (clamped to 1)", second?.reason === "thread_cap");

    // Staffed control: same policy (cap 3), a second turn is NOT capped at 1 → the clamp is community-only.
    const bStaff = (dm: string) => thread({
      guildId: GUILD_B, parentId: PARENT_B_STAFF, threadId: "disctest-thread-bstaff", authorId: "seeker-bs",
      discordMessageId: dm, content: strong, skipAutoreply: true,
    });
    const s1 = await handleInboundMessage(bStaff("disctest-staff-1"));
    const sr1 = s1 ? await evaluateAutoreply(B, s1.ticketId, s1.messageId) : null;
    check("staffed control: first turn auto-sends", sr1?.outcome === "auto_sent");
    const s2 = await handleInboundMessage(bStaff("disctest-staff-2"));
    const sr2 = s2 ? await evaluateAutoreply(B, s2.ticketId, s2.messageId) : null;
    check("staffed control: second turn is NOT capped at 1 (community clamp is mode-specific)", sr2?.reason !== "thread_cap");
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nDISCORD PHASE 1-3: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nDISCORD PHASE 1-3: all checks green");
}

main().catch((e) => {
  console.error("discord test ERROR", e);
  process.exit(1);
});
