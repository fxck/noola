import assert from "node:assert";
import { normalizeSendgrid } from "../src/email-domains.js";

// SendGrid Sender Authentication returns a `dns` object of named CNAME entries + a domain-level
// `valid`; we normalize it into our provider-neutral DnsRecord[] + status vocabulary.
const sample = {
  id: 16628701,
  valid: false,
  dns: {
    mail_cname: { valid: false, type: "cname", host: "em1234.zerops.io", data: "u123.wl.sendgrid.net" },
    dkim1: { valid: true, type: "cname", host: "s1._domainkey.zerops.io", data: "s1.domainkey.u123.wl.sendgrid.net" },
    dkim2: { valid: false, type: "cname", host: "s2._domainkey.zerops.io", data: "s2.domainkey.u123.wl.sendgrid.net" },
  },
};

const n = normalizeSendgrid(sample);
assert.equal(n.providerId, "16628701", "domain id → providerId (stringified)");
assert.equal(n.status, "pending", "domain valid=false → pending");
assert.equal(n.records.length, 3, "all three dns entries mapped");

const dkim1 = n.records.find((r) => r.record === "dkim1")!;
assert.equal(dkim1.type, "CNAME", "type upper-cased");
assert.equal(dkim1.name, "s1._domainkey.zerops.io", "host → name");
assert.equal(dkim1.value, "s1.domainkey.u123.wl.sendgrid.net", "data → value");
assert.equal(dkim1.status, "valid", "per-record valid=true → 'valid'");
assert.equal(n.records.find((r) => r.record === "dkim2")!.status, "pending", "per-record valid=false → 'pending'");

// A fully-validated domain maps to 'verified'.
const done = normalizeSendgrid({ id: 1, valid: true, dns: { mail_cname: { valid: true, type: "cname", host: "h", data: "d" } } });
assert.equal(done.status, "verified", "domain valid=true → verified");

// Missing/empty dns is tolerated.
assert.deepEqual(normalizeSendgrid({ id: 2, valid: false }).records, [], "no dns → empty records");

console.log("email-domains: all assertions passed");
