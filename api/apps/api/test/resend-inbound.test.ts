import assert from "node:assert";
import { createHmac } from "node:crypto";
import { verifyResendSignature, parseAddress } from "../src/resend-inbound.js";

// Build a valid Svix signature the way Resend does, so we test our verifier against a self-consistent
// oracle (exercises the exact HMAC-SHA256(base64-key, `${id}.${ts}.${body}`) → base64 scheme).
function sign(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

const secret = "whsec_" + Buffer.from("supersecret-signing-key-🔒-padding").toString("base64");
const id = "msg_2abc";
const now = Math.floor(Date.now() / 1000);
const ts = String(now);
const body = JSON.stringify({ type: "email.received", data: { email_id: "e_1", to: ["support@acme.com"] } });
const good = sign(secret, id, ts, body);

// valid signature accepted
assert.equal(verifyResendSignature(body, { id, timestamp: ts, signature: good }, secret), true, "valid signature accepted");
// second v1 token among several still matches (Svix may send multiple space-separated sigs)
assert.equal(verifyResendSignature(body, { id, timestamp: ts, signature: `v1,deadbeef ${good}` }, secret), true, "one matching token among many accepted");
// tampered body rejected
assert.equal(verifyResendSignature(body + " ", { id, timestamp: ts, signature: good }, secret), false, "tampered body rejected");
// wrong secret rejected
assert.equal(verifyResendSignature(body, { id, timestamp: ts, signature: good }, "whsec_" + Buffer.from("other").toString("base64")), false, "wrong secret rejected");
// stale timestamp rejected (replay window)
const oldTs = String(now - 100000);
assert.equal(verifyResendSignature(body, { id, timestamp: oldTs, signature: sign(secret, id, oldTs, body) }, secret), false, "stale timestamp rejected");
// missing headers rejected
assert.equal(verifyResendSignature(body, {}, secret), false, "missing headers rejected");
// missing secret rejected
assert.equal(verifyResendSignature(body, { id, timestamp: ts, signature: good }, undefined), false, "missing secret rejected");

// address parsing: display-name form, bare form, and +tag preservation for exact-ticket routing
assert.deepEqual(parseAddress('"Ada Lovelace" <Ada@Example.com>'), { address: "ada@example.com", name: "Ada Lovelace" }, "name + address parsed");
assert.deepEqual(parseAddress("bare@Example.com"), { address: "bare@example.com" }, "bare address parsed");
assert.equal(parseAddress("support+t.abc.def@zerops.io <support+t.abc.def@zerops.io>").address, "support+t.abc.def@zerops.io", "plus-token preserved");

console.log("resend-inbound: all assertions passed");
