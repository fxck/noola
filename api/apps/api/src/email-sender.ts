import { withTenant } from "@repo/db";

// Teammate sending identity (0104) — Intercom's "sending address" parity. Per tenant, choose which
// address outbound ticket replies are FROM:
//   'shared'   — always the support address, with the teammate's name as the From display name
//                ("Aleš from Zerops" <support@zerops.io>). Default.
//   'teammate' — the replying teammate's OWN address (ales@zerops.io) when that domain is a verified
//                sending domain; otherwise fall back to the shared support address.
//
// The per-ticket Reply-To + Message-ID stay on the SUPPORT address regardless (the caller owns that),
// so inbound routing/threading never depend on who a reply is From. Provider-agnostic: this is purely
// the From header, so it applies whether the tenant sends via Resend or SendGrid.

export type EmailSenderMode = "shared" | "teammate";

interface SenderConfig {
  mode: EmailSenderMode;
  workspace: string; // tenant display name, e.g. "Zerops"
  verifiedDomains: Set<string>; // lowercased domains with a verified sending domain
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; cfg: SenderConfig }>();

export function bustSenderCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

async function loadSenderConfig(tenantId: string): Promise<SenderConfig> {
  return withTenant(tenantId, async (c) => {
    // One connection — queries must be sequential (pg forbids concurrent queries on a single client).
    const m = await c.query("SELECT mode FROM email_sender_settings WHERE tenant_id = current_tenant()");
    const w = await c.query("SELECT name FROM tenants WHERE id = current_tenant()");
    const d = await c.query("SELECT domain FROM email_sending_domains WHERE status = 'verified'");
    const mode: EmailSenderMode = m.rowCount && m.rows[0].mode === "teammate" ? "teammate" : "shared";
    const workspace = (w.rowCount ? ((w.rows[0].name as string) ?? "") : "").trim() || "Support";
    const verifiedDomains = new Set((d.rows as { domain: string }[]).map((x) => x.domain.toLowerCase()));
    return { mode, workspace, verifiedDomains };
  });
}

async function senderConfig(tenantId: string): Promise<SenderConfig> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cfg;
  const cfg = await loadSenderConfig(tenantId);
  cache.set(tenantId, { at: Date.now(), cfg });
  return cfg;
}

export interface FromIdentity {
  name?: string;
  address: string;
}

/**
 * Resolve the From header for an outbound reply. Display name is always "<teammate> from <workspace>"
 * (or just the workspace for AI/automated replies with no agentName). The address is the teammate's own
 * (teammate mode + their domain verified for sending) or the shared support address otherwise — so a
 * reply from a teammate whose email is on an unverified domain still sends cleanly from support@,
 * just with their name. Never sends from an unverified domain (DKIM would fail).
 */
export async function resolveFromIdentity(
  tenantId: string,
  supportAddress: string,
  opts: { agentName?: string | null; agentEmail?: string | null },
): Promise<FromIdentity> {
  const cfg = await senderConfig(tenantId);
  const agent = opts.agentName?.trim();
  const name = agent ? `${agent} from ${cfg.workspace}` : cfg.workspace;
  if (cfg.mode === "teammate" && opts.agentEmail) {
    const addr = opts.agentEmail.trim().toLowerCase();
    const domain = addr.split("@")[1];
    if (domain && cfg.verifiedDomains.has(domain)) return { name, address: addr };
  }
  return { name, address: supportAddress };
}

// ---- settings CRUD --------------------------------------------------------

export async function getSenderMode(tenantId: string): Promise<EmailSenderMode> {
  return (await senderConfig(tenantId)).mode;
}

/** UI view: current mode + whether teammate mode is actually usable (needs a verified sending domain). */
export async function getSenderSettingsView(
  tenantId: string,
): Promise<{ mode: EmailSenderMode; hasVerifiedDomain: boolean; workspace: string }> {
  const cfg = await senderConfig(tenantId);
  return { mode: cfg.mode, hasVerifiedDomain: cfg.verifiedDomains.size > 0, workspace: cfg.workspace };
}

export async function setSenderMode(tenantId: string, mode: EmailSenderMode): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO email_sender_settings (tenant_id, mode) VALUES (current_tenant(), $1)
       ON CONFLICT (tenant_id) DO UPDATE SET mode = $1, updated_at = now()`,
      [mode],
    );
  });
  bustSenderCache(tenantId);
}
