import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import QRCode from "qrcode";
import { FormDialog } from "@/components/ui/form-dialog";
import { fetch2faStatus, enable2fa, confirm2fa, disable2fa } from "@/lib/twofactor";
import { setToken } from "@/lib/api";
import { SettingsPage } from "@/components/settings-page";
import { useAuth } from "@/auth/auth";
import { avatarSrc, uploadAvatar } from "@/lib/avatar-upload";
import { api, type ApiError } from "@/lib/api";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toaster";

// The account profile page — the signed-in user edits their own display name + photo. Read-only
// email and role are surfaced for reference (they're managed elsewhere / server-authoritative).
export function SettingsProfilePage() {
  const { user, refresh } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const nameDirty = name.trim() !== (user?.name ?? "") && name.trim().length > 0;
  const emailDirty = email.trim().toLowerCase() !== (user?.email ?? "").toLowerCase() && email.trim().length > 0;
  const dirty = nameDirty || emailDirty;

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setUploading(true);
    try {
      await uploadAvatar(file);
      await refresh(); // header + this page reflect the new photo
      toast.success("Photo updated.");
    } catch (err) {
      toast.error((err as Error).message || "Couldn't upload that photo. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function saveName() {
    if (!dirty) return;
    setSaving(true);
    try {
      await api<{ ok: boolean }>("/me/profile", {
        method: "PATCH",
        body: JSON.stringify({
          ...(nameDirty ? { name: name.trim() } : {}),
          ...(emailDirty ? { email: email.trim() } : {}),
        }),
      });
      await refresh();
      toast.success("Profile saved.");
    } catch (err) {
      toast.error((err as ApiError).detail || "Couldn't save your profile. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage
      active="profile"
      title="Profile"
      description="Your display name and photo — how you appear across the workspace."
      actions={
        <Button size="sm" className="h-8" onClick={() => void saveName()} disabled={!dirty || saving}>
          {saving ? (
            <>
              <Loader2 className="animate-spin" /> Saving…
            </>
          ) : (
            "Save changes"
          )}
        </Button>
      }
    >
      <div className="max-w-2xl px-6 pb-10 pt-4">
            <div className="space-y-6 rounded-xl border bg-card p-6 shadow-sm">
              {/* Avatar + photo control */}
              <div className="flex items-center gap-4">
                <div className="relative">
                  <Avatar
                    name={user?.name}
                    image={avatarSrc(user?.avatarUrl)}
                    className="size-20 text-2xl"
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    title="Change photo"
                    aria-label="Change photo"
                    className="absolute -bottom-1 -right-1 grid size-7 place-items-center rounded-full border border-input bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
                  >
                    {uploading ? (
                      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Camera className="size-3.5" />
                    )}
                  </button>
                </div>
                <div className="space-y-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? (
                      <>
                        <Loader2 className="animate-spin" /> Uploading…
                      </>
                    ) : user?.avatarUrl ? (
                      "Change photo"
                    ) : (
                      "Upload photo"
                    )}
                  </Button>
                  <p className="text-xs text-muted-foreground">JPG or PNG, resized to 256×256.</p>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => void onPickFile(e)}
                />
              </div>

              {/* Display name */}
              <div className="space-y-1.5">
                <Label htmlFor="name">Display name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>

              {/* Identity */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                  />
                  <p className="text-micro text-muted-foreground">Your sign-in address.</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Role</Label>
                  <p className="rounded-md border border-input bg-background px-3 py-2 text-sm capitalize text-muted-foreground">
                    {user?.role}
                  </p>
                </div>
              </div>
            </div>

            <TwoFactorCard />
          </div>
    </SettingsPage>
  );
}

// ── Two-factor authentication (0092) ─────────────────────────────────────────
// Enroll: password → QR (totpURI) + one-time backup codes → the first authenticator code
// confirms. Confirm rotates the server session — the response's replacement bearer is
// swapped in place so the user stays signed in. Disable is password-gated.
function TwoFactorCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<"enable" | "disable" | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const qrRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    void fetch2faStatus().then((s) => setEnabled(s.enabled)).catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    if (enrollment && qrRef.current) {
      void QRCode.toCanvas(qrRef.current, enrollment.totpURI, { width: 176, margin: 1 });
    }
  }, [enrollment]);

  function closeDialog() {
    setDialog(null);
    setPassword("");
    setCode("");
    setEnrollment(null);
  }

  async function onEnableSubmit() {
    setBusy(true);
    try {
      if (!enrollment) {
        // Step 1: password → secret + backup codes.
        setEnrollment(await enable2fa(password));
      } else {
        // Step 2: the first code confirms and rotates the session.
        const res = await confirm2fa(code);
        if (res.token) setToken(res.token);
        setEnabled(true);
        toast.success("Two-factor authentication is on.");
        closeDialog();
      }
    } catch (err) {
      toast.error((err as ApiError).detail || (enrollment ? "That code didn't work — try the next one." : "Wrong password."));
    } finally {
      setBusy(false);
    }
  }

  async function onDisableSubmit() {
    setBusy(true);
    try {
      await disable2fa(password);
      setEnabled(false);
      toast.success("Two-factor authentication is off.");
      closeDialog();
    } catch (err) {
      toast.error((err as ApiError).detail || "Wrong password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className={enabled ? "grid size-9 shrink-0 place-items-center rounded-lg bg-success/10 text-success" : "grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"}>
            {enabled ? <ShieldCheck className="size-4.5" /> : <ShieldOff className="size-4.5" />}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Two-factor authentication</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {enabled === null
                ? "Checking…"
                : enabled
                  ? "On — signing in asks for a code from your authenticator app."
                  : "Add a second step to sign-in: a 6-digit code from an authenticator app."}
            </p>
          </div>
        </div>
        {enabled !== null && (
          <Button variant="outline" size="sm" onClick={() => setDialog(enabled ? "disable" : "enable")}>
            {enabled ? "Turn off" : "Set up"}
          </Button>
        )}
      </div>

      <FormDialog
        open={dialog === "enable"}
        title={enrollment ? "Scan and confirm" : "Turn on two-factor auth"}
        description={
          enrollment
            ? "Scan the QR with your authenticator app, save the backup codes somewhere safe, then enter the first code it shows."
            : "Confirm your password to start."
        }
        onClose={closeDialog}
        onSubmit={() => void onEnableSubmit()}
        submitLabel={enrollment ? "Confirm" : "Continue"}
        submitDisabled={enrollment ? code.length < 6 : password.length === 0}
        busy={busy}
      >
        {!enrollment ? (
          <div className="space-y-1.5">
            <Label htmlFor="tfa-pass">Password</Label>
            <Input id="tfa-pass" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-center rounded-lg border bg-white p-3">
              <canvas ref={qrRef} />
            </div>
            <div>
              <Label>Backup codes</Label>
              <p className="mt-0.5 text-micro text-muted-foreground">One-time codes if you lose the app — shown only now.</p>
              <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border bg-muted/40 p-3 font-mono text-xs tabular-nums">
                {enrollment.backupCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tfa-code">Authenticator code</Label>
              <Input
                id="tfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </div>
          </div>
        )}
      </FormDialog>

      <FormDialog
        open={dialog === "disable"}
        title="Turn off two-factor auth"
        description="Confirm your password to remove the code step from sign-in."
        onClose={closeDialog}
        onSubmit={() => void onDisableSubmit()}
        submitLabel="Turn off"
        submitDisabled={password.length === 0}
        busy={busy}
      >
        <div className="space-y-1.5">
          <Label htmlFor="tfa-pass-off">Password</Label>
          <Input id="tfa-pass-off" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </FormDialog>
    </div>
  );
}
