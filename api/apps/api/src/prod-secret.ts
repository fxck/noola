// Fail-fast guard for signing/encryption secrets.
//
// Several secrets have a dev-convenience fallback (a hardcoded string or another project secret) so
// the app runs locally with zero config. In PRODUCTION that fallback is a footgun: the app would
// "boot fine" while signing sessions / email-reply tokens / the audit chain with a world-known key —
// silent session/token/audit forgery. Unlike the DB passwords (migrate.ts requireEnv already fails
// the deploy without them), these never surfaced.
//
// prodSecret() closes that gap: in production it REFUSES to boot with a missing or dev-default
// secret (throws at module load, the earliest possible failure); in dev/stage it returns the dev
// default so nothing changes. `value` is the already-resolved candidate (callers pass their own
// `A || B` precedence chain); `devDefault` is the literal that would otherwise leak into prod.
export function prodSecret(label: string, value: string | undefined, devDefault: string): string {
  if (value && value !== devDefault) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${label} must be set to a non-default value in production (NODE_ENV=production). ` +
        `Refusing to boot with an insecure default.`,
    );
  }
  return devDefault;
}
