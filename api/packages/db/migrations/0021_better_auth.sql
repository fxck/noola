-- Slice-1 (Track A #2) — better-auth schema, DORMANT + SCHEMA-ONLY. Superuser, idempotent.
--
-- WHY: land better-auth's identity tables + studio's org_invite_link WITHOUT mounting
-- better-auth and WITHOUT changing any application behavior. The legacy `tenants`/`users`
-- tables stay authoritative; this migration ONLY adds the auth surface + a dedicated
-- least-privilege role. Fully additive → rollback = drop the new tables + the auth_user
-- role. Nothing here writes, alters, or reads any existing app table, and nothing touches
-- their RLS.
--
-- NO TRIGGERS / NO SEED / NO PROJECTION IN THIS SLICE. An earlier draft wired §1.5
-- SECURITY DEFINER projection triggers (organization→tenants, member→users, user→users)
-- and a legacy→better-auth seed into Slice 1. A 5-lens adversarial review (2026-07-06)
-- found real isolation defects in that approach, ALL of which only matter once better-auth
-- actually writes these tables (Slice 2+):
--   * an owner-run, RLS-bypassing UPDATE users … WHERE id=… with NO tenant predicate
--     (cross-tenant PII write the moment the global email-unique guard relaxes for multi-org);
--   * auth_user effectively gaining RLS-bypassing app-table writes via triggers it fires
--     (contradicts least-privilege);
--   * member.role copied verbatim into the authz users.role (role-confusion / priv-esc);
--   * a seed owner-promotion that irreversibly mutates authoritative users.role.
-- So the projection is deferred to a REDESIGNED Slice 2 (outbox/relay-driven, tenant-scoped,
-- role-mapped, with the email-unique-vs-multi-org question resolved first). See
-- /var/www/studio-auth-migration-plan.md §9 for the Slice-2 requirements. This slice is the
-- clean, reversible schema checkpoint better-auth (Slice 2) mounts against.
--
-- RLS: the 8 tables below are deliberately RLS-EXEMPT (no ENABLE/FORCE). better-auth needs
-- cross-tenant reads BEFORE any active org exists — login-by-email, org list, member lookup,
-- invite acceptance — so a tenant-GUC default-deny would break them. They are reachable ONLY
-- by the dedicated auth_user role (below); the request-path roles (app_user, event_relay) get
-- no grant, so session tokens / password hashes are never exposed to app code.
--
-- IDs: every id/token/FK column is `text` (better-auth's model). A future mounted better-auth
-- MUST generate UUID-shaped ids (advanced.database.generateId: () => crypto.randomUUID()) so
-- organization.id::uuid == tenants.id holds when the Slice-2 projection lands.

-- ---- Role ----------------------------------------------------------------
-- auth_user : dedicated least-privilege principal for the identity surface. LOGIN, NO
-- BYPASSRLS (it must never step around app-table RLS), and it does NOT inherit event_relay's
-- outbox rights — identity and the outbox drainer stay separate principals. Created
-- password-less (cannot authenticate yet) — dormant in Slice 1; Slice 2 sets AUTH_DB_PASSWORD
-- from env in migrate.ts, like app_user/event_relay.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_user') THEN
    CREATE ROLE auth_user LOGIN;
  END IF;
END $$;

-- ---- better-auth tables (verbatim shape from studio/server/auth.ts) ----------
-- Identifiers are double-quoted camelCase (case-sensitive), matching better-auth's adapter
-- expectations. All id/FK columns are text.

CREATE TABLE IF NOT EXISTS "user" (
  "id"            text NOT NULL PRIMARY KEY,
  "name"          text NOT NULL,
  "email"         text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image"         text,
  "createdAt"     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "session" (
  "id"                   text NOT NULL PRIMARY KEY,
  "expiresAt"            timestamptz NOT NULL,
  "token"                text NOT NULL UNIQUE,
  "createdAt"            timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            timestamptz NOT NULL,
  "ipAddress"            text,
  "userAgent"            text,
  "userId"               text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  -- better-auth's organization plugin tracks the currently-selected org here.
  "activeOrganizationId" text
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");

CREATE TABLE IF NOT EXISTS "account" (
  "id"                    text NOT NULL PRIMARY KEY,
  "accountId"             text NOT NULL,
  "providerId"            text NOT NULL,
  "userId"                text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");

CREATE TABLE IF NOT EXISTS "verification" (
  "id"         text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value"      text NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS "organization" (
  "id"        text NOT NULL PRIMARY KEY,
  "name"      text NOT NULL,
  "slug"      text NOT NULL UNIQUE,
  "logo"      text,
  "createdAt" timestamptz NOT NULL,
  "metadata"  text
);
CREATE UNIQUE INDEX IF NOT EXISTS "organization_slug_uidx" ON "organization" ("slug");

CREATE TABLE IF NOT EXISTS "member" (
  "id"             text NOT NULL PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId"         text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "role"           text NOT NULL,
  "createdAt"      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "member_organizationId_idx" ON "member" ("organizationId");
CREATE INDEX IF NOT EXISTS "member_userId_idx"         ON "member" ("userId");
-- DEVIATION from studio: studio's `member` has NO (org,user) unique constraint and guards
-- duplicate memberships purely app-side (redeemInviteLink's WHERE NOT EXISTS). We turn that
-- into a real constraint so duplicate memberships are impossible at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS "member_org_user_uidx" ON "member" ("organizationId", "userId");

CREATE TABLE IF NOT EXISTS "invitation" (
  "id"             text NOT NULL PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "email"          text NOT NULL,
  "role"           text,
  "status"         text NOT NULL,
  "expiresAt"      timestamptz NOT NULL,
  "createdAt"      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "inviterId"      text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "invitation_organizationId_idx" ON "invitation" ("organizationId");
CREATE INDEX IF NOT EXISTS "invitation_email_idx"          ON "invitation" ("email");

-- ---- studio's own invite-link table (invites.ts) — NOT better-auth ------------
-- snake_case, unquoted; PK is the token itself. No FK on organization_id/created_by (joined
-- logically at query time). Partial index only over enabled links.
CREATE TABLE IF NOT EXISTS org_invite_link (
  token           text PRIMARY KEY,
  organization_id text NOT NULL,
  role            text NOT NULL DEFAULT 'member',
  created_by      text,
  expires_at      timestamptz,
  max_uses        integer,
  uses            integer NOT NULL DEFAULT 0,
  allowed_domain  text,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_invite_link_org_idx
  ON org_invite_link (organization_id) WHERE enabled;

-- ---- Grants (least privilege) --------------------------------------------
-- auth_user gets full DML on exactly the identity surface — nothing else. No app tables, no
-- outbox, no SECURITY DEFINER bridge (there are no triggers in this slice). No sequences to
-- grant (every key is text, not serial).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "user", "session", "account", "verification",
  "organization", "member", "invitation", org_invite_link
  TO auth_user;
