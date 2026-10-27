import crypto from "node:crypto";

// Secret box for at-rest encryption of per-tenant provider API keys. AES-256-GCM
// (authenticated) with a 32-byte key derived from MODEL_KEY_SECRET via SHA-256, so
// the operator supplies any-length secret. Stored format: "v1:<ivB64>:<tagB64>:<ctB64>".
// Without MODEL_KEY_SECRET, encryption is unavailable and storing a key is refused
// upstream (modelconfig.ts) — we never fall back to plaintext.

function key(): Buffer | null {
  const s = process.env.MODEL_KEY_SECRET;
  if (!s) return null;
  return crypto.createHash("sha256").update(s).digest();
}

export function encryptionAvailable(): boolean {
  return key() !== null;
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) throw new Error("MODEL_KEY_SECRET not set — cannot encrypt");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt a stored cipher blob. Returns null if the key is missing, the format is
 *  wrong, or authentication fails (tampered / wrong key) — callers degrade safely. */
export function decryptSecret(blob: string): string | null {
  const k = key();
  if (!k) return null;
  const [v, ivB64, tagB64, ctB64] = blob.split(":");
  if (v !== "v1" || !ivB64 || !tagB64 || !ctB64) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
