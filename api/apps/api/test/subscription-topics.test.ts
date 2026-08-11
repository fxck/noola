import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { createContact } from "../src/contacts.js";
import { previewSegment, previewRecipients } from "../src/broadcasts.js";
import {
  createTopic,
  listTopics,
  updateTopic,
  deleteTopic,
  topicExists,
  getContactSubscriptionState,
  setTopicOptout,
} from "../src/subscription-topics.js";
import { unsubscribeUrl } from "../src/unsubscribe.js";
import { setSubscription } from "../src/unsubscribe.js";

// Multi-level unsubscribe gate (0110): subscription topics; a per-topic opt-out excludes a contact
// from a broadcast on THAT topic while leaving other topics (and the global stream) intact; a global
// opt-out still overrides everything. Postgres only.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query("DELETE FROM contact_topic_optouts WHERE topic_id IN (SELECT id FROM subscription_topics WHERE name LIKE 'STOP %')");
    await superPool.query("DELETE FROM subscription_topics WHERE name LIKE 'STOP %'");
    await superPool.query("DELETE FROM contacts WHERE company = 'StopCo' OR email LIKE 'stop-%'");
  };
  await clean();

  // ---- topic CRUD ----
  const updates = await createTopic(A, { name: "STOP Product updates", description: "New features" });
  const security = await createTopic(A, { name: "STOP Security notices", description: "Account safety" });
  check("createTopic returns a row", !!updates.id && updates.name === "STOP Product updates");
  const topics = await listTopics(A);
  check("listTopics includes both", topics.some((t) => t.id === updates.id) && topics.some((t) => t.id === security.id));
  check("topicExists true for a live topic", await topicExists(A, updates.id));
  check("topicExists false for a bogus id", !(await topicExists(A, "00000000-0000-0000-0000-000000000000")));
  const archived = await updateTopic(A, security.id, { archived: true });
  check("updateTopic archives", archived?.archived === true);
  check("listTopics hides archived by default", !(await listTopics(A)).some((t) => t.id === security.id));
  check("listTopics(includeArchived) shows it", (await listTopics(A, true)).some((t) => t.id === security.id));
  await updateTopic(A, security.id, { archived: false }); // un-archive for the rest

  // ---- enforcement ----
  const seg = { conditionGroups: [[{ field: "company", op: "is", value: "StopCo" }]] };
  await createContact(A, { email: "stop-a@test.example", name: "Alice", company: "StopCo" });
  await createContact(A, { email: "stop-b@test.example", name: "Bob", company: "StopCo" });
  const cA = (await superPool.query("SELECT id FROM contacts WHERE email = 'stop-a@test.example'")).rows[0].id as string;

  const base = await previewRecipients(A, seg, "email", 200, updates.id);
  check("both reachable on the topic before any opt-out", base.reachable === 2 && base.recipients.length === 2);

  // Alice opts out of Product updates only.
  const okOpt = await setTopicOptout(A, cA, updates.id, true);
  check("setTopicOptout returns true", okOpt);
  const afterTopicA = await previewRecipients(A, seg, "email", 200, updates.id);
  check("topic opt-out drops Alice from THAT topic", afterTopicA.reachable === 1 && afterTopicA.recipients.every((r) => r.handle !== "stop-a@test.example"));
  const afterTopicB = await previewRecipients(A, seg, "email", 200, security.id);
  check("Alice still receives a DIFFERENT topic", afterTopicB.reachable === 2);
  const untopiced = await previewSegment(A, seg);
  check("untopiced send still reaches everyone", (untopiced.reachable.email ?? 0) === 2);

  // ---- preference-center state ----
  const state = await getContactSubscriptionState(A, cA);
  check("state: not globally unsubscribed", state.globallyUnsubscribed === false);
  const su = state.topics.find((t) => t.id === updates.id);
  const ss = state.topics.find((t) => t.id === security.id);
  check("state: opted OUT of Product updates", su?.subscribed === false);
  check("state: still subscribed to Security notices", ss?.subscribed === true);

  // Re-subscribe to the topic.
  await setTopicOptout(A, cA, updates.id, false);
  check("re-subscribe restores topic reach", (await previewRecipients(A, seg, "email", 200, updates.id)).reachable === 2);

  // ---- global overrides topic ----
  await setSubscription(A, cA, true); // global opt-out
  const globalOut = await previewRecipients(A, seg, "email", 200, security.id);
  check("global opt-out excludes from every topic", globalOut.reachable === 1 && globalOut.recipients.every((r) => r.handle !== "stop-a@test.example"));
  const gState = await getContactSubscriptionState(A, cA);
  check("state reflects global opt-out", gState.globallyUnsubscribed === true);
  await setSubscription(A, cA, false); // restore

  // ---- link carries the topic ----
  const url = unsubscribeUrl(A, cA, updates.id);
  check("unsubscribeUrl carries ?t=<topic>", !!url && url.includes(`?t=${updates.id}`));
  const globalUrl = unsubscribeUrl(A, cA);
  check("unsubscribeUrl without topic has no ?t", !!globalUrl && !globalUrl.includes("?t="));

  // ---- delete cascades ----
  await deleteTopic(A, updates.id);
  check("deleteTopic removes it", !(await topicExists(A, updates.id)));
  const optoutsGone = await superPool.query("SELECT 1 FROM contact_topic_optouts WHERE topic_id = $1", [updates.id]);
  check("deleteTopic cascades its opt-out rows", optoutsGone.rowCount === 0);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nSUBSCRIPTION-TOPICS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nSUBSCRIPTION-TOPICS: all checks green");
}

main().catch((e) => { console.error("subscription-topics ERROR", e); process.exit(1); });
