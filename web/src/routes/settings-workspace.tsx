import { useEffect, useRef, useState } from "react";
import { Building2, Clock, Loader2, Network, ShieldCheck, Upload, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/auth/auth";
import { fetchPolicies, savePolicies, type TenantPolicies } from "@/lib/settings";
import { SettingsPage } from "@/components/settings-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toaster";
import { api } from "@/lib/api";
import { avatarSrc } from "@/lib/avatar-upload";

// Workspace identity — the name teammates and customers see, plus a logo — and the
// governance policies (0092): data retention, console IP allowlist, required 2FA. The
// better-auth organization row is the identity authority; policies live in tenant_policies.

interface Workspace {
  name: string;
  logoUrl: string | null;
}

export function SettingsWorkspacePage() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const fileRef = useRef<HTMLInputElement>(null);

  function load() {
    setStatus("loading");
    api<Workspace>("/settings/workspace")
      .then((w) => {
        setWs(w);
        setName(w.name);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  const dirty = ws != null && name.trim() !== ws.name && name.trim().length >= 2;

  async function save(patch: { name?: string; logo?: string | null }) {
    setSaving(true);
    try {
      const w = await api<Workspace>("/settings/workspace", { method: "PATCH", body: JSON.stringify(patch) });
      setWs(w);
      setName(w.name);
      toast.success("Workspace updated.");
    } catch {
      toast.error("Couldn't update the workspace.");
    } finally {
      setSaving(false);
    }
  }

  function pickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Logo must be under 2MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => void save({ logo: String(reader.result) });
    reader.readAsDataURL(file);
  }

  return (
    <SettingsPage
      active="workspace"
      title="Workspace"
      description="Your workspace's name and logo — what your team (and customers, where branding shows) see."
      status={status}
      onRetry={load}
      errorTitle="Couldn't load the workspace settings"
      actions={
        <Button size="sm" className="h-8" disabled={!dirty || saving} onClick={() => void save({ name: name.trim() })}>
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
        {ws && (
          <div className="space-y-6 rounded-xl border bg-card p-6 shadow-sm">
            {/* Logo + upload control */}
            <div className="flex items-center gap-4">
              {ws.logoUrl ? (
                <img
                  src={avatarSrc(ws.logoUrl) ?? undefined}
                  alt="Workspace logo"
                  className="size-16 rounded-xl border object-cover"
                />
              ) : (
                <span className="grid size-16 place-items-center rounded-xl border bg-muted/40 text-muted-foreground">
                  <Building2 className="size-6" />
                </span>
              )}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="gap-1.5" disabled={saving} onClick={() => fileRef.current?.click()}>
                    <Upload className="size-3.5" /> {ws.logoUrl ? "Change logo" : "Upload logo"}
                  </Button>
                  {ws.logoUrl && (
                    <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" disabled={saving} onClick={() => void save({ logo: null })}>
                      <X className="size-3.5" /> Remove
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">PNG, JPG, WebP or SVG up to 2MB. Square works best.</p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={pickLogo}
              />
            </div>

            {/* Workspace name */}
            <div className="space-y-1.5">
              <Label htmlFor="ws-name">Workspace name</Label>
              <Input
                id="ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Support"
                autoComplete="off"
                className="max-w-sm"
              />
              <p className="text-xs text-muted-foreground">Shown in the console header, invites and customer-facing branding.</p>
            </div>
          </div>
        )}

        <PoliciesCards />
      </div>
    </SettingsPage>
  );
}

// ── Governance policies (0092) — admin-gated; viewers see the current state ──
function PoliciesCards() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const [policies, setPolicies] = useState<TenantPolicies | null>(null);
  const [retention, setRetention] = useState("");
  const [ips, setIps] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchPolicies()
      .then((p) => {
        setPolicies(p);
        setRetention(p.retentionDays == null ? "" : String(p.retentionDays));
        setIps(p.ipAllowlist.join("\n"));
      })
      .catch(() => setPolicies(null));
  }, []);

  async function save(patch: Partial<TenantPolicies>) {
    setBusy(true);
    try {
      const p = await savePolicies(patch);
      setPolicies(p);
      setRetention(p.retentionDays == null ? "" : String(p.retentionDays));
      setIps(p.ipAllowlist.join("\n"));
      toast.success("Policy saved.");
    } catch (err) {
      toast.error((err as { detail?: string }).detail || "Couldn't save that policy.");
    } finally {
      setBusy(false);
    }
  }

  if (!policies) return null;

  const retentionDirty = retention !== (policies.retentionDays == null ? "" : String(policies.retentionDays));
  const ipsDirty = ips.split("\n").map((s) => s.trim()).filter(Boolean).join("\n") !== policies.ipAllowlist.join("\n");

  return (
    <div className="mt-6 space-y-6">
      {/* Data retention */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Clock className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Data retention</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Closed conversations older than this window are permanently deleted — messages and
              attachments included. Leave empty to keep everything forever.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Input
                inputMode="numeric"
                placeholder="e.g. 365"
                className="h-8 w-28"
                value={retention}
                disabled={!isAdmin}
                onChange={(e) => setRetention(e.target.value.replace(/\D/g, ""))}
              />
              <span className="text-xs text-muted-foreground">days (7–3650)</span>
              {isAdmin && retentionDirty && (
                <Button size="sm" variant="outline" className="h-8" disabled={busy}
                  onClick={() => void save({ retentionDays: retention === "" ? null : Number(retention) })}>
                  Save
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* IP allowlist */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Network className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Console IP allowlist</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              One IP or CIDR per line (e.g. 203.0.113.7 or 198.51.100.0/24). When set, the agent
              console only answers from these addresses — public surfaces (widget, webhooks) are
              unaffected. Your current IP must be on the list; the save refuses a list that would
              lock you out.
            </p>
            <textarea
              className="mt-3 h-24 w-full max-w-sm resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              placeholder={"203.0.113.7\n198.51.100.0/24"}
              value={ips}
              disabled={!isAdmin}
              onChange={(e) => setIps(e.target.value)}
            />
            {isAdmin && ipsDirty && (
              <div>
                <Button size="sm" variant="outline" className="h-8" disabled={busy}
                  onClick={() => void save({ ipAllowlist: ips.split("\n").map((s) => s.trim()).filter(Boolean) })}>
                  Save allowlist
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Require 2FA */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <ShieldCheck className="size-4.5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Require two-factor authentication</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Ask every member to enroll in 2FA. Members who haven't are flagged on the Members
                page; each person enables it under Settings → Profile.
              </p>
            </div>
          </div>
          <Switch
            checked={policies.require2fa}
            disabled={!isAdmin || busy}
            onCheckedChange={(v) => void save({ require2fa: v })}
          />
        </div>
      </div>
    </div>
  );
}
