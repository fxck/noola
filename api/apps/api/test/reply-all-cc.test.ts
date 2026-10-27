import { stripOwnCcAddresses } from "../src/email.js";

// Reply-all Cc seed hygiene: the customer emails TO support@, so the tenant's own inbound/support
// address rides in on the parsed cc list. CC-ing it back onto the reply forwards the outbound into
// Inbound Parse — a self-loop that spawns a duplicate ticket. stripOwnCcAddresses must drop the
// tenant's own support + reply addresses (case-insensitively), de-dupe, and leave real recipients.
// Pure — no network, no DB.

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

function main() {
  const support = "support@zerops.io";
  const reply = "support@inbound.zerops.io";

  // ---- the reported bug: To:support@ rides in on cc, must be stripped ----
  {
    const out = stripOwnCcAddresses(["support@zerops.io", "bob@customer.com"], support, reply);
    check("strips the tenant's own support address", !out.includes("support@zerops.io"));
    check("keeps a genuine third-party recipient", out.includes("bob@customer.com"));
  }

  // ---- the inbound/reply address is stripped too (forward scenario) ----
  {
    const out = stripOwnCcAddresses(["SUPPORT@INBOUND.ZEROPS.IO", "carol@acme.com"], support, reply);
    check("strips the reply address case-insensitively", out.length === 1 && out[0] === "carol@acme.com");
  }

  // ---- case + whitespace insensitivity on the OWN side ----
  {
    const out = stripOwnCcAddresses(["  Support@Zerops.IO  ", "dave@x.com"], support, reply);
    check("matches own address ignoring case + surrounding whitespace", out.length === 1 && out[0] === "dave@x.com");
  }

  // ---- de-dupe (a recipient listed twice collapses) ----
  {
    const out = stripOwnCcAddresses(["a@x.com", "A@X.com", "b@y.com"], support, reply);
    check("de-dupes case-insensitive duplicates", out.length === 2 && out[0] === "a@x.com" && out[1] === "b@y.com");
  }

  // ---- null own addresses (no BYO reply address configured) are ignored, not thrown ----
  {
    const out = stripOwnCcAddresses(["support@zerops.io", "e@z.com"], support, null);
    check("null reply address is tolerated; support still stripped", out.length === 1 && out[0] === "e@z.com");
    const out2 = stripOwnCcAddresses(["e@z.com"], null, null);
    check("both own addresses null → passthrough unchanged", out2.length === 1 && out2[0] === "e@z.com");
  }

  // ---- junk entries (non-strings, blanks) are dropped, never crash ----
  {
    const out = stripOwnCcAddresses(["f@z.com", "", "   ", null as unknown as string, 42 as unknown as string], support, reply);
    check("drops blank / non-string junk", out.length === 1 && out[0] === "f@z.com");
  }

  if (failures > 0) { console.error(`\nREPLY-ALL-CC: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nREPLY-ALL-CC: all checks green");
}

main();
