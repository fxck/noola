import type { FastifyReply, FastifyRequest } from "fastify";
import { tenantIpAllowed } from "../governance.js";

// Tenant is derived ONLY from the authenticated session (server-authoritative — never a
// client-supplied header/query/body). The global auth gate guarantees a session on every
// non-public route, so a missing tenant here means an un-gated caller (a bug). `tenanted`
// wraps a handler that needs the tenant, resolving it once and 400-ing when absent — this
// replaces the `const tenantId = tenantOf(req); if (!tenantId) return 400` boilerplate that
// otherwise repeats on every business route.

/** The tenant on the request's session, or undefined for an un-gated/public caller. */
export function tenantOf(req: FastifyRequest): string | undefined {
  return req.session?.tenantId;
}

/** Wrap a handler that requires a tenant. The wrapped handler receives the resolved tenantId
 *  as its first argument; a tenant-less request short-circuits with 400 "missing tenant". */
export function tenanted<T>(
  handler: (tenantId: string, req: FastifyRequest, reply: FastifyReply) => T | Promise<T>,
): (req: FastifyRequest, reply: FastifyReply) => Promise<T | undefined> {
  return async (req, reply) => {
    const tenantId = req.session?.tenantId;
    if (!tenantId) {
      await reply.code(400).send({ error: "missing tenant" });
      return undefined;
    }
    // Workspace IP allowlist (0092): every agent-console route funnels through here, so this
    // is the one enforcement point. Cached per tenant (~30s); internal/loopback IPs always
    // pass (see governance.ts) so infra traffic and dev servers can never lock out.
    if (!(await tenantIpAllowed(tenantId, req.ip))) {
      await reply.code(403).send({ error: "ip_not_allowed", detail: "This workspace restricts console access by IP." });
      return undefined;
    }
    return handler(tenantId, req, reply);
  };
}
