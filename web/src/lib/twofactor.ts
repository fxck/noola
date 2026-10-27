import { api } from "./api";

// TOTP two-factor auth (0092). Enable is a 3-step dance: password → totpURI (QR) + backup
// codes → first code confirms. Confirm ROTATES the session server-side — the response carries
// the replacement bearer, which the caller must hand to auth.applySession-style storage.

export async function fetch2faStatus(): Promise<{ enabled: boolean }> {
  return api<{ enabled: boolean }>("/auth/2fa");
}

export async function enable2fa(password: string): Promise<{ totpURI: string; backupCodes: string[] }> {
  return api<{ totpURI: string; backupCodes: string[] }>("/auth/2fa/enable", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function confirm2fa(code: string): Promise<{ ok: boolean; token: string | null }> {
  return api<{ ok: boolean; token: string | null }>("/auth/2fa/confirm", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function disable2fa(password: string): Promise<void> {
  await api("/auth/2fa/disable", { method: "POST", body: JSON.stringify({ password }) });
}
