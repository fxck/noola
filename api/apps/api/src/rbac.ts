// ── RBAC (Track A) ───────────────────────────────────────────────────────────
// Role hierarchy: viewer < agent < admin < owner. The request role is better-auth's LIVE
// org-scoped member.role (resolved in betterauth.ts on every request), so a downgrade takes
// effect on the caller's next request — no session revocation needed (studio-auth-migration-plan
// §4.2). Enforcement is a single global floor gate wired in server.ts, mirroring the
// PUBLIC_ROUTES pattern rather than decorating each route:
//   • admin surfaces (settings / integrations / member + invite management) → admin+
//   • every other business mutation (POST/PUT/PATCH/DELETE) → agent+
//   • reads (GET/HEAD) → viewer+ (any authenticated member)
// Net: day-to-day agent work stays open, config + team management lock to admins, and `viewer`
// is genuinely read-only everywhere. Tenant isolation (RLS) is unchanged and orthogonal — this
// is the authorization layer on top of it.

export const ROLE_RANK: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };

/** True when `role` ranks at least `min` in the hierarchy. An unknown role ranks below
 *  everything (deny-by-default); an unknown `min` is treated as unsatisfiable. */
export function roleAtLeast(role: string | undefined | null, min: string): boolean {
  return (ROLE_RANK[role ?? ""] ?? -1) >= (ROLE_RANK[min] ?? 99);
}

// Admin-only surfaces, keyed as "METHOD /routeOptions.url" (the param-templated url, e.g.
// "DELETE /webhooks/:id"). Config, integration/channel bindings, mass-send, and team
// management. GET siblings stay readable by agents — only the mutating/admin actions are here.
export const ADMIN_ROUTES = new Set<string>([
  // Settings / policy
  "PUT /settings/model",
  "PUT /autoreply/policy",
  "POST /topics/reclassify",
  // Integration + channel bindings
  "POST /discord/link",
  "POST /discord/classification",
  "POST /discord/agent-identity",
  "POST /email/link",
  "POST /slack/connections",
  "DELETE /slack/connections/:id",
  // Outbound webhooks (secret-bearing)
  "POST /webhooks",
  "PATCH /webhooks/:id",
  "DELETE /webhooks/:id",
  "POST /webhooks/:id/test",
  // Broadcast mass-send (high blast radius; compose/list stay agent+)
  "POST /broadcasts/:id/send",
  // Member + invite management (routes added in the invites slices)
  "GET /members/invites",
  "POST /members/invites",
  "DELETE /members/invites/:id",
  "GET /members/invite-links",
  "POST /members/invite-links",
  "DELETE /members/invite-links/:token",
  "PATCH /members/:id/role",
  "DELETE /members/:id",
  // Integrations (secret-bearing connectors) — reads stay viewer+, config locks to admin
  "POST /integrations",
  "PATCH /integrations/:id",
  "DELETE /integrations/:id",
  "POST /integrations/:id/test",
  // Automations (rules engine) — reads/run-history viewer+, authoring locks to admin. Running a
  // flow (test/execute) and ad-hoc agent runs are NOT here: they're governed by RBAC-by-effect
  // (EFFECT_GATED_ROUTES below + the per-flow effect check in the handlers), so a viewer can run a
  // read-only flow while update/mixed flows stay gated by the tool effect, not a blanket admin lock.
  "POST /automations",
  "POST /automations/author",
  "PATCH /automations/:id",
  "DELETE /automations/:id",
  // API keys are secret server-to-server credentials — mint/list/revoke is admin-only.
  "GET /api-keys",
  "POST /api-keys",
  "DELETE /api-keys/:id",
  // SLA policy governs the whole workspace — changing it is admin (GET stays viewer+).
  "PUT /settings/sla",
  // Routing & assignment rules shape the whole queue — authoring is admin (GET stays viewer+).
  "POST /routing-rules",
  "PATCH /routing-rules/:id",
  "DELETE /routing-rules/:id",
  // Teams shape the workspace's ops structure — authoring is admin (GET stays viewer+).
  "POST /teams",
  "PATCH /teams/:id",
  "DELETE /teams/:id",
  // Per-agent routing signals (skills/OOO/load cap) redirect the whole queue — admin.
  "PATCH /users/:id/routing",
  // Auto-survey toggles are a workspace policy — changing them is admin (GET stays viewer+).
  "PUT /settings/surveys",
  // Enterprise SSO connections carry IdP secrets — authoring is admin (GET stays viewer+; the
  // public discover/start/callback lanes are session-less and handled by PUBLIC_ROUTES).
  "POST /sso-connections",
  "PATCH /sso-connections/:id",
  "DELETE /sso-connections/:id",
  // Custom-field DEFINITIONS are a schema change (admin). Reading defs + writing a ticket's
  // values (PUT /tickets/:id/custom-values) stay agent-level day-to-day work.
  "POST /custom-fields",
  "PATCH /custom-fields/:id",
  "DELETE /custom-fields/:id",
  // Ticket-type DEFINITIONS are the tenant's taxonomy (admin). Setting a ticket's type is
  // done via PATCH /tickets/:id (agent-level), not here.
  "POST /ticket-types",
  "PATCH /ticket-types/:id",
  "DELETE /ticket-types/:id",
  // Audit log is a compliance surface — reading it (and verifying the tamper-evident chain)
  // is admin-only. These are GETs, so without this they'd fall to the viewer floor.
  "GET /audit",
  "GET /audit/verify",
  // Agent persona sets the assistant's voice across every AI draft — an admin-owned setting.
  "PUT /persona",
]);

// Flow-execution routes governed by RBAC-by-effect (dogfood L3-E3): the global floor only lets any
// authenticated member THROUGH (viewer), and the handler then requires the role matching the flow's
// strongest tool effect (EFFECT_MIN_ROLE in automations.ts). This is what lets a viewer run a
// read-only flow while an update/mixed flow still demands agent/admin — a blanket floor can't
// express "depends on what the flow does".
export const EFFECT_GATED_ROUTES = new Set<string>([
  "POST /automations/:id/test",
  "POST /automations/:id/execute",
  "POST /tickets/:id/agent-run",
]);

/**
 * The minimum role a gated route requires. Public / auth / better-auth lanes are handled by
 * the caller (they never reach here). ADMIN_ROUTES → admin; effect-gated exec routes → viewer
 * (the handler refines by flow effect); any other mutation → agent; reads → viewer.
 */
export function routeFloor(method: string, routeUrl: string): "admin" | "agent" | "viewer" {
  const key = `${method} ${routeUrl}`;
  if (ADMIN_ROUTES.has(key)) return "admin";
  if (EFFECT_GATED_ROUTES.has(key)) return "viewer";
  if (method === "GET" || method === "HEAD") return "viewer";
  return "agent";
}
