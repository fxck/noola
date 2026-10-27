import pg from "pg";
import { parseCsv, parseCsvContacts } from "../src/csv-import.js";
import { ipMatches, ipAllowed, isInternalIp, getPolicies, putPolicies } from "../src/governance.js";
import {
  listChannelConnections, saveChannelConnection, deleteChannelConnection,
  tenantChannelConnection, activeChannelConnections, bustConnectionCache,
} from "../src/channel-connections.js";
import {
  scimCreateGroup, scimListGroups, scimGetGroup, scimPatchGroup, scimDeleteGroup,
} from "../src/scim.js";
import { handleInboundEmail } from "../src/email.js";
import { withTenant } from "@repo/db";

// 0092 tails & hygiene: CSV import parsing, IP allowlist matching + governance policies,
// self-serve channel connections (encrypted secrets, tenant-scoped resolution), SCIM Groups
// over teams, and inbound-email cc/attachment persistence. TestCo (33…) is the dedicated test
// tenant — every write here lands there, never the live demo Acme. Needs Postgres.

const T = "33333333-3333-3333-3333-333333333333"; // TestCo
const G = "22222222-2222-2222-2222-222222222222"; // Globex (isolation partner)

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 2,
  });
  const clean = async () => {
    await superPool.query("DELETE FROM channel_connections WHERE tenant_id IN ($1,$2)", [T, G]);
    await superPool.query("DELETE FROM tenant_policies WHERE tenant_id IN ($1,$2)", [T, G]);
    await superPool.query("DELETE FROM teams WHERE tenant_id = $1 AND name LIKE 'TAILS-%'", [T]);
    await superPool.query("DELETE FROM tickets WHERE tenant_id = $1 AND external_channel_id LIKE 'tails-%'", [T]);
    await superPool.query("DELETE FROM contacts WHERE tenant_id = $1 AND email LIKE 'tails-%'", [T]);
  };
  await clean();

  // ── CSV parsing ────────────────────────────────────────────────────────────
  {
    const grid = parseCsv('a,b,c\n1,"two, still two",3\n"line\nbreak",y,z');
    check("csv: row/col count", grid.length === 3 && grid[0].length === 3);
    check("csv: quoted comma stays one field", grid[1][1] === "two, still two");
    check("csv: quoted newline stays one field", grid[2][0] === "line\nbreak");

    const quoted = parseCsv('h\n"he said ""hi"""');
    check("csv: escaped double-quote", quoted[1][0] === 'he said "hi"');

    const res = parseCsvContacts("email,name,Plan\ntails-ada@example.com,Ada,pro\nnobody,,x\ntails-grace@example.com,Grace,free");
    check("csvContacts: parses valid rows", !("error" in res) && res.rows.length === 2);
    if (!("error" in res)) {
      check("csvContacts: skips row with no email/external_id", res.skipped === 1);
      check("csvContacts: maps email + name", res.rows[0].email === "tails-ada@example.com" && res.rows[0].name === "Ada");
      check("csvContacts: unknown column → attribute", (res.rows[0].attributes as { Plan?: string })?.Plan === "pro");
    }
    const noHeader = parseCsvContacts("foo,bar\n1,2");
    check("csvContacts: rejects header without email/external_id", "error" in noHeader);
  }

  // ── IP allowlist ─────────────────────────────────────────────────────────────
  {
    check("ip: exact match", ipMatches("203.0.113.7", "203.0.113.7"));
    check("ip: exact mismatch", !ipMatches("203.0.113.8", "203.0.113.7"));
    check("ip: /24 contains", ipMatches("198.51.100.42", "198.51.100.0/24"));
    check("ip: /24 excludes neighbor", !ipMatches("198.51.101.42", "198.51.100.0/24"));
    check("ip: /32 is exact", ipMatches("10.0.0.1", "10.0.0.1/32") && !ipMatches("10.0.0.2", "10.0.0.1/32"));
    check("ip: /0 matches all", ipMatches("8.8.8.8", "0.0.0.0/0"));
    check("ip: internal loopback", isInternalIp("127.0.0.1") && isInternalIp("::1"));
    check("ip: internal rfc1918", isInternalIp("10.1.2.3") && isInternalIp("192.168.1.1") && isInternalIp("172.16.5.5"));
    check("ip: public not internal", !isInternalIp("203.0.113.7"));
    check("allow: empty list allows all", ipAllowed("203.0.113.7", []));
    check("allow: internal always allowed even with list", ipAllowed("127.0.0.1", ["203.0.113.7"]));
    check("allow: listed public passes", ipAllowed("203.0.113.7", ["203.0.113.0/24"]));
    check("allow: unlisted public blocked", !ipAllowed("8.8.8.8", ["203.0.113.0/24"]));
    check("allow: ipv4-mapped ipv6 normalized", ipAllowed("::ffff:203.0.113.7", ["203.0.113.7"]));
  }

  // ── governance policies ──────────────────────────────────────────────────────
  {
    const def = await getPolicies(T);
    check("policies: defaults", def.retentionDays === null && def.ipAllowlist.length === 0 && def.require2fa === false);
    await putPolicies(T, { retentionDays: 365, require2fa: true });
    const p1 = await getPolicies(T);
    check("policies: partial patch keeps other fields", p1.retentionDays === 365 && p1.require2fa === true && p1.ipAllowlist.length === 0);
    await putPolicies(T, { ipAllowlist: ["203.0.113.0/24"] });
    const p2 = await getPolicies(T);
    check("policies: ip patch preserves retention", p2.retentionDays === 365 && p2.ipAllowlist.length === 1);
    // isolation: Globex sees its own defaults, not TestCo's.
    const gp = await getPolicies(G);
    check("policies: tenant isolation", gp.retentionDays === null && gp.ipAllowlist.length === 0);
  }

  // ── channel connections ──────────────────────────────────────────────────────
  {
    const tg = await saveChannelConnection(T, { channel: "telegram", label: "Bot", secret: { botToken: "123:ABC-secret" } });
    check("channels: telegram saved, secret hidden", tg.channel === "telegram" && tg.hasSecret === true && !(tg as unknown as { secret?: unknown }).secret);
    const list = await listChannelConnections(T);
    check("channels: listed", list.length === 1 && list[0].channel === "telegram");

    bustConnectionCache();
    const live = await tenantChannelConnection(T, "telegram");
    check("channels: live resolution decrypts secret", live?.secret.botToken === "123:ABC-secret");

    // Save-replaces: a second telegram save leaves exactly one row.
    await saveChannelConnection(T, { channel: "telegram", secret: { botToken: "999:XYZ" } });
    const after = await listChannelConnections(T);
    check("channels: save replaces (one per channel)", after.filter((c) => c.channel === "telegram").length === 1);
    bustConnectionCache();
    const live2 = await tenantChannelConnection(T, "telegram");
    check("channels: replacement secret wins", live2?.secret.botToken === "999:XYZ");

    const wa = await saveChannelConnection(T, { channel: "whatsapp", config: { phoneId: "TAILS-PHONE-1" }, secret: { token: "wa-secret", verifyToken: "vfy" } });
    check("channels: whatsapp saved with phoneId config", (wa.config as { phoneId?: string }).phoneId === "TAILS-PHONE-1");
    bustConnectionCache();
    const waRows = await activeChannelConnections("whatsapp");
    const waMine = waRows.find((r) => r.tenantId === T);
    check("channels: whatsapp live carries phoneId + verifyToken", String(waMine?.config.phoneId) === "TAILS-PHONE-1" && waMine?.secret.verifyToken === "vfy");

    // Isolation: Globex can't see TestCo's connections.
    const gList = await listChannelConnections(G);
    check("channels: tenant isolation", gList.length === 0);

    await deleteChannelConnection(T, tg.id).catch(() => {}); // tg row already replaced; delete current
    for (const c of await listChannelConnections(T)) await deleteChannelConnection(T, c.id);
    check("channels: delete clears", (await listChannelConnections(T)).length === 0);
  }

  // ── SCIM Groups over teams ───────────────────────────────────────────────────
  {
    const seat = "c0000000-0000-0000-0000-000000000001"; // Tess (TestCo agent)
    const g = await scimCreateGroup(T, { displayName: "TAILS-Frontline", members: [{ value: seat }] });
    check("scim group: created with member", !("conflict" in g) && (g as { displayName: string }).displayName === "TAILS-Frontline");
    const gid = ("conflict" in g) ? "" : (g as { id: string }).id;
    check("scim group: valid member kept", !("conflict" in g) && (g as { members: unknown[] }).members.length === 1);

    const listed = await scimListGroups(T, 'displayName eq "TAILS-Frontline"');
    check("scim group: filter by displayName", listed.totalResults === 1);

    const patched = await scimPatchGroup(T, gid, { Operations: [{ op: "replace", path: "displayName", value: "TAILS-Renamed" }] });
    check("scim group: patch renames", patched?.displayName === "TAILS-Renamed");

    const removed = await scimPatchGroup(T, gid, { Operations: [{ op: "remove", path: `members[value eq "${seat}"]` }] });
    check("scim group: patch removes member", removed?.members.length === 0);

    const got = await scimGetGroup(T, gid);
    check("scim group: get after patch", got?.displayName === "TAILS-Renamed");

    const dup = await scimCreateGroup(T, { displayName: "TAILS-Renamed" });
    check("scim group: duplicate name → conflict", "conflict" in dup);

    check("scim group: delete", await scimDeleteGroup(T, gid) === true);
    check("scim group: gone after delete", (await scimGetGroup(T, gid)) === null);
  }

  // ── inbound email cc + attachments ───────────────────────────────────────────
  {
    const msgId = `<tails-${Date.now()}@example.com>`;
    const res = await handleInboundEmail({
      messageId: msgId,
      from: "tails-cust@example.com",
      to: "support@testco.noola.test",
      subject: "Need help",
      body: "please help",
      cc: ["tails-boss@example.com", "tails-cc2@example.com"],
      attachments: [{ filename: "note.txt", contentType: "text/plain", data: Buffer.from("hello attach") }],
    });
    check("email: inbound routed to TestCo", res?.tenantId === T);
    if (res) {
      const meta = await withTenant(T, async (c) => {
        const m = await c.query("SELECT meta FROM messages WHERE id = $1", [res.messageId]);
        return m.rows[0]?.meta as { cc?: string[] } | null;
      });
      check("email: cc stamped on message meta", Array.isArray(meta?.cc) && meta!.cc!.length === 2 && meta!.cc!.includes("tails-boss@example.com"));
      const atts = await withTenant(T, async (c) => {
        const a = await c.query("SELECT filename, size_bytes, storage_key FROM message_attachments WHERE message_id = $1", [res.messageId]);
        return a.rows as { filename: string; size_bytes: number; storage_key: string }[];
      });
      check("email: attachment persisted onto message", atts.length === 1 && atts[0].filename === "note.txt" && atts[0].size_bytes === 12);
      check("email: attachment stored as owned object (not a url)", !!atts[0]?.storage_key && !/^https?:\/\//.test(atts[0].storage_key));
    }
  }

  await clean();
  await superPool.end();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
