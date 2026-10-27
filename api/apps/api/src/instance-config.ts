// Self-hosted / single-tenant instance flags (PILOT-AND-DISCORD-PLAN Part 2). Each env toggle does
// exactly ONE thing and is independently testable; a self-hosted install sets all of them.
//  - DISABLE_WORKSPACE_SIGNUP=1 — no new workspaces: POST /auth/signup 403s AND better-auth's
//    native org-create endpoint is closed (allowUserToCreateOrganization). Member INVITES to the
//    existing workspace keep working — inviting a teammate is not a new workspace.
//  - DISABLE_DEMO_SEED=1 — migrate.ts skips the demo tenants/creds seed (read there directly;
//    packages/db can't import from the app).
// Read at call time (not module load) so tests can flip process.env.

export function workspaceSignupsEnabled(): boolean {
  return process.env.DISABLE_WORKSPACE_SIGNUP !== "1";
}

export function demoModeEnabled(): boolean {
  return process.env.DISABLE_DEMO_SEED !== "1";
}

/** The public, unauthenticated instance shape the SPA reads before login (P2). emailEnabled lets
 *  the UI be honest about invite/password-reset emails (without SMTP they silently no-op). */
export function publicInstanceConfig(): { signupsEnabled: boolean; demoMode: boolean; emailEnabled: boolean } {
  return {
    signupsEnabled: workspaceSignupsEnabled(),
    demoMode: demoModeEnabled(),
    emailEnabled: Boolean(process.env.SMTP_HOST),
  };
}
