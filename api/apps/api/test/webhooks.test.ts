import pg from "pg";
import { createHmac } from "node:crypto";
import { appPool, relayPool } from "@repo/db";
import {
  createWebhook,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  listDeliveries,
  fireEvent,
  sendTestPing,
  __setWebhookFetch,
} from "../src/webhooks.js";
import { createContact } from "../src/contacts.js";
import { WebhookInput } from "@repo/contracts";

// Outbound webhooks seam: a tenant registers webhook URLs subscribed to events; fireEvent
// POSTs an HMAC-signed JSON body to the ACTIVE + SUBSCRIBED webhooks only, and records a
// delivery per attempt. Network is never hit — the delivery fetch is injected (test seam
// __setWebhookFetch), capturing each request so the signature can be verified offline.
// Needs Postgres only.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const MARK = "WHTEST"; // url marker so teardown can sweep test webhooks

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

// ---- capturing fetch seam ------------------------------------------------
interface Captured { url: string; headers: Record<string, string>; body: string }
let captured: Captured[] = [];
let nextStatus = 200;
let throwNext = false;

const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input as URL | Request).toString();
  const h = (init?.headers ?? {}) as Record<string, string>;
  const body = typeof init?.body === "string" ? init.body : "";
  captured.push({ url, headers: h, body });
  if (throwNext) throw new Error("simulated network failure");
  return new Response(null, { status: nextStatus });
};

function reset() { captured = []; nextStatus = 200; throwNext = false; }

async function waitFor(pred: () => boolean, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

const url = (slug: string) => `https://hooks.example.test/${MARK}/${slug}`;
// The fetch mock's fake hostname never resolves — without this seam the SSRF DNS-guard
// (W5-security) blocks delivery before the mock is reached. The guard reads it per call.
process.env.WEBHOOK_SSRF_ALLOW = "hooks.example.test";

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query(`DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE url LIKE '%${MARK}%')`);
    await superPool.query(`DELETE FROM webhooks WHERE url LIKE '%${MARK}%'`);
    await superPool.query("DELETE FROM contacts WHERE external_id LIKE 'whtest%'");
  };
  await clean();
  __setWebhookFetch(fakeFetch);

  // ---- create returns the secret ONCE; list never echoes it ----
  const { webhook: wh1, secret: secret1 } = await createWebhook(A, { url: url("h1"), events: ["contact.created"] });
  check("createWebhook returns a 32-byte hex secret", /^[0-9a-f]{64}$/.test(secret1));
  check("created webhook has_secret + no secret field", wh1.has_secret === true && !("secret" in wh1));
  const listed = await listWebhooks(A);
  const l1 = listed.find((w) => w.id === wh1.id);
  check("listWebhooks never returns the secret", !!l1 && !("secret" in l1) && l1!.has_secret === true);

  // subscribed-to-other, inactive-all, and active-all peers
  const { webhook: wh2 } = await createWebhook(A, { url: url("h2"), events: ["ticket.created"] });
  const { webhook: wh3, secret: secret3 } = await createWebhook(A, { url: url("h3"), events: [], active: false });
  const { webhook: wh4, secret: secret4 } = await createWebhook(A, { url: url("h4") }); // events omitted = all

  // ---- fireEvent hits ACTIVE + SUBSCRIBED webhooks only ----
  reset();
  await fireEvent(A, "contact.created", { id: "contact-123", email: "z@x.test" });
  const hitUrls = captured.map((c) => c.url).sort();
  check("fireEvent posts only to active+subscribed webhooks (h1 explicit, h4 all)",
    JSON.stringify(hitUrls) === JSON.stringify([url("h1"), url("h4")].sort()));
  check("unsubscribed webhook (h2, only ticket.created) is skipped", !hitUrls.includes(url("h2")));
  check("inactive webhook (h3) is skipped", !hitUrls.includes(url("h3")));

  // ---- the posted body is correctly HMAC-signed with THAT webhook's secret ----
  {
    const req1 = captured.find((c) => c.url === url("h1"))!;
    const expected = `sha256=${createHmac("sha256", secret1).update(req1.body).digest("hex")}`;
    check("X-Noola-Signature is sha256=<hmac of raw body with the webhook's secret>",
      req1.headers["x-noola-signature"] === expected);
    check("X-Noola-Event header carries the event name", req1.headers["x-noola-event"] === "contact.created");
    check("Content-Type is application/json", (req1.headers["content-type"] ?? "").includes("application/json"));
    const parsed = JSON.parse(req1.body);
    check("body is { event, occurredAt, data }", parsed.event === "contact.created" && typeof parsed.occurredAt === "string" && parsed.data.id === "contact-123");
    // a signature verified with the WRONG secret must not match (sanity)
    const wrong = `sha256=${createHmac("sha256", secret4).update(req1.body).digest("hex")}`;
    check("signature does not verify under a different secret", req1.headers["x-noola-signature"] !== wrong);
  }

  // ---- a delivery row is recorded per attempt (ok=true on 2xx) ----
  {
    const d1 = await listDeliveries(A, wh1.id);
    check("delivery recorded for h1 with ok=true, status 200", d1.length === 1 && d1[0].ok === true && d1[0].status_code === 200 && d1[0].event === "contact.created");
    const d4 = await listDeliveries(A, wh4.id);
    check("delivery recorded for h4 (events=[] all)", d4.length === 1 && d4[0].ok === true);
    const d2 = await listDeliveries(A, wh2.id);
    check("no delivery for the skipped webhook", d2.length === 0);
  }

  // ---- failure path: non-2xx records ok=false + status_code ----
  reset();
  nextStatus = 500;
  await fireEvent(A, "contact.created", { id: "contact-500" });
  {
    const d1 = await listDeliveries(A, wh1.id);
    check("HTTP 500 records ok=false with the status code", d1[0].ok === false && d1[0].status_code === 500 && !!d1[0].error);
  }
  // network throw path: ok=false, no status code, error captured
  reset();
  throwNext = true;
  await fireEvent(A, "contact.created", { id: "contact-throw" });
  {
    const d1 = await listDeliveries(A, wh1.id);
    check("network failure records ok=false + error, no status", d1[0].ok === false && d1[0].status_code === null && !!d1[0].error);
  }

  // ---- SSRF guard: a private/loopback url is never fetched, recorded ok=false ----
  reset();
  const { webhook: whBad } = await createWebhook(A, { url: url("bad") });
  // sneak a blocked host in by direct update (route validation would reject it, but the
  // delivery-time guard is the real backstop we want to prove)
  await superPool.query("UPDATE webhooks SET url = 'http://169.254.169.254/latest/meta-data/' WHERE id = $1", [whBad.id]);
  await fireEvent(A, "contact.created", { id: "contact-ssrf" });
  {
    const wasFetched = captured.some((c) => c.url.includes("169.254"));
    check("SSRF-blocked url is never fetched", !wasFetched);
    const db = await listDeliveries(A, whBad.id);
    check("SSRF-blocked delivery recorded ok=false", db.length === 1 && db[0].ok === false && (db[0].error ?? "").includes("blocked"));
  }

  // ---- sendTestPing fires a 'ping' to one webhook, returns the delivery ----
  reset();
  const ping = await sendTestPing(A, wh4.id);
  check("sendTestPing returns a delivery for the ping event", !!ping && ping!.event === "ping" && ping!.ok === true);
  check("sendTestPing posted exactly one request to that webhook", captured.length === 1 && captured[0].url === url("h4") && captured[0].headers["x-noola-event"] === "ping");
  check("sendTestPing of a missing webhook → null", (await sendTestPing(A, "00000000-0000-0000-0000-000000000000")) === null);

  // ---- updateWebhook: toggle active / edit events ----
  {
    const upd = await updateWebhook(A, wh2.id, { active: false, events: ["contact.created", "contact.updated"] });
    check("updateWebhook edits events + toggles active", !!upd && upd!.active === false && upd!.events.length === 2);
    // now inactive → still skipped even though it subscribes to contact.created
    reset();
    await fireEvent(A, "contact.updated", { id: "x" });
    check("re-subscribed but inactive webhook stays skipped", !captured.some((c) => c.url === url("h2")));
    check("updateWebhook of a missing id → null", (await updateWebhook(A, "00000000-0000-0000-0000-000000000000", { active: true })) === null);
  }

  // ---- contact.created fires on createContact (end-to-end wiring incl. dynamic import) ----
  reset();
  const { webhook: whC } = await createWebhook(A, { url: url("contacts"), events: ["contact.created"] });
  const contact = await createContact(A, { external_id: "whtest-c1", email: "whtest-c1@acme.example", name: "Wired Contact" });
  const fired = await waitFor(() => captured.some((c) => c.url === url("contacts")));
  check("createContact fires the contact.created webhook", fired);
  {
    const req = captured.find((c) => c.url === url("contacts"));
    check("contact.created payload carries the created contact", !!req && JSON.parse(req!.body).data.id === contact.id);
    let deliveries = await listDeliveries(A, whC.id);
    for (let i = 0; i < 40 && deliveries.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
      deliveries = await listDeliveries(A, whC.id);
    }
    check("createContact webhook delivery is recorded", deliveries.length >= 1 && deliveries[0].event === "contact.created");
  }

  // ---- tenant isolation ----
  {
    reset();
    // B has its own webhook subscribed to contact.created
    await createWebhook(B, { url: url("b1"), events: ["contact.created"] });
    await fireEvent(A, "contact.created", { id: "iso" });
    check("A's fireEvent never posts to B's webhook", !captured.some((c) => c.url === url("b1")));
    // B cannot see A's webhooks, and vice versa
    check("B's list never sees A's webhook", !(await listWebhooks(B)).some((w) => w.id === wh1.id));
    check("A cannot update B's webhook (RLS → not found)", (await updateWebhook(A, (await listWebhooks(B))[0].id, { active: false })) === null);
    check("A cannot delete a nonexistent/foreign webhook", (await deleteWebhook(A, "00000000-0000-0000-0000-000000000000")) === false);
  }

  // ---- WebhookInput contract ----
  check("WebhookInput rejects a non-http url", !WebhookInput.safeParse({ url: "ftp://x.test/h" }).success);
  check("WebhookInput rejects a non-url", !WebhookInput.safeParse({ url: "not a url" }).success);
  check("WebhookInput accepts https + events", WebhookInput.safeParse({ url: "https://x.test/h", events: ["contact.created"] }).success);
  check("WebhookInput url is required", !WebhookInput.safeParse({ events: [] }).success);

  // ---- deleteWebhook ----
  check("deleteWebhook own → true", (await deleteWebhook(A, wh3.id)) === true);
  check("deleted webhook is gone", !(await listWebhooks(A)).some((w) => w.id === wh3.id));
  void secret3; void secret4;

  __setWebhookFetch(null);
  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nWEBHOOKS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nWEBHOOKS: all checks green");
}

main().catch((e) => { console.error("webhooks seam ERROR", e); process.exit(1); });
