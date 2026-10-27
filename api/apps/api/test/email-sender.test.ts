import pg from "pg";
import { resolveFromIdentity, setSenderMode, getSenderSettingsView, bustSenderCache, setBrandName, resolveBrandName } from "../src/email-sender.js";
import { resolveTemplateTokens, listTemplates } from "../src/email-templates.js";

// Teammate sending identity: shared mode → support address + "<name> from <workspace>"; teammate mode
// → the teammate's OWN address when its domain is verified, else fall back to support.
const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const DOMAIN = "sendertest.example";
const SUPPORT = `support@${DOMAIN}`;
const AGENT_EMAIL = `alex@${DOMAIN}`;

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
    await superPool.query("DELETE FROM email_sender_settings WHERE tenant_id = $1", [A]);
    await superPool.query("DELETE FROM email_sending_domains WHERE tenant_id = $1 AND domain = $2", [A, DOMAIN]);
  };
  await clean();

  try {
    // A verified sending domain for the tenant (so alex@sendertest.example is a valid teammate From).
    await superPool.query(
      "INSERT INTO email_sending_domains (tenant_id, domain, provider, status, records) VALUES ($1, $2, 'resend', 'verified', '[]'::jsonb)",
      [A, DOMAIN],
    );
    bustSenderCache(A);

    // --- shared mode (default) ---
    await setSenderMode(A, "shared");
    const shared = await resolveFromIdentity(A, SUPPORT, { agentName: "Alex", agentEmail: AGENT_EMAIL });
    check("shared: address is the support address", shared.address === SUPPORT);
    check("shared: display name is '<agent> from <workspace>'", !!shared.name && /^Alex from .+/.test(shared.name));

    // --- teammate mode ---
    await setSenderMode(A, "teammate");
    const teammate = await resolveFromIdentity(A, SUPPORT, { agentName: "Alex", agentEmail: AGENT_EMAIL });
    check("teammate + verified domain: sends from the teammate's own address", teammate.address === AGENT_EMAIL);
    check("teammate: still carries a display name", !!teammate.name && /^Alex from /.test(teammate.name));

    // teammate mode but the agent's email is on an UNVERIFIED domain → fall back to support (never send
    // from a domain we can't DKIM-sign).
    const unverified = await resolveFromIdentity(A, SUPPORT, { agentName: "Bo", agentEmail: "bo@not-verified.example" });
    check("teammate + unverified domain: falls back to support", unverified.address === SUPPORT);

    // teammate mode, no agent (AI/automated reply) → support address, workspace-only display name.
    const ai = await resolveFromIdentity(A, SUPPORT, { agentName: null, agentEmail: null });
    check("teammate + no agent: support address", ai.address === SUPPORT);
    check("teammate + no agent: workspace-only name (no ' from ')", !!ai.name && !/ from /.test(ai.name));

    // settings view reflects mode + that a verified domain exists (so the UI can offer teammate mode).
    const view = await getSenderSettingsView(A);
    check("view reports current mode", view.mode === "teammate");
    check("view reports a verified domain is available", view.hasVerifiedDomain === true);

    // --- brand name (email chrome) ---
    // Unset brand → falls back to the workspace name, never a hardcoded "Noola".
    await setBrandName(A, "");
    const wsBrand = await resolveBrandName(A);
    check("unset brand falls back to the workspace name", wsBrand === view.workspace && wsBrand !== "Noola");
    check("unset brand: the Branded built-in's wordmark IS the workspace name",
      (await resolveTemplateTokens(A, "branded")).wordmark === view.workspace);
    const emptyView = await getSenderSettingsView(A);
    check("view exposes the raw brand override (empty when unset)", emptyView.brandName === "");

    // Explicit brand override wins everywhere the chrome is resolved.
    await setBrandName(A, "Acme Support");
    check("resolveBrandName returns the explicit override", (await resolveBrandName(A)) === "Acme Support");
    check("Branded built-in wordmark picks up the override", (await resolveTemplateTokens(A, "branded")).wordmark === "Acme Support");
    const listed = await listTemplates(A);
    check("listTemplates shows the brand on the Branded built-in", listed.find((t) => t.id === "branded")?.tokens.wordmark === "Acme Support");
    check("the Personal built-in stays headerless (no brand injected)", listed.find((t) => t.id === "personal")?.tokens.wordmark === "");
    check("getSenderSettingsView returns the raw override", (await getSenderSettingsView(A)).brandName === "Acme Support");
  } finally {
    await clean();
    await superPool.end();
  }

  if (failures) { console.error(`\nEMAIL-SENDER: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nEMAIL-SENDER: all checks green");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
