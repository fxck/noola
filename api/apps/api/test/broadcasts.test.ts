import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { createContact } from "../src/contacts.js";
import {
  previewSegment,
  createBroadcast,
  getBroadcast,
  listBroadcasts,
  sendBroadcast,
  InvalidChannelError,
  MissingTargetError,
  type BroadcastSendFn,
  type BroadcastDispatchFn,
} from "../src/broadcasts.js";

// Broadcast seam gate: segment preview counts (matches + per-channel reachable handles),
// draft creation (channel-aware, invalid channel rejected), the async mass-send over an
// INJECTED (network-free) email seam — deduped by lowercased handle, per-recipient
// delivery logging, counters + status, a failing send recording 'failed', an empty
// segment sending nothing — a chat-channel send over an injected dispatch seam resolving
// recipients from contact_identities, and tenant isolation. Postgres only.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

/** A network-free send stub that records every call and fails for a chosen email set. */
function stub(failFor: Set<string> = new Set()): {
  send: BroadcastSendFn;
  calls: { to: string; subject: string; body: string }[];
} {
  const calls: { to: string; subject: string; body: string }[] = [];
  const send: BroadcastSendFn = async (_tenantId, to, subject, body) => {
    calls.push({ to, subject, body });
    if (failFor.has(to.toLowerCase())) return { delivered: false, reason: "stub-fail" };
    return { delivered: true };
  };
  return { send, calls };
}

/** A network-free DISPATCH stub for the chat channels — records the OutboundContext per
 *  call and fails for a chosen handle set. */
function dispatchStub(failFor: Set<string> = new Set()): {
  dispatch: BroadcastDispatchFn;
  calls: { channelType: string; externalChannelId: string | null; subject: string; body: string; mentionRoleId?: string | null; asEmbed?: boolean }[];
} {
  const calls: { channelType: string; externalChannelId: string | null; subject: string; body: string; mentionRoleId?: string | null; asEmbed?: boolean }[] = [];
  const dispatch: BroadcastDispatchFn = async (ctx, body, opts) => {
    calls.push({ channelType: ctx.channelType, externalChannelId: ctx.externalChannelId, subject: ctx.subject, body, mentionRoleId: opts?.mentionRoleId, asEmbed: opts?.asEmbed });
    if (ctx.externalChannelId && failFor.has(ctx.externalChannelId)) return { delivered: false, reason: "stub-fail" };
    return { delivered: true };
  };
  return { dispatch, calls };
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query(
      "DELETE FROM outbox WHERE event_type = 'noola.broadcast.updated' AND payload->'data'->>'broadcastId' IN (SELECT id::text FROM broadcasts WHERE subject LIKE 'BTEST%')",
    );
    await superPool.query("DELETE FROM broadcast_recipients WHERE broadcast_id IN (SELECT id FROM broadcasts WHERE subject LIKE 'BTEST%')");
    await superPool.query("DELETE FROM broadcasts WHERE subject LIKE 'BTEST%'");
    await superPool.query("DELETE FROM contacts WHERE company = 'BcastTestCo' OR email LIKE 'btest-%'");
  };
  await clean();

  // Seed a segment (company = BcastTestCo): 4 match, 3 have an email (one has none → can't
  // receive email). Contacts enforce a unique email per tenant, so a true duplicate email
  // can't be seeded here — resolveRecipients still dedups by lowercased handle defensively.
  const ann = await createContact(A, { email: "btest-a@x.test", name: "Ann", company: "BcastTestCo" });
  const bo = await createContact(A, { email: "btest-b@x.test", name: "Bo", company: "BcastTestCo" });
  const mute = await createContact(A, { name: "No Email", company: "BcastTestCo" }); // no email → cannot receive email
  const cy = await createContact(A, { email: "btest-c@x.test", name: "Cy", company: "BcastTestCo" }); // send fails for this one

  // Per-channel identities (0062): 3 telegram handles — including the EMAILLESS contact,
  // reachable by chat even though email can't touch them — and 1 whatsapp handle.
  const seedIdentity = (contactId: string, channel: string, handle: string) =>
    superPool.query(
      "INSERT INTO contact_identities (tenant_id, contact_id, channel_type, external_id) VALUES ($1, $2, $3, $4)",
      [A, contactId, channel, handle],
    );
  await seedIdentity(ann.id, "telegram", "tg-1001");
  await seedIdentity(mute.id, "telegram", "tg-1002");
  await seedIdentity(cy.id, "telegram", "tg-1003");
  await seedIdentity(bo.id, "whatsapp", "420111222333");

  const SEG = { company: "BcastTestCo" };

  // ---- previewSegment: per-channel reachable counts ----
  {
    const p = await previewSegment(A, SEG);
    check("previewSegment total counts all matches", p.total === 4);
    check("previewSegment reachable.email counts only emailed", p.reachable.email === 3);
    check("previewSegment reachable.telegram counts identity handles", p.reachable.telegram === 3);
    check("previewSegment reachable.whatsapp counts identity handles", p.reachable.whatsapp === 1);
    check("previewSegment channels without identities → 0", p.reachable.discord === 0 && p.reachable.slack === 0);
    const empty = await previewSegment(A, { company: "NoSuchCo" });
    check("previewSegment empty segment → 0 everywhere",
      empty.total === 0 && Object.values(empty.reachable).every((n) => n === 0));
  }

  // ---- createBroadcast (draft) ----
  const bc = await createBroadcast(A, { subject: "BTEST Launch", body: "Hello everyone", segment: SEG });
  check("createBroadcast → draft", bc.status === "draft");
  check("createBroadcast defaults channel to 'email'", bc.channel === "email");
  check("createBroadcast recipient_count = reachable.email", bc.recipient_count === 3);
  check("createBroadcast persists subject/body/segment", bc.subject === "BTEST Launch" && bc.body === "Hello everyone" && (bc.segment as any).company === "BcastTestCo");
  check("new broadcast has zero sent/failed", bc.sent_count === 0 && bc.failed_count === 0);

  // ---- createBroadcast rejects a non-dispatchable channel ----
  {
    let threw: unknown = null;
    try {
      await createBroadcast(A, { subject: "BTEST Bad", channel: "carrier-pigeon", segment: SEG });
    } catch (e) { threw = e; }
    check("createBroadcast invalid channel → InvalidChannelError", threw instanceof InvalidChannelError);
  }

  // ---- sendBroadcast over the injected stub (c@ fails) ----
  {
    const s = stub(new Set(["btest-c@x.test"]));
    const out = await sendBroadcast(A, bc.id, { send: s.send });
    check("sendBroadcast returns status 'sending' immediately", out?.status === "sending");
    await out?.done; // await the background send for deterministic assertions

    check("emailed exactly the 3 emailable recipients", s.calls.length === 3);
    const toSet = new Set(s.calls.map((c) => c.to.toLowerCase()));
    check("stubbed sends hit the emailable set (emailless contact excluded)",
      toSet.size === 3 && toSet.has("btest-a@x.test") && toSet.has("btest-b@x.test") && toSet.has("btest-c@x.test"));
    // The email body is the React Email plaintext render (branded frame) — it CONTAINS the
    // authored markdown body rather than equalling it.
    check("every send carried the subject + rendered body", s.calls.every((c) => c.subject === "BTEST Launch" && c.body.includes("Hello everyone")));

    const got = await getBroadcast(A, bc.id);
    check("after send status = 'sent' (some delivered)", got?.broadcast.status === "sent");
    check("recipient_count re-resolved to deduped 3", got?.broadcast.recipient_count === 3);
    check("counts: 2 sent, 1 failed", got?.broadcast.sent_count === 2 && got?.broadcast.failed_count === 1);
    check("sent_at stamped", Boolean(got?.broadcast.sent_at));
    check("3 recipient rows logged", got?.recipients.length === 3);
    const failedRow = got?.recipients.find((r) => r.handle === "btest-c@x.test");
    check("failed recipient logged as failed with an error", failedRow?.status === "failed" && failedRow?.error === "stub-fail");
    const okRows = got?.recipients.filter((r) => r.status === "sent") ?? [];
    check("delivered recipients logged as sent (no error)", okRows.length === 2 && okRows.every((r) => r.error === null));

    // outbox event emitted on the final status change
    const ob = await superPool.query(
      "SELECT count(*)::int AS n FROM outbox WHERE event_type = 'noola.broadcast.updated' AND payload->'data'->>'broadcastId' = $1 AND payload->'data'->>'status' = 'sent'",
      [bc.id],
    );
    check("outbox noola.broadcast.updated (sent) emitted", ob.rows[0].n >= 1);
  }

  // ---- chat-channel broadcast: telegram over the injected dispatch stub ----
  {
    const tg = await createBroadcast(A, { subject: "BTEST TG", body: "Hello chat", channel: "telegram", segment: SEG });
    check("telegram draft carries channel", tg.channel === "telegram");
    check("telegram recipient_count seeded from reachable.telegram", tg.recipient_count === 3);

    const d = dispatchStub(new Set(["tg-1003"])); // cy's handle fails
    const out = await sendBroadcast(A, tg.id, { dispatch: d.dispatch });
    check("telegram sendBroadcast returns 'sending' immediately", out?.status === "sending");
    await out?.done;

    check("dispatched exactly the 3 telegram identities", d.calls.length === 3);
    const handles = new Set(d.calls.map((c) => c.externalChannelId));
    check("dispatch targets are the contact_identities handles (emailless contact included)",
      handles.size === 3 && handles.has("tg-1001") && handles.has("tg-1002") && handles.has("tg-1003"));
    check("dispatch ctx carries channelType + subject",
      d.calls.every((c) => c.channelType === "telegram" && c.subject === "BTEST TG"));
    check("chat body folds the subject in as a bold lead",
      d.calls.every((c) => c.body === "**BTEST TG**\n\nHello chat"));

    const got = await getBroadcast(A, tg.id);
    check("telegram send → status 'sent' (some delivered)", got?.broadcast.status === "sent");
    check("telegram counts: 2 sent, 1 failed", got?.broadcast.sent_count === 2 && got?.broadcast.failed_count === 1);
    check("telegram recipient rows log handles verbatim", got?.recipients.length === 3 && got.recipients.every((r) => r.handle.startsWith("tg-")));
    const failedRow = got?.recipients.find((r) => r.handle === "tg-1003");
    check("failed dispatch logged as failed with an error", failedRow?.status === "failed" && failedRow?.error === "stub-fail");
  }

  // ---- Discord channel-post broadcast (0078): ONE post to a channel, not N DMs ----
  {
    const cp = await createBroadcast(A, {
      subject: "BTEST Announce",
      body: "New release is live!",
      channel: "discord",
      targetRef: "disc-chan-9001",
      mentionRoleId: "role-777",
      asEmbed: false,
    });
    check("channel-post: audience_kind is discord_channel", cp.audience_kind === "discord_channel");
    check("channel-post: channel forced to discord", cp.channel === "discord");
    check("channel-post: target_ref/mention/embed persisted", cp.target_ref === "disc-chan-9001" && cp.mention_role_id === "role-777" && cp.as_embed === false);
    check("channel-post: recipient_count is 1 (one post)", cp.recipient_count === 1);
    check("channel-post: pinned to oneshot", cp.mode === "oneshot");

    const d = dispatchStub();
    const out = await sendBroadcast(A, cp.id, { dispatch: d.dispatch });
    check("channel-post: send returns 'sending'", out?.status === "sending");
    await out?.done;
    check("channel-post: dispatched EXACTLY ONCE", d.calls.length === 1);
    check("channel-post: posted to the target channel id", d.calls[0]?.externalChannelId === "disc-chan-9001");
    check("channel-post: opts carry the role mention (allowedMentions-gated downstream)", d.calls[0]?.mentionRoleId === "role-777");
    check("channel-post: non-embed body leads with the bold subject", d.calls[0]?.body === "**BTEST Announce**\n\nNew release is live!");

    const got = await getBroadcast(A, cp.id);
    check("channel-post: status 'sent'", got?.broadcast.status === "sent");
    check("channel-post: 1 sent / 0 failed", got?.broadcast.sent_count === 1 && got?.broadcast.failed_count === 0);
    check("channel-post: single recipient row, null contact, handle = channel id",
      got?.recipients.length === 1 && got.recipients[0].contact_id === null && got.recipients[0].handle === "disc-chan-9001");
  }

  // ---- channel-post embed variant: subject is the title, NOT folded into the body ----
  {
    const cp = await createBroadcast(A, {
      subject: "BTEST Embed",
      body: "Body goes in the embed description.",
      audienceKind: "discord_channel",
      targetRef: "disc-chan-9002",
      asEmbed: true,
    });
    check("channel-post embed: as_embed persisted", cp.as_embed === true);
    const d = dispatchStub();
    await (await sendBroadcast(A, cp.id, { dispatch: d.dispatch }))?.done;
    check("channel-post embed: body is the raw text (subject is the title)", d.calls[0]?.body === "Body goes in the embed description.");
    check("channel-post embed: opts.asEmbed true", d.calls[0]?.asEmbed === true);
  }

  // ---- the retired DM path: a Discord broadcast MUST name a channel ----
  {
    let threw: unknown;
    try {
      await createBroadcast(A, { subject: "BTEST NoTarget", channel: "discord", body: "hi" });
    } catch (e) { threw = e; }
    check("channel-post: Discord broadcast without targetRef → MissingTargetError", threw instanceof MissingTargetError);

    let threw2: unknown;
    try {
      // Explicitly asking for the old per-recipient DM path on Discord is upgraded to channel-post,
      // which then requires a target — so the DM path can never be created.
      await createBroadcast(A, { subject: "BTEST DM", channel: "discord", audienceKind: "segment", segment: SEG });
    } catch (e) { threw2 = e; }
    check("channel-post: Discord + audienceKind 'segment' can't create a DM broadcast", threw2 instanceof MissingTargetError);
  }

  // ---- send guard: a non-draft broadcast is not re-sent ----
  {
    const s = stub();
    const again = await sendBroadcast(A, bc.id, { send: s.send });
    check("re-sending a 'sent' broadcast is guarded (status echoed, not 'sending')", again?.status === "sent");
    check("guarded re-send performs no sends", s.calls.length === 0);
  }

  // ---- all-fail send → status 'failed' ----
  {
    const failBc = await createBroadcast(A, { subject: "BTEST AllFail", segment: SEG });
    const s = stub(new Set(["btest-a@x.test", "btest-b@x.test", "btest-c@x.test"]));
    const out = await sendBroadcast(A, failBc.id, { send: s.send });
    await out?.done;
    const got = await getBroadcast(A, failBc.id);
    check("all-failed send → status 'failed'", got?.broadcast.status === "failed");
    check("all-failed counts: 0 sent, 3 failed", got?.broadcast.sent_count === 0 && got?.broadcast.failed_count === 3);
  }

  // ---- empty segment → sends nothing, status 'sent' ----
  {
    const emptyBc = await createBroadcast(A, { subject: "BTEST Empty", segment: { company: "NoSuchCo" } });
    check("empty-segment draft recipient_count = 0", emptyBc.recipient_count === 0);
    const s = stub();
    const out = await sendBroadcast(A, emptyBc.id, { send: s.send });
    await out?.done;
    check("empty segment performs no sends", s.calls.length === 0);
    const got = await getBroadcast(A, emptyBc.id);
    check("empty segment → status 'sent', 0 recipients", got?.broadcast.status === "sent" && got?.broadcast.recipient_count === 0 && got?.recipients.length === 0);
  }

  // ---- unsubscribe (0065): token round-trip, channel-agnostic suppression, per-recipient link ----
  {
    const { mintUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl, setSubscription } = await import(
      "../src/unsubscribe.js"
    );
    const tok = mintUnsubscribeToken(A, bo.id);
    check("unsubscribe token mints (signing secret configured)", typeof tok === "string" && tok.length > 20);
    const back = tok ? verifyUnsubscribeToken(tok) : null;
    check("unsubscribe token verifies back to its identity", back?.tenantId === A && back?.contactId === bo.id);
    check("tampered unsubscribe token rejected", verifyUnsubscribeToken(`${tok?.slice(0, -3)}xyz`) === null);

    // Opt bo out → email AND chat reach drop (an opt-out is an opt-out), raw total unchanged.
    await setSubscription(A, bo.id, true);
    const p = await previewSegment(A, SEG);
    check("unsubscribed excluded from reachable.email", p.reachable.email === 2);
    check("unsubscribed excluded from chat reach too (whatsapp)", p.reachable.whatsapp === 0);
    check("preview total still counts the unsubscribed contact", p.total === 4);

    // Suppressed at send; each delivered email carries the RECIPIENT'S OWN signed opt-out
    // link (asserted via the List-Unsubscribe seam — the plaintext body may wrap long URLs).
    const seen: { to: string; body: string; unsub?: string }[] = [];
    const send: BroadcastSendFn = async (_t, to, _s, body, opts) => {
      seen.push({ to, body, unsub: opts?.unsubscribeUrl });
      return { delivered: true };
    };
    const ub = await createBroadcast(A, { subject: "BTEST Unsub", body: "News", segment: SEG });
    const out = await sendBroadcast(A, ub.id, { send });
    await out?.done;
    check("suppressed at send: only the 2 subscribed emailed",
      seen.length === 2 && seen.every((c) => c.to !== "btest-b@x.test"));
    const annCall = seen.find((c) => c.to === "btest-a@x.test");
    check("send carries ann's own signed opt-out URL", Boolean(annCall?.unsub) && annCall?.unsub === unsubscribeUrl(A, ann.id));
    check("opt-out URLs are per-recipient (distinct)", new Set(seen.map((c) => c.unsub)).size === 2);
    check("rendered body carries the footer unsubscribe line", Boolean(annCall?.body.includes("Unsubscribe")));

    // Re-subscribe restores reach; re-clicking opt-out is idempotent on the timestamp.
    await setSubscription(A, bo.id, false);
    const p2 = await previewSegment(A, SEG);
    check("resubscribe restores reachable.email", p2.reachable.email === 3);
  }

  // ---- segment `conditions` — the Customers filter-builder AST, shared ----
  {
    const p = await previewSegment(A, { conditions: [{ field: "name", op: "is", value: "Ann" }] });
    check("conditions narrow the preview", p.total === 1 && p.reachable.email === 1);

    const pSub = await previewSegment(A, {
      company: "BcastTestCo",
      conditions: [{ field: "unsubscribed_at", op: "not_exists" }],
    });
    check("subscription-state condition compiles (not_exists = subscribed)", pSub.total === 4);

    const s = stub();
    const cb = await createBroadcast(A, {
      subject: "BTEST Cond",
      body: "Hi",
      segment: { company: "BcastTestCo", conditions: [{ field: "email", op: "ends_with", value: "@x.test" }] },
    });
    check("conditions feed the draft's seeded recipient_count", cb.recipient_count === 3);
    const out = await sendBroadcast(A, cb.id, { send: s.send });
    await out?.done;
    check("conditions apply at resolve time", s.calls.length === 3);

    const junk = await previewSegment(A, { company: "BcastTestCo", conditions: "not-an-array" });
    check("malformed conditions ignored, flat fields still apply", junk.total === 4);
  }

  // ---- email templates (0066): built-ins, custom tokens reach the rendered send ----
  {
    const {
      listTemplates, createTemplate, deleteTemplate, resolveTemplateTokens, isBuiltinTemplate,
    } = await import("../src/email-templates.js");
    const { InvalidTemplateError } = await import("../src/broadcasts.js");

    const all = await listTemplates(A);
    check("built-ins listed first (branded, personal)",
      all[0]?.id === "branded" && all[0]?.builtin === true && all[1]?.id === "personal");
    check("isBuiltinTemplate knows the slugs", isBuiltinTemplate("branded") && !isBuiltinTemplate("acme"));

    const custom = await createTemplate(A, {
      name: "BTEST Acme brand",
      tokens: { wordmark: "AcmeCo", linkColor: "#2563eb", bodyBackground: "#eef2ff" },
    });
    check("custom template created", Boolean(custom.id) && custom.name === "BTEST Acme brand");
    const resolved = await resolveTemplateTokens(A, custom.id);
    check("custom tokens merge over branded defaults",
      resolved.linkColor === "#2563eb" && resolved.wordmark === "AcmeCo" && resolved.cardBackground === "#ffffff");
    const stale = await resolveTemplateTokens(A, "00000000-0000-0000-0000-000000000000");
    check("unknown template id degrades to branded", stale.linkColor === "#e8a33d");

    // A broadcast on the custom template: the rendered HTML the send seam receives carries
    // the custom tokens (this is the designer→send guarantee).
    let threw: unknown = null;
    try {
      await createBroadcast(A, { subject: "BTEST BadTpl", segment: SEG, templateId: "nope" });
    } catch (e) { threw = e; }
    check("createBroadcast rejects an unknown templateId", threw instanceof InvalidTemplateError);

    const tb = await createBroadcast(A, {
      subject: "BTEST Templated", body: "Styled hello", segment: SEG, templateId: custom.id,
    });
    check("broadcast row carries template_id", tb.template_id === custom.id);
    const seen: { html?: string; text: string }[] = [];
    const send: BroadcastSendFn = async (_t, _to, _s, body, opts) => {
      seen.push({ html: opts?.html, text: body });
      return { delivered: true };
    };
    const out = await sendBroadcast(A, tb.id, { send });
    await out?.done;
    check("templated send rendered with the custom tokens",
      seen.length === 3 && seen.every((c) => c.html?.includes("#2563eb") && c.html?.includes("AcmeCo")));
    check("plaintext render carries the custom wordmark too", seen.every((c) => c.text.includes("AcmeCo")));

    // Tenant isolation: B can't resolve A's template (degrades to branded), and B's list has
    // only the built-ins.
    const bResolved = await resolveTemplateTokens(B, custom.id);
    check("B resolving A's template id degrades to branded", bResolved.linkColor === "#e8a33d");
    check("B's template list is built-ins only", (await listTemplates(B)).every((t) => t.builtin));

    await deleteTemplate(A, custom.id);
    check("deleted template gone from the list", (await listTemplates(A)).every((t) => t.id !== custom.id));
  }

  // ---- block composer (0067) + merge tags: per-recipient personalization ----
  {
    const { applyMergeTags, hasMergeTags } = await import("../src/merge-tags.js");
    const { mdFromBlocks } = await import("../src/broadcasts.js");

    // Pure merge-tag semantics.
    const d = { name: "Ann Zephyr", email: "a@x.test", company: "Acme", attributes: { plan: "pro" } };
    check("merge: {{name}} substitutes", applyMergeTags("Hi {{name}}!", d) === "Hi Ann Zephyr!");
    check("merge: {{firstName}} derives from name", applyMergeTags("Hi {{firstName}}", d) === "Hi Ann");
    check("merge: fallback used when value missing",
      applyMergeTags("Hi {{firstName|there}}", { name: "" }) === "Hi there");
    check("merge: missing value + no fallback → empty (never leaks braces)",
      applyMergeTags("Hi {{firstName}}", {}) === "Hi ");
    check("merge: attr lookup with fallback",
      applyMergeTags("Plan: {{attr:plan|free}} / {{attr:seats|1}}", d) === "Plan: pro / 1");
    check("merge: html variant escapes values",
      applyMergeTags("{{name}}", { name: "<b>x&y</b>" }, { html: true }) === "&lt;b&gt;x&amp;y&lt;/b&gt;");
    check("merge: hasMergeTags detects", hasMergeTags("a {{email}} b") && !hasMergeTags("plain {no} text"));

    // Chat/plain derivation from blocks.
    const blocks = [
      { type: "text" as const, md: "Hello {{firstName|there}}, big news." },
      { type: "image" as const, url: "https://x.test/pic.png", alt: "The launch" },
      { type: "button" as const, label: "Read more", url: "https://x.test/post", align: "center" as const },
      { type: "divider" as const },
      { type: "spacer" as const, height: 32 },
      { type: "html" as const, html: "<table><tr><td>raw</td></tr></table>" },
    ];
    const derived = mdFromBlocks(blocks);
    check("mdFromBlocks: text + image + button + divider, no spacer/html",
      derived.includes("Hello {{firstName|there}}") && derived.includes("The launch: https://x.test/pic.png") &&
      derived.includes("**Read more**: https://x.test/post") && derived.includes("---") && !derived.includes("<table>"));

    // A block broadcast end-to-end over the injected seam: per-recipient personalization in
    // subject + body, block markup in the html, unsub link still present.
    const bb = await createBroadcast(A, {
      subject: "BTEST Hi {{firstName|friend}}",
      channel: "email",
      segment: SEG,
      blocks,
    });
    check("block broadcast stores blocks + derived body", Array.isArray(bb.blocks) && bb.blocks.length === 6 && bb.body.includes("**Read more**"));
    const seen: { to: string; subject: string; text: string; html?: string }[] = [];
    const send: BroadcastSendFn = async (_t, to, subject, text, opts) => {
      seen.push({ to, subject, text, html: opts?.html });
      return { delivered: true };
    };
    const out = await sendBroadcast(A, bb.id, { send });
    await out?.done;
    check("block send reached the 3 emailable recipients", seen.length === 3);
    const ann2 = seen.find((c) => c.to === "btest-a@x.test");
    const noName = seen.every((c) => !c.subject.includes("{{") && !c.text.includes("{{") && !(c.html ?? "").includes("{{"));
    check("no merge braces leak to any recipient", noName);
    check("subject personalized per recipient", ann2?.subject === "BTEST Hi Ann");
    check("html carries the button + image + raw html blocks",
      Boolean(ann2?.html?.includes("Read more") && ann2?.html?.includes("https://x.test/pic.png") && ann2?.html?.includes("<table>")));
    check("html personalized (Hello Ann)", Boolean(ann2?.html?.includes("Hello Ann")));
    check("unsub link still present on block sends", Boolean(ann2?.html?.includes("/u/")));
    const bo2 = seen.find((c) => c.to === "btest-b@x.test");
    check("different recipient gets their own first name", bo2?.subject === "BTEST Hi Bo");
  }

  // ---- scheduling (0068): scheduled fire, continuous first-match, stop/cancel ----
  {
    const { runBroadcastScheduler } = await import("../src/broadcast-scheduler.js");
    const { runContinuousTick, cancelBroadcast } = await import("../src/broadcasts.js");

    // Scheduled: arm with a future send_at, scheduler ignores it until due, then fires.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const sched = await createBroadcast(A, { subject: "BTEST Sched", body: "Later", segment: SEG, sendAt: future });
    check("draft stores send_at + oneshot mode", sched.mode === "oneshot" && Boolean(sched.send_at));
    let s = stub();
    let out = await sendBroadcast(A, sched.id, { send: s.send });
    check("send on a future-dated draft arms it (scheduled, nothing sent)",
      out?.status === "scheduled" && s.calls.length === 0);
    await runBroadcastScheduler(undefined, { send: s.send });
    check("scheduler skips a not-yet-due broadcast", s.calls.length === 0);
    await superPool.query("UPDATE broadcasts SET send_at = now() - interval '1 minute' WHERE id = $1", [sched.id]);
    await runBroadcastScheduler(undefined, { send: s.send });
    check("scheduler fires the due broadcast to the full audience", s.calls.length === 3);
    check("fired broadcast lands terminal 'sent'", (await getBroadcast(A, sched.id))?.broadcast.status === "sent");

    // Scheduled → cancel → draft; re-send with past date → immediate.
    const sched2 = await createBroadcast(A, { subject: "BTEST Sched2", body: "x", segment: SEG, sendAt: future });
    await sendBroadcast(A, sched2.id);
    check("cancel returns a scheduled broadcast to draft", (await cancelBroadcast(A, sched2.id))?.status === "draft");
    s = stub();
    await superPool.query("UPDATE broadcasts SET send_at = NULL WHERE id = $1", [sched2.id]);
    out = await sendBroadcast(A, sched2.id, { send: s.send });
    await out?.done;
    check("canceled draft re-sends immediately once send_at cleared", s.calls.length === 3);

    // Continuous: starts 'active'; first tick reaches the current audience; a NEW matching
    // contact gets exactly one send on the next tick; already-sent contacts never repeat.
    const cont = await createBroadcast(A, {
      subject: "BTEST Cont", body: "Welcome!", segment: SEG, mode: "continuous",
    });
    check("continuous draft stores mode", cont.mode === "continuous");
    out = await sendBroadcast(A, cont.id);
    check("send on a continuous draft arms it (active)", out?.status === "active");
    s = stub();
    let tick = await runContinuousTick(A, cont.id, { send: s.send });
    await tick?.done;
    check("first tick sends to the whole current audience", tick?.sent === 3 && s.calls.length === 3);
    tick = await runContinuousTick(A, cont.id, { send: s.send });
    check("second tick is idle (everyone already got it)", tick?.sent === 0 && s.calls.length === 3);
    const late = await createContact(A, { email: "btest-late@x.test", name: "Late Joiner", company: "BcastTestCo" });
    tick = await runContinuousTick(A, cont.id, { send: s.send });
    await tick?.done;
    check("a first-time matcher gets exactly one send", tick?.sent === 1 && s.calls[3]?.to === "btest-late@x.test");
    check("continuous broadcast stays 'active' with cumulative counters", await (async () => {
      const g = await getBroadcast(A, cont.id);
      return g?.broadcast.status === "active" && g.broadcast.sent_count === 4 && g.broadcast.recipient_count === 4;
    })());

    // stop_at ends it; cancel stops an active one.
    await superPool.query("UPDATE broadcasts SET stop_at = now() - interval '1 second' WHERE id = $1", [cont.id]);
    tick = await runContinuousTick(A, cont.id, { send: s.send });
    check("tick past stop_at flips to 'stopped'", tick?.status === "stopped");
    const cont2 = await createBroadcast(A, { subject: "BTEST Cont2", segment: SEG, mode: "continuous" });
    await sendBroadcast(A, cont2.id);
    check("cancel stops an active continuous broadcast", (await cancelBroadcast(A, cont2.id))?.status === "stopped");
    check("stopped broadcast is not sendable again", (await sendBroadcast(A, cont2.id, { send: stub().send }))?.status === "stopped");
    await superPool.query("DELETE FROM contacts WHERE email = 'btest-late@x.test'");
  }

  // ---- tracking + goals (0069) + filter-grammar tail (events, OR groups) ----
  {
    const { mintTrackToken, verifyTrackToken, trackOpen, trackClick, appendUtm, instrumentHtml } = await import(
      "../src/tracking.js"
    );

    // Token round-trip; the click token binds its destination URL into the MAC.
    const tok = mintTrackToken(A, ann.id, "https://x.test/page");
    check("track token mints", typeof tok === "string" && tok!.length > 20);
    check("click token verifies WITH its url", verifyTrackToken(tok!, "https://x.test/page")?.tenantId === A);
    check("click token rejects a swapped url (no open redirect)",
      verifyTrackToken(tok!, "https://evil.test/") === null);

    // UTM: appended once, author's own utm_ params win.
    const u = appendUtm("https://x.test/a?b=1", "b-12345678");
    check("utm appended to plain urls",
      u.includes("utm_source=noola") && u.includes("utm_medium=email") && u.includes("utm_campaign=b-12345678") && u.includes("b=1"));
    check("existing utm params are left alone",
      appendUtm("https://x.test/a?utm_source=mine", "b-1") === "https://x.test/a?utm_source=mine");

    // instrumentHtml: wraps external links, skips the unsubscribe lane, appends the pixel.
    const sub = process.env.zeropsSubdomain;
    const base = sub
      ? (/^https?:\/\//.test(sub) ? sub : `https://${sub}`).replace(/\/+$/, "")
      : `http://localhost:${process.env.PORT ?? 3000}`;
    const html = `<body><a href="https://x.test/go">go</a> <a href="${base}/u/sometoken">unsub</a></body>`;
    const out = instrumentHtml(html, A, ann.id, "b-cafe0000");
    check("external link wrapped in /t/c with encoded destination",
      out.includes("/t/c/") && out.includes(encodeURIComponent("https://x.test/go?utm_source=noola")));
    check("unsubscribe link NOT wrapped", out.includes(`href="${base}/u/sometoken"`));
    check("open pixel appended before </body>", /img src="[^"]*\/t\/o\/[^"]+"[^>]*><\/body>/.test(out));

    // A real broadcast: the delivered html is instrumented; open/click write first-touch;
    // goal conversions count contact_events inside the window.
    const gb = await createBroadcast(A, {
      subject: "BTEST Track", body: "Visit [the site](https://x.test/promo).", segment: SEG,
      goalEvent: "btest_signup", goalDays: 7,
    });
    check("goal stored on the draft", gb.goal_event === "btest_signup" && gb.goal_days === 7);
    const seen: { to: string; html?: string }[] = [];
    const send: BroadcastSendFn = async (_t, to, _s, _b, opts) => {
      seen.push({ to, html: opts?.html });
      return { delivered: true };
    };
    const out2 = await sendBroadcast(A, gb.id, { send });
    await out2?.done;
    check("delivered html carries tracking (pixel + wrapped promo link)",
      seen.length === 3 && seen.every((c) => c.html?.includes("/t/o/") && c.html?.includes("/t/c/")));

    // Find ann's recipient row, simulate pixel + click + goal event.
    const got0 = await getBroadcast(A, gb.id);
    const annRow = got0?.recipients.find((r) => r.handle === "btest-a@x.test");
    const boRow = got0?.recipients.find((r) => r.handle === "btest-b@x.test");
    check("recipient rows expose opened_at/clicked_at (null before touches)",
      annRow?.opened_at === null && annRow?.clicked_at === null);
    await trackOpen(A, annRow!.id);
    await trackClick(A, boRow!.id); // click implies open
    await superPool.query(
      "INSERT INTO contact_events (tenant_id, contact_id, name) VALUES ($1, $2, 'btest_signup')",
      [A, bo.id],
    );
    await superPool.query( // outside the window → NOT a conversion
      "INSERT INTO contact_events (tenant_id, contact_id, name, created_at) VALUES ($1, $2, 'btest_signup', now() - interval '30 days')",
      [A, cy.id],
    );
    const got1 = await getBroadcast(A, gb.id);
    check("stats: delivered 3, opened 2 (click implies open), clicked 1",
      got1?.stats.delivered === 3 && got1?.stats.opened === 2 && got1?.stats.clicked === 1);
    check("goal conversions count only in-window events",
      got1?.stats.goal?.event === "btest_signup" && got1?.stats.goal?.conversions === 1);
    await superPool.query("DELETE FROM contact_events WHERE name = 'btest_signup'");

    // Filter-grammar tail: event conditions + OR groups.
    await superPool.query(
      "INSERT INTO contact_events (tenant_id, contact_id, name) VALUES ($1, $2, 'btest_login')",
      [A, ann.id],
    );
    const pEvent = await previewSegment(A, {
      company: "BcastTestCo",
      conditions: [{ field: "event:btest_login", op: "exists" }],
    });
    check("event: exists narrows to contacts who did it", pEvent.total === 1);
    const pNever = await previewSegment(A, {
      company: "BcastTestCo",
      conditions: [{ field: "event:btest_login", op: "not_exists" }],
    });
    check("event: not_exists = everyone else in segment", pNever.total === 3);
    const pOr = await previewSegment(A, {
      company: "BcastTestCo",
      conditionGroups: [
        [{ field: "name", op: "is", value: "Ann" }],
        [{ field: "name", op: "is", value: "Bo" }],
      ],
    });
    check("OR groups union across groups", pOr.total === 2);
    const pOrAnd = await previewSegment(A, {
      conditionGroups: [
        [{ field: "company", op: "is", value: "BcastTestCo" }, { field: "event:btest_login", op: "exists" }],
        [{ field: "name", op: "is", value: "No Email" }],
      ],
    });
    check("AND inside a group, OR across groups", pOrAnd.total === 2);
    await superPool.query("DELETE FROM contact_events WHERE name = 'btest_login'");
  }

  // ---- tenant isolation ----
  {
    check("A can list its own broadcast", (await listBroadcasts(A)).some((b) => b.id === bc.id));
    check("B cannot getBroadcast A's row", (await getBroadcast(B, bc.id)) === null);
    check("B's list never sees A's broadcasts", (await listBroadcasts(B)).every((b) => b.subject !== "BTEST Launch"));
    check("B sending A's broadcast id → not found (null)", (await sendBroadcast(B, bc.id, { send: stub().send })) === null);
    // B's segment resolution never pulls A's contacts.
    const bPreview = await previewSegment(B, SEG);
    check("B's preview of the same segment sees none of A's contacts",
      bPreview.total === 0 && Object.values(bPreview.reachable).every((n) => n === 0));
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nBROADCASTS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nBROADCASTS: all checks green");
}

main().catch((e) => { console.error("broadcasts seam ERROR", e); process.exit(1); });
