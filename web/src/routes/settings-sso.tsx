import { useEffect, useState } from "react";
import { ShieldCheck, Plus, Trash2, Pencil, Check, Loader2, AlertTriangle } from "lucide-react";
import { SettingsPage } from "@/components/settings-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import {
  type SsoConnection,
  type SsoConnectionInput,
  type SsoProvider,
  fetchSsoConnections,
  createSsoConnection,
  updateSsoConnection,
  deleteSsoConnection,
} from "@/lib/sso";

interface Draft extends SsoConnectionInput {
  id: string | null;
}

const EMPTY: Draft = {
  id: null,
  provider: "oidc",
  name: "",
  emailDomain: "",
  issuer: "",
  authorizeUrl: "",
  tokenUrl: "",
  jwksUrl: "",
  clientId: "",
  clientSecret: "",
  enabled: true,
};

export function SettingsSsoPage() {
  const [conns, setConns] = useState<SsoConnection[] | null>(null);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    setError(false);
    fetchSsoConnections().then(setConns).catch(() => setError(true));
  }
  useEffect(load, []);

  function edit(c: SsoConnection) {
    setDraft({
      id: c.id,
      provider: c.provider,
      name: c.name,
      emailDomain: c.email_domain,
      issuer: c.issuer ?? "",
      authorizeUrl: c.authorize_url ?? "",
      tokenUrl: c.token_url ?? "",
      jwksUrl: c.jwks_url ?? "",
      clientId: c.client_id ?? "",
      clientSecret: "", // write-only; blank keeps the stored secret
      enabled: c.enabled,
    });
  }

  async function toggle(c: SsoConnection) {
    setConns((cs) => cs?.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)) ?? null);
    try {
      await updateSsoConnection(c.id, { enabled: !c.enabled });
    } catch {
      toast.error("Couldn't update the connection.");
      load();
    }
  }

  async function remove(c: SsoConnection) {
    setConns((cs) => cs?.filter((x) => x.id !== c.id) ?? null);
    try {
      await deleteSsoConnection(c.id);
      toast.success("SSO connection removed.");
    } catch {
      toast.error("Couldn't remove the connection.");
      load();
    }
  }

  async function save() {
    if (!draft || !draft.name.trim() || !draft.emailDomain.trim()) return;
    setSaving(true);
    const payload: SsoConnectionInput = {
      provider: draft.provider,
      name: draft.name.trim(),
      emailDomain: draft.emailDomain.trim(),
      issuer: draft.issuer || null,
      authorizeUrl: draft.authorizeUrl || null,
      tokenUrl: draft.tokenUrl || null,
      jwksUrl: draft.jwksUrl || null,
      clientId: draft.clientId || null,
      enabled: draft.enabled,
      ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
    };
    try {
      if (draft.id) await updateSsoConnection(draft.id, payload);
      else await createSsoConnection(payload);
      toast.success(draft.id ? "Connection updated." : "Connection created.");
      setDraft(null);
      load();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? "Couldn't save the connection.");
    } finally {
      setSaving(false);
    }
  }

  const set = (patch: Partial<Draft>) => draft && setDraft({ ...draft, ...patch });

  return (
    <SettingsPage
      active="sso"
      title="Single sign-on"
      description="Connect your identity provider (OIDC / SAML) — people whose email matches a connection's domain get a “Sign in with SSO” button on the login page."
      actions={
        !draft && (
          <Button size="sm" className="h-8" onClick={() => setDraft({ ...EMPTY })}>
            <Plus /> Add connection
          </Button>
        )
      }
    >
          <div className="max-w-2xl px-6 pb-10 pt-4">
            {draft && (
              <div className="mb-6 space-y-4 rounded-xl border bg-card p-5 shadow-sm">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="sname">Display name</Label>
                    <Input id="sname" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Okta / Azure AD / Google" autoFocus />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sdom">Email domain</Label>
                    <Input id="sdom" value={draft.emailDomain} onChange={(e) => set({ emailDomain: e.target.value })} placeholder="acme.com" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Protocol</Label>
                  <div className="flex gap-1.5">
                    {(["oidc", "saml"] as SsoProvider[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => set({ provider: p })}
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-medium uppercase transition-colors",
                          draft.provider === p ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="siss">Issuer / Entity ID</Label>
                    <Input id="siss" value={draft.issuer ?? ""} onChange={(e) => set({ issuer: e.target.value })} placeholder="https://idp.example.com" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sauth">Authorize / SSO URL</Label>
                    <Input id="sauth" value={draft.authorizeUrl ?? ""} onChange={(e) => set({ authorizeUrl: e.target.value })} placeholder="https://idp.example.com/authorize" />
                  </div>
                  {draft.provider === "oidc" && (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="stok">Token URL</Label>
                        <Input id="stok" value={draft.tokenUrl ?? ""} onChange={(e) => set({ tokenUrl: e.target.value })} placeholder="https://idp.example.com/token" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="sjwks">JWKS URL</Label>
                        <Input id="sjwks" value={draft.jwksUrl ?? ""} onChange={(e) => set({ jwksUrl: e.target.value })} placeholder="https://idp.example.com/.well-known/jwks.json" />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2 -mt-1">
                        <p className="text-micro text-muted-foreground">Provide Authorize + Token + JWKS URLs to configure the provider explicitly (skips OIDC auto-discovery).</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="scid">Client ID</Label>
                        <Input id="scid" value={draft.clientId ?? ""} onChange={(e) => set({ clientId: e.target.value })} />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="scsec">Client secret {draft.id && <span className="font-normal text-muted-foreground">(leave blank to keep current)</span>}</Label>
                        <Input id="scsec" type="password" value={draft.clientSecret ?? ""} onChange={(e) => set({ clientSecret: e.target.value })} placeholder="••••••••" />
                      </div>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={() => void save()} disabled={saving || !draft.name.trim() || !draft.emailDomain.trim()}>
                    {saving ? <><Loader2 className="animate-spin motion-reduce:animate-none" /> Saving…</> : <><Check /> {draft.id ? "Update" : "Create"}</>}
                  </Button>
                  <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                </div>
              </div>
            )}

            {error ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <AlertTriangle className="size-7 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">Couldn't load SSO connections.</p>
                <Button variant="outline" size="sm" onClick={load}>Try again</Button>
              </div>
            ) : conns === null ? (
              <div className="grid place-items-center py-16"><Spinner /></div>
            ) : conns.length === 0 && !draft ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
                <ShieldCheck className="size-8 text-muted-foreground/30" />
                <p className="text-sm font-medium">No SSO connections</p>
                <p className="max-w-sm text-sm text-muted-foreground">Add your identity provider to let your team sign in with SSO.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {conns.map((c) => (
                  <li key={c.id} className={cn("flex items-center gap-3 rounded-xl border bg-card p-4", !c.enabled && "opacity-60")}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{c.name}</span>
                        <span className="text-micro font-medium uppercase text-muted-foreground">{c.provider}</span>
                        {c.has_secret && (
                          <span className="flex items-center gap-1.5 text-micro text-muted-foreground">
                            <span className="size-1.5 rounded-full bg-success" aria-hidden /> secret set
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">@{c.email_domain}{c.issuer ? ` · ${c.issuer}` : ""}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Switch
                        checked={c.enabled}
                        aria-label={c.enabled ? "Disable" : "Enable"}
                        onCheckedChange={() => void toggle(c)}
                      />
                      <Button variant="ghost" size="icon" className="size-8" onClick={() => edit(c)} aria-label="Edit"><Pencil className="size-4" /></Button>
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" onClick={() => void remove(c)} aria-label="Delete"><Trash2 className="size-4" /></Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
    </SettingsPage>
  );
}
