import { useEffect, useRef, useState } from "react";
import {
  Plug,
  Plus,
  Mail,
  Hash,
  MessageCircle,
  MessagesSquare,
  MessageSquare,
  Radio,
  Globe,
  Power,
  Send,
  Smartphone,
  Pencil,
  Trash2,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { SettingsPage } from "@/components/settings-page";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { buttonVariants } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import {
  type Integration,
  type IntegrationKind,
  fetchIntegrations,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  testIntegration,
} from "@/lib/integrations";
import {
  type ChannelStatus, fetchChannels,
  type ChannelConnection, fetchChannelConnections, saveTelegramConnection, saveWhatsAppConnection, deleteChannelConnection,
  type SlackConnection, fetchSlackConnections, saveSlackConnection, deleteSlackConnection,
  fetchEmailRoute, saveEmailRoute,
  type SendingDomain, type DnsRecord,
  fetchSendingDomains, addSendingDomain, verifySendingDomain, deleteSendingDomain,
} from "@/lib/settings";
import { Link } from "@tanstack/react-router";

// Channels & integrations — ONE page for the whole channel/connector surface. The former
// standalone Channels page (the inbound/outbound channel catalog with creds-gated states)
// is absorbed as the leading "Channels" section; the old "Connected channels" grid that
// repeated the same facts is gone (fact-once). Below it: the outbound-connector registry
// with its editor, test/toggle/remove actions. /settings/channels redirects here.

// ── Channels catalog (absorbed from the former Channels page) ───────────────

// Per-channel brand glyph keyed off id (D6). Falls back to the generic Radio mark.
const CHANNEL_GLYPH: Record<string, LucideIcon> = {
  discord: MessageCircle,
  slack: Hash,
  email: Mail,
  telegram: Send,
  whatsapp: MessageSquare,
  sms: Smartphone,
  widget: MessagesSquare,
  web: MessagesSquare,
};

function glyphFor(id: string): LucideIcon {
  return CHANNEL_GLYPH[id] ?? Radio;
}

function directionLabel(d: ChannelStatus["direction"]): string {
  return d === "both" ? "Inbound + outbound" : d === "inbound" ? "Inbound" : "Outbound";
}

type ChannelState = "connected" | "needs-creds" | "available";

function channelState(ch: ChannelStatus): ChannelState {
  if (ch.connected) return "connected";
  if (!ch.credentialed) return "needs-creds";
  return "available";
}

// The status-board vocabulary: a colored left-edge rail + a glyph tint driven off one
// state so a row reads at a glance. Amber stays reserved for the one real signal here —
// "needs credentials", the state that actually asks for operator action.
const STATE_META: Record<ChannelState, { rail: string; glyph: string }> = {
  connected: { rail: "bg-success", glyph: "text-success" },
  "needs-creds": { rail: "bg-warning", glyph: "text-warning" },
  available: { rail: "bg-border", glyph: "text-muted-foreground/60" },
};

// Quiet status text (chips are banned outside pickers): a small tinted dot + text for the
// two states that carry signal, plain muted text for "available".
function ChannelStatusNote({ state, connections }: { state: ChannelState; connections: number }) {
  if (state === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-micro font-medium text-success">
        <span className="size-1.5 rounded-full bg-success" aria-hidden /> Connected ·{" "}
        <span className="tabular-nums">{connections}</span>
      </span>
    );
  }
  if (state === "needs-creds") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-micro font-medium text-warning">
        <span className="size-1.5 rounded-full bg-warning" aria-hidden /> Needs credentials
      </span>
    );
  }
  return <span className="whitespace-nowrap text-micro font-medium text-muted-foreground">Available</span>;
}

// ── Outbound connectors ──────────────────────────────────────────────────────

// Colored left-edge rail per connector row (D6): the same status-board vocabulary the
// channel rows use — success when it's live, destructive when the last test failed,
// warning when configured-but-unverified, muted when disabled. Amber stays a signal.
function railFor(it: Integration): string {
  if (!it.enabled) return "bg-border";
  if (it.status === "error") return "bg-destructive";
  if (it.status === "ok") return "bg-success";
  return "bg-warning";
}

const RANK: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };

type KindMeta = {
  label: string;
  Icon: LucideIcon;
  secretLabel?: string;
  secretPlaceholder?: string;
  toField?: boolean;
  urlField?: boolean;
  blurb: string;
};

const KIND: Record<IntegrationKind, KindMeta> = {
  slack: {
    label: "Slack",
    Icon: Hash,
    secretLabel: "Incoming webhook URL",
    secretPlaceholder: "https://hooks.slack.com/services/…",
    blurb: "Post messages into a Slack channel via an incoming webhook.",
  },
  discord: {
    label: "Discord",
    Icon: MessageCircle,
    secretLabel: "Webhook URL",
    secretPlaceholder: "https://discord.com/api/webhooks/…",
    blurb: "Post messages into a Discord channel via a channel webhook.",
  },
  email: {
    label: "Email",
    Icon: Mail,
    toField: true,
    blurb: "Send an email alert to a fixed recipient.",
  },
  http: {
    label: "HTTP endpoint",
    Icon: Globe,
    urlField: true,
    secretLabel: "HMAC signing secret (optional)",
    secretPlaceholder: "used to sign the payload — optional",
    blurb: "POST a JSON payload to any endpoint, optionally HMAC-signed.",
  },
};

const KIND_OPTIONS = (Object.keys(KIND) as IntegrationKind[]).map((k) => ({
  value: k,
  label: KIND[k].label,
  icon: KIND[k].Icon,
}));

function statusBadge(s: string): { variant: "default" | "warning" | "muted" | "outline"; label: string } {
  if (s === "ok") return { variant: "default", label: "Ready" };
  if (s === "error") return { variant: "warning", label: "Error" };
  return { variant: "muted", label: "Not configured" };
}

interface Draft {
  id: string | null; // null = new
  kind: IntegrationKind;
  name: string;
  to: string;
  url: string;
  method: string;
  secret: string;
  hadSecret: boolean;
}

function emptyDraft(): Draft {
  return { id: null, kind: "slack", name: "", to: "", url: "", method: "POST", secret: "", hadSecret: false };
}

function draftFrom(it: Integration): Draft {
  return {
    id: it.id,
    kind: (it.kind as IntegrationKind) ?? "http",
    name: it.name,
    to: typeof it.config.to === "string" ? (it.config.to as string) : "",
    url: typeof it.config.url === "string" ? (it.config.url as string) : "",
    method: typeof it.config.method === "string" ? (it.config.method as string) : "POST",
    secret: "",
    hadSecret: it.hasSecret,
  };
}

export function SettingsIntegrationsPage() {
  const { user } = useAuth();
  const isAdmin = (RANK[user?.role ?? ""] ?? -1) >= RANK.admin;

  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [catalog, setCatalog] = useState<ChannelStatus[] | null>(null);
  // Self-serve channel connections (0092): the tenant's own Telegram/WhatsApp creds + Slack
  // workspace links, edited straight from the catalog rows below.
  const [connections, setConnections] = useState<ChannelConnection[]>([]);
  const [slackConns, setSlackConns] = useState<SlackConnection[]>([]);
  const [connectDialog, setConnectDialog] = useState<"telegram" | "whatsapp" | "slack" | "email" | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  // Email support/from address (email_routes) — the outbound From for ticket replies.
  const [emailAddr, setEmailAddr] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [waToken, setWaToken] = useState("");
  const [waPhoneId, setWaPhoneId] = useState("");
  const [waVerify, setWaVerify] = useState("");
  const [slTeam, setSlTeam] = useState("");
  const [slToken, setSlToken] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Integration | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useRef(async () => {
    setLoadError(false);
    try {
      const [r, chs, conns, slacks, emailRoute] = await Promise.all([
        fetchIntegrations(),
        fetchChannels(),
        fetchChannelConnections().catch(() => []),
        fetchSlackConnections().catch(() => []),
        fetchEmailRoute().catch(() => ({ address: null })),
      ]);
      setIntegrations(r.integrations);
      setCatalog(chs);
      setConnections(conns);
      setSlackConns(slacks);
      setEmailAddr(emailRoute.address);
    } catch {
      setLoadError(true);
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  const loading = (integrations === null || catalog === null) && !loadError;
  const meta = draft ? KIND[draft.kind] : null;

  async function onSave() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error("Give the connector a name.");
      return;
    }
    const config: Record<string, unknown> = {};
    if (meta?.toField) config.to = draft.to.trim();
    if (meta?.urlField) {
      config.url = draft.url.trim();
      config.method = draft.method;
    }
    setSaving(true);
    try {
      if (draft.id) {
        await updateIntegration(draft.id, {
          name,
          config,
          ...(draft.secret ? { secret: draft.secret } : {}),
        });
        toast.success("Connector updated.");
      } else {
        await createIntegration({
          kind: draft.kind,
          name,
          config,
          ...(draft.secret ? { secret: draft.secret } : {}),
        });
        toast.success("Connector added.");
      }
      setDraft(null);
      await load();
    } catch (e) {
      const s = (e as { status?: number }).status;
      toast.error(s === 403 ? "Only admins can manage integrations." : "Couldn't save the connector.");
    } finally {
      setSaving(false);
    }
  }

  async function onToggle(it: Integration) {
    setBusyId(it.id);
    try {
      await updateIntegration(it.id, { enabled: !it.enabled });
      setIntegrations((xs) => (xs ?? []).map((x) => (x.id === it.id ? { ...x, enabled: !x.enabled } : x)));
    } catch {
      toast.error("Couldn't change the connector.");
    } finally {
      setBusyId(null);
    }
  }

  async function onTest(it: Integration) {
    setBusyId(it.id);
    try {
      const r = await testIntegration(it.id);
      if (r.ok) toast.success(`${it.name} responded — test delivered.`);
      else toast.error(`Test failed: ${r.error ?? "unknown error"}`);
      await load();
    } catch {
      toast.error("Couldn't run the test.");
    } finally {
      setBusyId(null);
    }
  }

  function closeConnect() {
    setConnectDialog(null);
    setTgToken(""); setWaToken(""); setWaPhoneId(""); setWaVerify(""); setSlTeam(""); setSlToken(""); setEmailInput("");
  }

  async function onConnectSubmit() {
    setConnectBusy(true);
    try {
      if (connectDialog === "telegram") {
        await saveTelegramConnection(tgToken.trim());
        toast.success("Telegram bot connected — inbound polling starts within seconds.");
      } else if (connectDialog === "whatsapp") {
        await saveWhatsAppConnection({ token: waToken.trim(), phoneId: waPhoneId.trim(), ...(waVerify.trim() ? { verifyToken: waVerify.trim() } : {}) });
        toast.success("WhatsApp number connected.");
      } else if (connectDialog === "slack") {
        await saveSlackConnection({ team_id: slTeam.trim(), bot_token: slToken.trim() });
        toast.success("Slack workspace connected.");
      } else if (connectDialog === "email") {
        await saveEmailRoute(emailInput.trim());
        toast.success("Support address saved — replies now send from it.");
      }
      closeConnect();
      await load();
    } catch (e) {
      toast.error((e as { detail?: string }).detail || "Couldn't connect — check the credentials.");
    } finally {
      setConnectBusy(false);
    }
  }

  async function onDisconnectChannel(channel: string) {
    const row = connections.find((c) => c.channel === channel);
    if (!row) return;
    try {
      await deleteChannelConnection(row.id);
      toast.success("Disconnected.");
      await load();
    } catch {
      toast.error("Couldn't disconnect.");
    }
  }

  async function onRemoveSlack(id: string) {
    try {
      await deleteSlackConnection(id);
      await load();
    } catch {
      toast.error("Couldn't remove the workspace link.");
    }
  }

  async function onConfirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await deleteIntegration(removeTarget.id);
      setIntegrations((xs) => (xs ?? []).filter((x) => x.id !== removeTarget.id));
      toast.success(`${removeTarget.name} removed.`);
      setRemoveTarget(null);
    } catch {
      toast.error("Couldn't remove the connector.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <SettingsPage
        active="integrations"
        title="Channels & integrations"
        description="Connect the channels this workspace talks over, and the outbound targets your automations notify."
        status={loading ? "loading" : loadError ? "error" : "ready"}
        onRetry={() => void load()}
        errorTitle="Couldn't load channels & integrations"
        actions={
          isAdmin && !draft ? (
            <Button size="sm" className="whitespace-nowrap" onClick={() => setDraft(emptyDraft())}>
              <Plus /> New connector
            </Button>
          ) : undefined
        }
      >
        <div className="max-w-3xl px-6 pb-10 pt-4">
          <div className="space-y-8">
                  {/* ── Channels ── */}
                  <section>
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channels</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Every conversation channel this workspace can talk over. Connected channels are live;
                      credential-gated ones need a token first.
                    </p>
                    <div className="mt-3 grid gap-2.5">
                      {(catalog ?? []).map((ch) => {
                        const state = channelState(ch);
                        const sm = STATE_META[state];
                        const Glyph = glyphFor(ch.id);
                        return (
                          <div
                            key={ch.id}
                            className="relative flex items-start justify-between gap-4 overflow-hidden rounded-xl border bg-card p-4 pl-5 shadow-sm"
                          >
                            {/* status rail */}
                            <span className={cn("absolute inset-y-0 left-0 w-1", sm.rail)} aria-hidden />

                            <div className="flex min-w-0 items-start gap-3">
                              <span
                                className={cn(
                                  "grid size-9 shrink-0 place-items-center rounded-lg bg-muted",
                                  sm.glyph,
                                )}
                              >
                                <Glyph className="size-4.5" />
                              </span>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-semibold text-foreground">{ch.label}</span>
                                  {ch.status === "stub" && (
                                    <span className="whitespace-nowrap text-micro font-medium uppercase tracking-wide text-muted-foreground/70">
                                      Preview
                                    </span>
                                  )}
                                </div>
                                <p className="mt-0.5 text-xs text-muted-foreground">{ch.blurb}</p>
                                <p className="mt-1.5 text-micro uppercase tracking-wide text-muted-foreground/70">
                                  {directionLabel(ch.direction)}
                                </p>
                              </div>
                            </div>

                            <div className="flex shrink-0 flex-col items-end gap-2 pt-0.5">
                              <ChannelStatusNote state={state} connections={ch.connections} />
                              {isAdmin && (ch.id === "telegram" || ch.id === "whatsapp") && (
                                connections.some((c) => c.channel === ch.id) ? (
                                  <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => void onDisconnectChannel(ch.id)}>
                                    Disconnect
                                  </Button>
                                ) : (
                                  <Button variant="outline" size="sm" className="h-7" onClick={() => setConnectDialog(ch.id as "telegram" | "whatsapp")}>
                                    Connect
                                  </Button>
                                )
                              )}
                              {isAdmin && ch.id === "slack" && (
                                <Button variant="outline" size="sm" className="h-7" onClick={() => setConnectDialog("slack")}>
                                  {slackConns.length ? "Manage" : "Connect"}
                                </Button>
                              )}
                              {ch.id === "email" && (
                                <>
                                  {emailAddr && (
                                    <span className="max-w-[12rem] truncate font-mono text-micro text-muted-foreground" title={emailAddr}>
                                      {emailAddr}
                                    </span>
                                  )}
                                  {isAdmin && (
                                    <Button variant="outline" size="sm" className="h-7" onClick={() => { setEmailInput(emailAddr ?? ""); setConnectDialog("email"); }}>
                                      {emailAddr ? "Edit address" : "Set address"}
                                    </Button>
                                  )}
                                </>
                              )}
                              {ch.id === "discord" && (
                                <Link to="/settings/discord-mirror" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7")}>
                                  Set up
                                </Link>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* ── Connect dialogs (0092 self-serve creds) ── */}
                    <FormDialog
                      open={connectDialog === "email"}
                      title="Support email address"
                      description="The From address for outbound ticket replies (so a customer's reply routes back here). It must be on a domain your email provider is authorized to send from — otherwise sends are rejected."
                      onClose={closeConnect}
                      onSubmit={() => void onConnectSubmit()}
                      submitLabel="Save"
                      submitDisabled={!emailInput.trim() || !emailInput.includes("@")}
                      busy={connectBusy}
                    >
                      <div className="space-y-1.5">
                        <Label htmlFor="email-addr">Address</Label>
                        <Input id="email-addr" autoFocus type="email" placeholder="support@yourdomain.com" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} />
                      </div>
                    </FormDialog>

                    <FormDialog
                      open={connectDialog === "telegram"}
                      title="Connect Telegram"
                      description="Create a bot with @BotFather, then paste its token. Inbound messages become conversations; replies go out as the bot."
                      onClose={closeConnect}
                      onSubmit={() => void onConnectSubmit()}
                      submitLabel="Connect"
                      submitDisabled={!tgToken.trim()}
                      busy={connectBusy}
                    >
                      <div className="space-y-1.5">
                        <Label htmlFor="tg-token">Bot token</Label>
                        <Input id="tg-token" autoFocus placeholder="123456789:AA…" value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
                      </div>
                    </FormDialog>

                    <FormDialog
                      open={connectDialog === "whatsapp"}
                      title="Connect WhatsApp"
                      description="From Meta's Cloud API app: the permanent access token and your number's Phone number ID. Point the app's webhook at /whatsapp/webhook on this API."
                      onClose={closeConnect}
                      onSubmit={() => void onConnectSubmit()}
                      submitLabel="Connect"
                      submitDisabled={!waToken.trim() || !waPhoneId.trim()}
                      busy={connectBusy}
                    >
                      <div className="space-y-4">
                        <div className="space-y-1.5">
                          <Label htmlFor="wa-token">Access token</Label>
                          <Input id="wa-token" autoFocus placeholder="EAAG…" value={waToken} onChange={(e) => setWaToken(e.target.value)} />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="wa-phone">Phone number ID</Label>
                          <Input id="wa-phone" inputMode="numeric" placeholder="106540352242922" value={waPhoneId} onChange={(e) => setWaPhoneId(e.target.value)} />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="wa-verify">Webhook verify token <span className="font-normal text-muted-foreground">(optional)</span></Label>
                          <Input id="wa-verify" placeholder="the token you typed into Meta's webhook setup" value={waVerify} onChange={(e) => setWaVerify(e.target.value)} />
                        </div>
                      </div>
                    </FormDialog>

                    <FormDialog
                      open={connectDialog === "slack"}
                      title="Slack workspaces"
                      description="Link a Slack workspace (its Team ID + bot token). Inbound events route to this workspace; replies post back via the bot."
                      onClose={closeConnect}
                      onSubmit={() => void onConnectSubmit()}
                      submitLabel="Add workspace"
                      submitDisabled={!slTeam.trim() || !slToken.trim()}
                      busy={connectBusy}
                    >
                      <div className="space-y-4">
                        {slackConns.length > 0 && (
                          <div className="space-y-1.5">
                            <Label>Connected workspaces</Label>
                            <div className="divide-y rounded-md border">
                              {slackConns.map((c) => (
                                <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                                  <div className="min-w-0">
                                    <span className="font-mono text-xs">{c.team_id}</span>
                                    <span className="ml-2 text-micro text-muted-foreground">{c.bot_token}</span>
                                  </div>
                                  <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => void onRemoveSlack(c.id)}>
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="space-y-1.5">
                          <Label htmlFor="sl-team">Team ID</Label>
                          <Input id="sl-team" autoFocus placeholder="T0123ABCD" value={slTeam} onChange={(e) => setSlTeam(e.target.value)} />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="sl-token">Bot token</Label>
                          <Input id="sl-token" placeholder="xoxb-…" value={slToken} onChange={(e) => setSlToken(e.target.value)} />
                        </div>
                      </div>
                    </FormDialog>
                  </section>

                  {/* ── Branded sending domains (Model-B: send AS the customer's own domain) ── */}
                  <SendingDomainsSection isAdmin={isAdmin} />

                  {/* ── Editor ── */}
                  <FormDialog
                    open={!!draft}
                    title={draft?.id ? "Edit connector" : "New connector"}
                    onClose={() => setDraft(null)}
                    onSubmit={() => void onSave()}
                    submitLabel={draft?.id ? "Save changes" : "Add connector"}
                    busy={saving}
                  >
                    {draft && (
                      <div className="space-y-4">
                      {!draft.id && (
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Type</label>
                          <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {KIND_OPTIONS.map((o) => (
                              <button
                                key={o.value}
                                type="button"
                                onClick={() => setDraft({ ...draft, kind: o.value })}
                                className={cn(
                                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                                  draft.kind === o.value ? "border-primary bg-primary/5 text-foreground" : "text-muted-foreground hover:bg-muted",
                                )}
                              >
                                <o.icon className="size-4" /> {o.label}
                              </button>
                            ))}
                          </div>
                          <p className="mt-1.5 text-xs text-muted-foreground">{meta?.blurb}</p>
                        </div>
                      )}

                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Name</label>
                        <Input
                          className="mt-1.5"
                          placeholder="e.g. #support-alerts"
                          value={draft.name}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        />
                      </div>

                      {meta?.toField && (
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Recipient address</label>
                          <Input
                            className="mt-1.5"
                            type="email"
                            placeholder="ops@company.com"
                            value={draft.to}
                            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                          />
                        </div>
                      )}

                      {meta?.urlField && (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <div className="flex-1">
                            <label className="text-xs font-medium text-muted-foreground">Endpoint URL</label>
                            <Input
                              className="mt-1.5"
                              placeholder="https://api.company.com/hook"
                              value={draft.url}
                              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                            />
                          </div>
                          <div className="w-full sm:w-28">
                            <label className="text-xs font-medium text-muted-foreground">Method</label>
                            <div className="mt-1.5">
                              <Combobox
                                value={draft.method}
                                onChange={(v) => setDraft({ ...draft, method: v })}
                                options={[
                                  { value: "POST", label: "POST" },
                                  { value: "PUT", label: "PUT" },
                                ]}
                              />
                            </div>
                          </div>
                        </div>
                      )}

                      {meta?.secretLabel && (
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">{meta.secretLabel}</label>
                          <Input
                            className="mt-1.5 font-mono text-xs"
                            type="password"
                            placeholder={draft.hadSecret ? "•••••••• — leave blank to keep current" : meta.secretPlaceholder}
                            value={draft.secret}
                            onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
                            autoComplete="off"
                          />
                        </div>
                      )}

                      </div>
                    )}
                  </FormDialog>

                  {/* ── Outbound connectors ── */}
                  <section>
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outbound connectors</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Targets your automations can notify. Credentials are encrypted at rest and never shown again.
                    </p>

                    {(integrations?.length ?? 0) === 0 ? (
                      <div className="mt-3 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-center">
                        <Plug className="size-6 text-muted-foreground/40" />
                        <p className="text-sm text-muted-foreground">No connectors yet.</p>
                        {isAdmin && (
                          <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => setDraft(emptyDraft())}>
                            <Plus /> Add your first connector
                          </Button>
                        )}
                      </div>
                    ) : (
                      <ul className="mt-3 space-y-2">
                        {(integrations ?? []).map((it) => {
                          const km = KIND[it.kind as IntegrationKind] ?? KIND.http;
                          const sb = statusBadge(it.status);
                          const busy = busyId === it.id;
                          return (
                            <li key={it.id} className="relative flex items-center gap-3 overflow-hidden rounded-xl border bg-card px-4 py-3 pl-5 shadow-sm">
                              <span className={cn("absolute inset-y-0 left-0 w-1", railFor(it))} aria-hidden />
                              <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg", it.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                                <km.Icon className="size-4.5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-sm font-medium">{it.name}</span>
                                  <Badge variant="outline" className="shrink-0 capitalize">{km.label}</Badge>
                                  {!it.enabled && <Badge variant="muted" className="shrink-0">Off</Badge>}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <Badge variant={sb.variant} className="px-1.5 py-0">{sb.label}</Badge>
                                  {it.status === "error" && it.lastError && (
                                    <span className="truncate text-destructive/80" title={it.lastError}>· {it.lastError}</span>
                                  )}
                                </div>
                              </div>
                              {isAdmin && (
                                <div className="flex shrink-0 items-center gap-0.5">
                                  <Button variant="ghost" size="icon" className="size-8" title="Send test" aria-label="Send test" disabled={busy} onClick={() => void onTest(it)}>
                                    {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                                  </Button>
                                  <Button variant="ghost" size="icon" className={cn("size-8", it.enabled ? "text-primary" : "text-muted-foreground")} title={it.enabled ? "Disable" : "Enable"} aria-label="Toggle" disabled={busy} onClick={() => void onToggle(it)}>
                                    <Power className="size-4" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="size-8" title="Edit" aria-label="Edit" onClick={() => setDraft(draftFrom(it))}>
                                    <Pencil className="size-4" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" title="Remove" aria-label="Remove" onClick={() => setRemoveTarget(it)}>
                                    <Trash2 className="size-4" />
                                  </Button>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </div>
          </div>
      </SettingsPage>

      <ConfirmDialog
        open={!!removeTarget}
        title="Remove connector?"
        message={
          removeTarget ? (
            <>
              <span className="font-medium text-foreground">{removeTarget.name}</span> will be deleted, and any automation
              that notifies through it will stop delivering. This can't be undone.
            </>
          ) : undefined
        }
        confirmLabel="Remove"
        destructive
        busy={removing}
        onConfirm={() => void onConfirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />
    </>
  );
}

// ── Branded sending domains (Model-B) ────────────────────────────────────────
// The Intercom "custom email domain" feature: a tenant verifies their OWN domain so outbound
// replies send AS support@theirdomain with real DKIM, not from the shared platform domain. The
// provider (Resend) issues the DNS records; we display them + poll for verification. Self-contained
// (own state + fetch) so it doesn't thread through the big page component. Governs OUTBOUND identity
// only — the inbound support address (above) stays the routing key.

const DOMAIN_STATUS: Record<string, { label: string; cls: string }> = {
  verified: { label: "Verified", cls: "border-success/30 bg-success/10 text-success" },
  pending: { label: "Pending DNS", cls: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  verifying: { label: "Verifying…", cls: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  failed: { label: "Failed", cls: "border-destructive/30 bg-destructive/10 text-destructive" },
  not_started: { label: "Not started", cls: "border-border bg-muted text-muted-foreground" },
};

function DomainStatusBadge({ status }: { status: string }) {
  const s = DOMAIN_STATUS[status] ?? DOMAIN_STATUS.pending;
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-micro font-medium", s.cls)}>
      {s.label}
    </span>
  );
}

/** The DNS records the tenant must publish for a domain — a compact, copyable table. */
function DnsRecordsTable({ records }: { records: DnsRecord[] }) {
  if (!records.length) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No DNS records yet. Add your provider API key (or open the domain in your provider dashboard) to fetch them.
      </p>
    );
  }
  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v).then(() => toast.success("Copied.")).catch(() => {});
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-micro uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 font-medium">Type</th>
            <th className="px-3 py-1.5 font-medium">Name / Host</th>
            <th className="px-3 py-1.5 font-medium">Value</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {records.map((r, i) => (
            <tr key={i} className="border-t border-border/60 align-top">
              <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                {r.type}
                {typeof r.priority === "number" && <span className="text-muted-foreground/60"> · {r.priority}</span>}
              </td>
              <td className="max-w-[10rem] px-3 py-1.5">
                <button type="button" className="block max-w-full truncate hover:text-primary" title={`${r.name} (click to copy)`} onClick={() => copy(r.name)}>
                  {r.name}
                </button>
              </td>
              <td className="max-w-[16rem] px-3 py-1.5">
                <button type="button" className="block max-w-full truncate hover:text-primary" title={`${r.value} (click to copy)`} onClick={() => copy(r.value)}>
                  {r.value}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SendingDomainsSection({ isAdmin }: { isAdmin: boolean }) {
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);
  const [providerEnabled, setProviderEnabled] = useState(true);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SendingDomain | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    void fetchSendingDomains()
      .then((r) => { setDomains(r.domains); setProviderEnabled(r.providerEnabled); })
      .catch(() => setDomains([]));
  }, []);

  async function onAdd() {
    const domain = input.trim().toLowerCase();
    if (!domain) return;
    setAdding(true);
    try {
      const d = await addSendingDomain(domain);
      setDomains((xs) => [...(xs ?? []), d]);
      setExpanded(d.id); // reveal the DNS records to publish immediately
      setInput("");
      toast.success(providerEnabled ? "Domain added — publish the DNS records below, then verify." : "Domain tracked. Add it in your provider dashboard to fetch DNS records.");
    } catch (e) {
      const s = (e as { status?: number }).status;
      toast.error(s === 409 ? "That domain is already added." : (e as { detail?: string }).detail || "Couldn't add that domain.");
    } finally {
      setAdding(false);
    }
  }

  async function onVerify(d: SendingDomain) {
    setBusyId(d.id);
    try {
      const fresh = await verifySendingDomain(d.id);
      setDomains((xs) => (xs ?? []).map((x) => (x.id === d.id ? fresh : x)));
      toast.success(fresh.status === "verified" ? "Domain verified — you can now send from it." : "Re-checked — DNS not fully verified yet.");
    } catch (e) {
      toast.error((e as { detail?: string }).detail || "Couldn't check that domain.");
    } finally {
      setBusyId(null);
    }
  }

  async function onConfirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await deleteSendingDomain(removeTarget.id);
      setDomains((xs) => (xs ?? []).filter((x) => x.id !== removeTarget.id));
      toast.success("Domain removed.");
      setRemoveTarget(null);
    } catch {
      toast.error("Couldn't remove that domain.");
    } finally {
      setRemoving(false);
    }
  }

  // Hidden entirely until loaded; empty + non-admin shows nothing (admins get the setup affordance).
  if (domains === null) return null;
  if (!isAdmin && domains.length === 0) return null;

  return (
    <section className="mt-8">
      <div className="mb-1 flex items-center gap-2">
        <Globe className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Branded sending domains</h2>
      </div>
      <p className="mb-3 max-w-2xl text-xs text-muted-foreground">
        Verify a domain you own to send replies from your own address (e.g. <span className="font-mono">support@yourdomain.com</span>)
        with real DKIM/SPF — so email lands in the inbox and looks like it's from you. Publish the DNS records we show, then verify.
      </p>

      {!providerEnabled && (
        <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Self-serve provisioning is off (no provider API key on this server). You can still track a domain here and set it up
          manually in your email provider's dashboard.
        </p>
      )}

      <div className="space-y-2">
        {domains.map((d) => {
          const isOpen = expanded === d.id;
          return (
            <div key={d.id} className="rounded-lg border">
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{d.domain}</span>
                <DomainStatusBadge status={d.status} />
                <button
                  type="button"
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setExpanded(isOpen ? null : d.id)}
                >
                  {isOpen ? "Hide DNS" : "View DNS"}
                </button>
                {isAdmin && (
                  <>
                    <Button variant="outline" size="sm" className="h-7" disabled={busyId === d.id} onClick={() => void onVerify(d)}>
                      {busyId === d.id ? <Loader2 className="size-3.5 animate-spin" /> : "Verify"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      title="Remove domain"
                      onClick={() => setRemoveTarget(d)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </div>
              {isOpen && (
                <div className="border-t bg-muted/20 py-1">
                  <DnsRecordsTable records={d.records} />
                </div>
              )}
            </div>
          );
        })}

        {domains.length === 0 && (
          <p className="rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
            No sending domains yet — add one below to send from your own address.
          </p>
        )}
      </div>

      {isAdmin && (
        <div className="mt-3 flex items-center gap-2">
          <Input
            className="max-w-xs"
            placeholder="yourdomain.com"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void onAdd(); }}
          />
          <Button variant="outline" size="sm" className="h-9 gap-1.5" disabled={adding || !input.trim()} onClick={() => void onAdd()}>
            {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Add domain
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!removeTarget}
        title="Remove sending domain?"
        message={
          removeTarget ? (
            <>
              <span className="font-mono text-foreground">{removeTarget.domain}</span> will be removed. Replies will fall back
              to your shared support address. This can't be undone.
            </>
          ) : undefined
        }
        confirmLabel="Remove"
        destructive
        busy={removing}
        onConfirm={() => void onConfirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />
    </section>
  );
}
