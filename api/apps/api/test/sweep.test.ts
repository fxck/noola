import { withTenant } from "@repo/db";
import { resolveAssignee, updateUserRouting, clearExpiredOoo } from "../src/assignments.js";
import { createBroadcast, updateBroadcast, inSendWindow, NotDraftError, sendBroadcast } from "../src/broadcasts.js";
import { createTemplate, updateTemplate, deleteTemplate, getReplyTemplateTokens, listTemplates } from "../src/email-templates.js";
import { renderReplyEmail } from "../src/emails/reply-email.js";

// Deferred-tails sweep (0072): OOO auto-expiry (eligibility + read-repair), broadcast send
// window (inSendWindow math + draft PATCH), reply-template flag (single per tenant, PERSONAL
// merge, frame render). Needs Postgres; re-runnable; demo tenant.

const A = "33333333-3333-3333-3333-333333333333";
const ALES = "c0000000-0000-0000-0000-000000000001";
const SAM = "c0000000-0000-0000-0000-000000000002";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function cleanup() {
  await withTenant(A, async (c) => {
    await c.query("DELETE FROM broadcasts WHERE subject LIKE 'sweep:%'");
    await c.query("DELETE FROM email_templates WHERE name LIKE 'Sweep %'");
    await c.query("UPDATE users SET skills='{}', out_of_office=false, ooo_until=NULL, max_open_tickets=NULL WHERE id = ANY($1::uuid[])", [[ALES, SAM]]);
  });
}

async function main() {
  await cleanup();

  // ── OOO auto-expiry ─────────────────────────────────────────────────────────
  const past = new Date(Date.now() - 3600_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  await updateUserRouting(A, ALES, { outOfOffice: true, oooUntil: past });
  const pickExpired = await withTenant(A, (c) =>
    resolveAssignee(c, { strategy: "round_robin", assigneeIds: [ALES], cursorKey: "sweep-ooo1" }),
  );
  check("expired OOO is eligible again (no repair needed)", pickExpired === ALES);
  await withTenant(A, async (c) => {
    await clearExpiredOoo(c);
    const r = await c.query("SELECT out_of_office, ooo_until FROM users WHERE id = $1", [ALES]);
    check("read-repair clears the expired flag", r.rows[0].out_of_office === false && r.rows[0].ooo_until === null);
  });
  await updateUserRouting(A, ALES, { outOfOffice: true, oooUntil: future });
  const pickActive = await withTenant(A, (c) =>
    resolveAssignee(c, { strategy: "round_robin", assigneeIds: [ALES], cursorKey: "sweep-ooo2" }),
  );
  check("future-dated OOO still excluded", pickActive === null);
  const backOn = await updateUserRouting(A, ALES, { outOfOffice: false });
  check("turning OOO off clears ooo_until", backOn?.ooo_until === null);

  // ── send window math ────────────────────────────────────────────────────────
  // Wed 2026-07-15 12:00 UTC
  const wedNoon = new Date("2026-07-15T12:00:00Z");
  const win = (d: Partial<Parameters<typeof inSendWindow>[0]>) => ({
    window_days: null, window_start_min: null, window_end_min: null, window_tz_offset_min: null, ...d,
  });
  check("no window → always in", inSendWindow(win({}), wedNoon));
  check("weekday window matches Wed", inSendWindow(win({ window_days: [1, 2, 3, 4, 5], window_tz_offset_min: 0 }), wedNoon));
  check("weekend-only window rejects Wed", !inSendWindow(win({ window_days: [6, 7], window_tz_offset_min: 0 }), wedNoon));
  check("time window 9–17 UTC contains noon", inSendWindow(win({ window_start_min: 540, window_end_min: 1020, window_tz_offset_min: 0 }), wedNoon));
  check("time window 13–17 UTC rejects noon", !inSendWindow(win({ window_start_min: 780, window_end_min: 1020, window_tz_offset_min: 0 }), wedNoon));
  // offset +120 (UTC+2): noon UTC = 14:00 local → inside 13–17 local
  check("tz offset shifts the window", inSendWindow(win({ window_start_min: 780, window_end_min: 1020, window_tz_offset_min: 120 }), wedNoon));
  // offset shifting across midnight: Sun 23:00 UTC + 120 = Mon 01:00 local
  const sunLate = new Date("2026-07-19T23:00:00Z");
  check("offset rolls the weekday", inSendWindow(win({ window_days: [1], window_tz_offset_min: 120 }), sunLate));

  // ── broadcast create/patch with window + draft-only rule ───────────────────
  const b = await createBroadcast(A, {
    subject: "sweep: windowed",
    body: "hello **world**",
    windowDays: [1, 2, 3, 4, 5],
    windowStartMin: 540,
    windowEndMin: 1020,
    windowTzOffsetMin: 60,
  });
  check("create stores the window", b.window_days?.join() === "1,2,3,4,5" && b.window_start_min === 540 && b.window_tz_offset_min === 60);
  const patched = await updateBroadcast(A, b.id, { subject: "sweep: windowed v2", windowDays: [6, 7], windowStartMin: null, windowEndMin: null });
  check("draft PATCH edits subject + window", patched?.subject === "sweep: windowed v2" && patched?.window_days?.join() === "6,7" && patched?.window_start_min === null);
  let badWin = false;
  try { await updateBroadcast(A, b.id, { windowStartMin: 600, windowEndMin: 300 }); } catch (e) { badWin = (e as Error).name === "InvalidScheduleError" || String(e).includes("after start"); }
  check("start ≥ end rejected", badWin);
  // arm it (scheduled far future) then confirm PATCH 409s
  const armed = await updateBroadcast(A, b.id, { mode: "oneshot", sendAt: new Date(Date.now() + 86_400_000).toISOString() });
  check("patch can set sendAt on a draft", armed?.send_at !== null);
  await sendBroadcast(A, b.id); // → scheduled
  let notDraft = false;
  try { await updateBroadcast(A, b.id, { subject: "nope" }); } catch (e) { notDraft = e instanceof NotDraftError; }
  check("non-draft PATCH throws NotDraftError", notDraft);

  // ── reply template flag ─────────────────────────────────────────────────────
  check("no flag → null (stock personal frame)", (await getReplyTemplateTokens(A)) === null);
  const t1 = await createTemplate(A, { name: "Sweep Reply A", tokens: { linkColor: "#ff0000", footerText: "Sweep footer" } });
  const t2 = await createTemplate(A, { name: "Sweep Reply B", tokens: { linkColor: "#00ff00" } });
  await updateTemplate(A, t1.id, { useForReplies: true });
  let tokens = await getReplyTemplateTokens(A);
  check("flagged template resolves, merged over PERSONAL", tokens?.linkColor === "#ff0000" && tokens?.showCard === false && tokens?.footerText === "Sweep footer");
  await updateTemplate(A, t2.id, { useForReplies: true });
  tokens = await getReplyTemplateTokens(A);
  const listed = await listTemplates(A);
  check("flagging B un-flags A (single per tenant)", tokens?.linkColor === "#00ff00" && listed.filter((t) => t.useForReplies).length === 1);
  const rendered = await renderReplyEmail("Hi **there**, see [docs](https://example.com)", { agentName: "Aleš", tokens });
  check("reply frame renders flagged tokens", rendered.html.includes("#00ff00") && rendered.html.includes("— Aleš"));
  const stock = await renderReplyEmail("plain", {});
  check("stock frame unchanged without tokens", stock.html.includes("Sent with Noola"));
  await deleteTemplate(A, t1.id);
  await deleteTemplate(A, t2.id);
  check("deleting the flagged row degrades to stock", (await getReplyTemplateTokens(A)) === null);

  await cleanup();
  console.log(failures === 0 ? "\nsweep: ALL PASS" : `\nsweep: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
