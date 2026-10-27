import assert from "node:assert";
import { publicApiBase } from "../src/env.js";

// publicApiBase: prefer API_BASE_URL (branded custom domain in prod), else the Zerops auto subdomain,
// else localhost — always without a trailing slash.
const saved = { api: process.env.API_BASE_URL, sub: process.env.zeropsSubdomain, port: process.env.PORT };
function reset() { delete process.env.API_BASE_URL; delete process.env.zeropsSubdomain; delete process.env.PORT; }

// explicit API_BASE_URL wins and is trailing-slash-trimmed
reset();
process.env.API_BASE_URL = "https://api.noola.cc/";
process.env.zeropsSubdomain = "apidev-2486-3000.prg1.zerops.app";
assert.equal(publicApiBase(), "https://api.noola.cc", "API_BASE_URL wins over the Zerops subdomain");

// no explicit → derive from a bare zeropsSubdomain (https prefixed)
reset();
process.env.zeropsSubdomain = "apidev-2486-3000.prg1.zerops.app";
assert.equal(publicApiBase(), "https://apidev-2486-3000.prg1.zerops.app", "bare subdomain gets https://");

// a subdomain already carrying a scheme is used as-is
reset();
process.env.zeropsSubdomain = "https://apidev-2486-3000.prg1.zerops.app";
assert.equal(publicApiBase(), "https://apidev-2486-3000.prg1.zerops.app", "scheme-carrying subdomain kept");

// nothing set → localhost:PORT
reset();
process.env.PORT = "3000";
assert.equal(publicApiBase(), "http://localhost:3000", "falls back to localhost:PORT");

Object.assign(process.env, saved);
console.log("env: all assertions passed");
