import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt) as (pw: string | Buffer, salt: Buffer, keylen: number) => Promise<Buffer>;

// ---- Passwords (scrypt) -------------------------------------------------
// Format "scrypt$<saltHex>$<hashHex>". better-auth's password bridge (betterauth.ts) hashes
// and verifies through these, and migrate.ts seeds demo creds with the SAME scheme — keep
// all three in sync. This is the only surviving piece of the pre-better-auth auth module:
// the Valkey session store + the login/user-lookup flow were removed when better-auth became
// the SOLE auth authority (Track A #2, Slice 3 — the flip). The session is now resolved from
// the Bearer token by better-auth in betterauth.ts.
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
}
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const dk = await scrypt(pw, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

// ---- Session ------------------------------------------------------------
// The shape the request pipeline carries. Resolved from the Bearer token by better-auth
// (resolveBetterAuthSession in betterauth.ts) and read via req.session / tenantOf() in
// server.ts. tenantId == the active organization id == the tenant uuid; role is the
// org-scoped member role (owner/admin/agent/viewer).
export interface Session {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
  name: string;
}
