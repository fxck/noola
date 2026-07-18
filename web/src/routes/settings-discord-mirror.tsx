import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Hash, Plus, Trash2, Info } from "lucide-react";
import { SettingsPage } from "@/components/settings-page";
import {
  type DiscordMirrorBinding,
  type DiscordMirrorBindingInput,
  type DiscordMirrorGuild,
  type DiscordChannelBindingInput,
  type DiscordChannelsConfig,
  fetchDiscordMirrorConfig,
  saveDiscordMirrorBindings,
  fetchDiscordChannelsConfig,
  saveDiscordChannelBindings,
  saveDiscordTeamRoles,
  linkDiscordGuild,
} from "@/lib/settings";
import { type Company, fetchCompanies } from "@/lib/companies";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Combobox, MultiSelect } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toaster";

// Discord — three surfaces, one page:
//   1. Customer channels — where customers write to you (VIP text channels, help forums).
//   2. Team identity — which server roles (and, per person, Settings → Members) are YOUR team.
//   3. Ops mirror — the private management forum where every non-Discord conversation lands as
//      a post the team triages (reactions) and answers (📤 promote) from Discord.
// Save is a full replace per section (the Classification model). Pickers hydrate from the live
// bot; offline → manual ID entry. Every field follows the label-above-control settings idiom.

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/** Standard field: label above control, optional hint below — the settings form idiom. */
function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-foreground">{label}</Label>
      {children}
      {hint != null && <p className="text-xs leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** First-run onboarding: bind a Discord server (guild) to this workspace. Invite the bot, then
 *  paste the Server ID — this writes the discord_links row that routes the server's messages here.
 *  Without it the bot sits in the server but its traffic maps to no tenant. The channel/mirror
 *  pickers below only list servers linked here, so this is the step that unblocks everything else. */
function ConnectServerSection({
  connectedGuildIds,
  onLinked,
}: {
  connectedGuildIds: string[];
  onLinked: () => void;
}) {
  const [guildId, setGuildId] = useState("");
  const [linking, setLinking] = useState(false);

  async function link() {
    const id = guildId.trim();
    if (!/^\d{15,20}$/.test(id)) {
      toast.error("Enter your Discord Server ID — the long number from right-click server → Copy Server ID.");
      return;
    }
    setLinking(true);
    try {
      await linkDiscordGuild(id);
      toast.success("Server connected — its channels and roles will populate below.");
      setGuildId("");
      onLinked();
    } catch (e) {
      toast.error((e as { detail?: string }).detail || "Couldn't connect that server. Check the ID and try again.");
    } finally {
      setLinking(false);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Connected servers</h2>
        <p className="mt-0.5 text-small text-muted-foreground">
          The Discord server(s) this workspace handles. Invite the bot to your server, then paste its
          Server ID here — enable Developer Mode in Discord (User Settings → Advanced), right-click the server
          icon → <strong>Copy Server ID</strong>.
        </p>
      </div>

      {connectedGuildIds.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {connectedGuildIds.map((id) => (
            <Badge key={id} variant="muted" className="font-mono">
              {id}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-small text-muted-foreground">No servers connected yet.</p>
      )}

      <div className="flex items-center gap-2">
        <Input
          className="max-w-xs font-mono"
          placeholder="Server ID (e.g. 1521941266038919299)"
          value={guildId}
          inputMode="numeric"
          onChange={(e) => setGuildId(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") void link();
          }}
        />
        <Button size="sm" className="h-9 gap-1.5" disabled={linking || !guildId.trim()} onClick={() => void link()}>
          <Plus className="size-4" /> Connect server
        </Button>
      </div>
    </section>
  );
}

type Draft = DiscordMirrorBindingInput & { _key: string };

function toDraft(b: DiscordMirrorBinding): Draft {
  return {
    _key: b.id,
    guildId: b.guild_id,
    forumChannelId: b.forum_channel_id,
    enabled: b.enabled,
    responderRoleId: b.responder_role_id,
    attributionMode: b.attribution_mode,
    attributionName: b.attribution_name,
    filter: b.filter ?? {},
  };
}

export function SettingsDiscordMirrorPage() {
  const [bindings, setBindings] = useState<Draft[] | null>(null);
  const [guilds, setGuilds] = useState<DiscordMirrorGuild[]>([]);
  const [botOnline, setBotOnline] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  // Bumped after a server is linked so every section (connected servers, customer channels, mirror)
  // re-fetches and picks up the new guild without a full page reload.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    fetchDiscordMirrorConfig()
      .then((cfg) => {
        setBindings(cfg.bindings.map(toDraft));
        setGuilds(cfg.guilds);
        setBotOnline(cfg.botOnline);
      })
      .catch(() => setLoadError(true));
  }, [reloadKey]);

  async function save(next: Draft[]) {
    setSaving(true);
    try {
      const saved = await saveDiscordMirrorBindings(
        next.map(({ _key, ...b }) => ({ ...b, forumChannelId: b.forumChannelId.trim(), guildId: b.guildId.trim() })),
      );
      setBindings(saved.bindings.map(toDraft));
      toast.success("Ops mirror saved — existing open conversations are backfilling in.");
    } catch {
      toast.error("Couldn't save — check that every binding has a server and forum channel.");
    } finally {
      setSaving(false);
    }
  }

  function patch(key: string, p: Partial<Draft>) {
    setBindings((prev) => prev?.map((b) => (b._key === key ? { ...b, ...p } : b)) ?? prev);
  }

  function addBinding() {
    const g = guilds[0];
    setBindings((prev) => [
      ...(prev ?? []),
      {
        _key: `new-${Date.now()}`,
        guildId: g?.id ?? "",
        forumChannelId: "",
        enabled: true,
        responderRoleId: null,
        attributionMode: "team",
        attributionName: null,
        filter: {},
      },
    ]);
  }

  const status = loadError ? "error" : !bindings ? "loading" : "ready";
  const manualGuild = guilds.length === 0;

  return (
    <SettingsPage
      active="discord-mirror"
      title="Discord"
      description="Customer channels, team identity and the management-forum mirror — tickets in and out of Discord."
    >
      <div className="max-w-3xl space-y-8 px-6 pb-12 pt-4">
        <ConnectServerSection
          connectedGuildIds={guilds.map((g) => g.id)}
          onLinked={() => setReloadKey((k) => k + 1)}
        />

        <CustomerChannelsSection key={reloadKey} />

        {/* ── Ops mirror ── */}
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Management forum (ops mirror)</h2>
            <p className="mt-0.5 text-small text-muted-foreground">
              A private forum where the bot posts every conversation from outside Discord — email, widget,
              Slack — so the team can work the whole inbox without leaving Discord. Conversations that already
              live in a Discord channel never mirror.
            </p>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border bg-muted/40 p-3 text-small text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <p>
              Messages in a mirrored post are <strong>internal notes</strong>; reacting 📤 on one sends it to the
              customer on their original channel. Other reactions triage the ticket in place — by default ✅ closes,
              🔄 reopens, 👀 assigns to you, 💤 snoozes (the map is shared with Slack:{" "}
              <Link to="/settings/classification" className="underline underline-offset-2 hover:text-foreground">
                Settings → Classification
              </Link>
              ). Forum tags track status and priority; closing archives the post. Saving a binding also backfills
              your existing open conversations (newest first, up to 100).
              {!botOnline && (
                <>
                  {" "}
                  <span className="text-warning-foreground">The Discord bot is offline right now</span> — pickers are
                  unavailable, but you can paste IDs manually.
                </>
              )}
            </p>
          </div>

          {status === "loading" && <p className="text-small text-muted-foreground">Loading…</p>}
          {status === "error" && <p className="text-small text-destructive">Couldn't load the Discord mirror settings.</p>}

          {status === "ready" && (
            <>
              {bindings!.length === 0 && (
                <div className="rounded-xl border border-dashed p-8 text-center">
                  <Hash className="mx-auto size-6 text-muted-foreground/60" />
                  <p className="mt-2 text-sm font-medium">No mirror binding yet</p>
                  <p className="mt-1 text-small text-muted-foreground">
                    Create a private forum in Discord (bot-only posting), then bind it here. Leave the filter
                    empty to mirror every non-Discord conversation.
                  </p>
                </div>
              )}

              {bindings!.map((b) => {
                const guild = guilds.find((g) => g.id === b.guildId);
                const forumName = guild?.forums.find((f) => f.id === b.forumChannelId)?.name;
                return (
                  <section key={b._key} className="overflow-hidden rounded-xl border bg-card shadow-sm">
                    <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
                      <Hash className="size-4 shrink-0 text-muted-foreground" />
                      <h3 className="min-w-0 truncate text-sm font-semibold">
                        {forumName ?? (b.forumChannelId || "New binding")}
                      </h3>
                      {!b.enabled && <Badge variant="muted">paused</Badge>}
                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                          Active
                          <Switch checked={b.enabled} onCheckedChange={(v) => patch(b._key, { enabled: v })} aria-label="Active" />
                        </label>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          aria-label="Remove binding"
                          onClick={() => setBindings((prev) => prev!.filter((x) => x._key !== b._key))}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-4 p-4 sm:grid-cols-2">
                      {(manualGuild || guilds.length > 1) && (
                        <Field label="Server">
                          {guilds.length > 0 ? (
                            <Combobox
                              value={b.guildId}
                              onChange={(v) => patch(b._key, { guildId: v ?? "", forumChannelId: "" })}
                              options={guilds.map((g) => ({ value: g.id, label: `Server ${g.id.slice(-4)}` }))}
                              placeholder="Pick a server"
                            />
                          ) : (
                            <Input value={b.guildId} onChange={(e) => patch(b._key, { guildId: e.target.value })} placeholder="Guild ID" />
                          )}
                        </Field>
                      )}
                      <Field label="Forum channel">
                        {guild && guild.forums.length > 0 ? (
                          <Combobox
                            value={b.forumChannelId}
                            onChange={(v) => patch(b._key, { forumChannelId: v ?? "" })}
                            options={guild.forums.map((f) => ({ value: f.id, label: `# ${f.name}` }))}
                            placeholder="Pick a forum"
                          />
                        ) : (
                          <Input
                            value={b.forumChannelId}
                            onChange={(e) => patch(b._key, { forumChannelId: e.target.value })}
                            placeholder="Forum channel ID"
                          />
                        )}
                      </Field>
                      <Field label="Who can act" hint="Sending 📤 and triage reactions are limited to this role. Members with a linked Discord account (Settings → Members) can always act.">
                        {guild && guild.roles.length > 0 ? (
                          <Combobox
                            value={b.responderRoleId ?? ""}
                            onChange={(v) => patch(b._key, { responderRoleId: v || null })}
                            options={[{ value: "", label: "Everyone on the server" }, ...guild.roles.map((r) => ({ value: r.id, label: `@ ${r.name}` }))]}
                            placeholder="Everyone on the server"
                          />
                        ) : (
                          <Input
                            value={b.responderRoleId ?? ""}
                            onChange={(e) => patch(b._key, { responderRoleId: e.target.value || null })}
                            placeholder="Role ID (empty = everyone)"
                          />
                        )}
                      </Field>
                      <Field label="Replies signed as">
                        <div className="flex gap-2">
                          <Combobox
                            value={b.attributionMode}
                            onChange={(v) => patch(b._key, { attributionMode: (v as "team" | "collaborator") || "team" })}
                            options={[
                              { value: "team", label: "Team identity" },
                              { value: "collaborator", label: "Responder's name" },
                            ]}
                          />
                          {b.attributionMode === "team" && (
                            <Input
                              value={b.attributionName ?? ""}
                              onChange={(e) => patch(b._key, { attributionName: e.target.value || null })}
                              placeholder="e.g. Acme Support"
                            />
                          )}
                        </div>
                      </Field>
                    </div>

                    <div className="space-y-3 border-t bg-muted/20 p-4">
                      <div>
                        <p className="text-sm font-medium">Which conversations mirror</p>
                        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                          Leave everything empty to mirror <strong>every</strong> non-Discord conversation. Pick facets to
                          narrow it — a conversation must match all of them. Agents can always push one manually.
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5 sm:col-span-2">
                          <Label className="text-foreground">Priority</Label>
                          <div className="flex flex-wrap gap-1.5">
                            {PRIORITIES.map((p) => {
                              const on = b.filter.priorities?.includes(p) ?? false;
                              return (
                                <button
                                  key={p}
                                  type="button"
                                  onClick={() => {
                                    const cur = new Set(b.filter.priorities ?? []);
                                    if (on) cur.delete(p); else cur.add(p);
                                    patch(b._key, { filter: { ...b.filter, priorities: [...cur] } });
                                  }}
                                  className={`rounded-full border px-2.5 py-0.5 text-micro transition-colors ${on ? "border-primary/50 bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent"}`}
                                >
                                  {p}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <Field label="Tags" hint="Any match mirrors.">
                          <Input
                            value={(b.filter.tags ?? []).join(", ")}
                            onChange={(e) =>
                              patch(b._key, {
                                filter: { ...b.filter, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) },
                              })
                            }
                            placeholder="billing, outage"
                            className="h-9"
                          />
                        </Field>
                        <Field label="Topics">
                          <Input
                            value={(b.filter.topics ?? []).join(", ")}
                            onChange={(e) =>
                              patch(b._key, {
                                filter: { ...b.filter, topics: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) },
                              })
                            }
                            placeholder="bug, how-to"
                            className="h-9"
                          />
                        </Field>
                      </div>
                    </div>
                  </section>
                );
              })}

              <div className="flex items-center justify-between">
                <Button variant="outline" size="sm" onClick={addBinding}>
                  <Plus className="size-4" /> Add binding
                </Button>
                <Button size="sm" onClick={() => save(bindings!)} disabled={saving || bindings!.some((b) => !b.guildId || !b.forumChannelId)}>
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </SettingsPage>
  );
}

// ── Customer channels (D5) ────────────────────────────────────────────────────
// One card per bound channel. "Ticket per message" = each top-level customer message opens a new
// ticket and the bot anchors a thread on it (the VIP shape); a forum binding = every post opens
// its own ticket. A company binding rolls the channel's contacts up to that account. Save is a
// full replace, same model as the mirror section.

type ChannelDraft = DiscordChannelBindingInput & { _key: string };

function CustomerChannelsSection() {
  const [cfg, setCfg] = useState<DiscordChannelsConfig | null>(null);
  const [drafts, setDrafts] = useState<ChannelDraft[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    Promise.all([fetchDiscordChannelsConfig(), fetchCompanies().catch(() => [])])
      .then(([c, cos]) => {
        setCfg(c);
        setCompanies(cos);
        setDrafts(c.bindings.map((b) => ({
          _key: `${b.guild_id}:${b.channel_id}`,
          guildId: b.guild_id,
          channelId: b.channel_id,
          kind: b.kind === "forum" ? "forum" : "text",
          mode: b.mode,
          requireThread: b.require_thread,
          threadPerMessage: b.thread_per_message,
          companyId: b.company_id,
          autoreplyMode: b.autoreply_mode,
        })));
      })
      .catch(() => setLoadError(true));
  }, []);

  function patch(key: string, p: Partial<ChannelDraft>) {
    setDrafts((prev) => prev?.map((d) => (d._key === key ? { ...d, ...p } : d)) ?? prev);
  }

  async function save() {
    if (!drafts) return;
    setSaving(true);
    try {
      const saved = await saveDiscordChannelBindings(drafts.map(({ _key, ...d }) => d));
      setDrafts(saved.bindings.map((b) => ({
        _key: `${b.guild_id}:${b.channel_id}`,
        guildId: b.guild_id, channelId: b.channel_id, kind: b.kind === "forum" ? "forum" : "text", mode: b.mode,
        requireThread: b.require_thread, threadPerMessage: b.thread_per_message, companyId: b.company_id,
        autoreplyMode: b.autoreply_mode,
      })));
      toast.success("Customer channels saved.");
    } catch {
      toast.error("Couldn't save — every row needs a channel.");
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <p className="text-small text-destructive">Couldn't load the Discord channel bindings.</p>;
  if (!cfg || !drafts) return <p className="text-small text-muted-foreground">Loading…</p>;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Customer channels</h2>
        <p className="mt-0.5 text-small text-muted-foreground">
          Where customers write to you — private VIP channels, regular text channels, or help forums.
          A forum opens one ticket per post; a text channel with <strong>ticket per message</strong> opens
          one per top-level message.
        </p>
      </div>

      {drafts.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-small text-muted-foreground">
          No channels bound yet — add one to start ingesting a channel.
        </p>
      )}

      {drafts.map((d) => {
        const guild = cfg.guilds.find((g) => g.id === d.guildId);
        const channelName = guild?.channels.find((c) => c.id === d.channelId)?.name;
        return (
          <div key={d._key} className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
              <Hash className="size-4 shrink-0 text-muted-foreground" />
              <h3 className="min-w-0 truncate text-sm font-semibold">
                {channelName ?? (d.channelId || "New channel")}
              </h3>
              {d.kind === "forum" && <Badge variant="muted">forum</Badge>}
              {d.kind !== "forum" && d.threadPerMessage && <Badge variant="muted">VIP</Badge>}
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label="Remove channel"
                onClick={() => setDrafts((prev) => prev!.filter((x) => x._key !== d._key))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <Field label="Channel" hint={d.kind === "forum" ? "Forum — every post opens its own ticket." : undefined}>
                {guild && guild.channels.length > 0 ? (
                  <Combobox
                    value={d.channelId}
                    onChange={(v) => {
                      // The picked channel's shape decides the binding kind — a forum = post-per-ticket intake.
                      const picked = guild.channels.find((c) => c.id === v);
                      patch(d._key, { channelId: v ?? "", kind: picked?.kind === "forum" ? "forum" : "text" });
                    }}
                    options={guild.channels.map((c) => ({
                      value: c.id,
                      label: c.kind === "forum" ? `# ${c.name} · forum` : `# ${c.name}`,
                    }))}
                    placeholder="Pick a channel"
                  />
                ) : (
                  <Input value={d.channelId} onChange={(e) => patch(d._key, { channelId: e.target.value })} placeholder="Channel ID" />
                )}
              </Field>
              <Field label="Customer account" hint="Conversations here roll up to this account.">
                <Combobox
                  value={d.companyId ?? ""}
                  onChange={(v) => patch(d._key, { companyId: v || null })}
                  options={[{ value: "", label: "No account" }, ...companies.map((c) => ({ value: c.id, label: c.name }))]}
                  placeholder="No account"
                />
              </Field>
              <Field label="Mode">
                <Combobox
                  value={d.mode}
                  onChange={(v) => patch(d._key, { mode: (v as ChannelDraft["mode"]) || "staffed" })}
                  options={[
                    { value: "staffed", label: "Staffed — your team answers" },
                    { value: "community", label: "Community — observed only" },
                    { value: "off", label: "Off — not monitored" },
                  ]}
                />
              </Field>
              <Field label="AI replies" hint="Overrides the workspace Autoreply mode here. Workspace Off disables AI everywhere.">
                <Combobox
                  value={d.autoreplyMode ?? ""}
                  onChange={(v) => patch(d._key, { autoreplyMode: (v || null) as ChannelDraft["autoreplyMode"] })}
                  options={[
                    { value: "", label: "Workspace default" },
                    { value: "off", label: "Off — never answer here" },
                    { value: "suggest", label: "Draft only — hold for review" },
                    { value: "auto", label: "Auto-send well-supported answers" },
                  ]}
                />
              </Field>
            </div>

            {d.kind !== "forum" && (
              <div className="border-t px-4 py-2.5">
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span>
                    <span className="text-sm font-medium">Ticket per message (VIP)</span>
                    <span className="block text-xs text-muted-foreground">
                      Every new top-level message opens its own ticket and the bot starts a thread on it.
                    </span>
                  </span>
                  <Switch
                    checked={d.threadPerMessage}
                    onCheckedChange={(v) => patch(d._key, { threadPerMessage: v })}
                    aria-label="Ticket per message"
                  />
                </label>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setDrafts((prev) => [
              ...(prev ?? []),
              { _key: `new-${Date.now()}`, guildId: cfg.guilds[0]?.id ?? "", channelId: "", mode: "staffed", requireThread: true, threadPerMessage: true, companyId: null },
            ])
          }
        >
          <Plus className="size-4" /> Add channel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving || drafts.some((d) => !d.guildId || !d.channelId)}>
          {saving ? "Saving…" : "Save channels"}
        </Button>
      </div>

      {/* Identity: who in these channels is YOUR TEAM (never a customer). Role-based here;
          per-person marks live on the member roster (Settings → Members → link Discord). */}
      {cfg.guilds.map((g) => (
        <TeamRolesCard key={g.id} guild={g} />
      ))}
    </section>
  );
}

function TeamRolesCard({ guild }: { guild: DiscordChannelsConfig["guilds"][number] }) {
  const [roleIds, setRoleIds] = useState<string[]>(guild.teamRoleIds);
  const [saving, setSaving] = useState(false);
  const dirty =
    roleIds.length !== guild.teamRoleIds.length || roleIds.some((r) => !guild.teamRoleIds.includes(r));

  async function save() {
    setSaving(true);
    try {
      await saveDiscordTeamRoles(guild.id, roleIds);
      guild.teamRoleIds = roleIds; // local sync so `dirty` resets without a refetch
      toast.success("Team roles saved.");
    } catch {
      toast.error("Couldn't save team roles.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2.5 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Team members</h3>
          <p className="mt-0.5 text-small text-muted-foreground">
            Anyone with these server roles is your internal team — their messages in customer
            channels never open tickets and are never counted as customers.
          </p>
        </div>
        <Button size="sm" variant={dirty ? "brand" : "outline"} disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {guild.roles.length > 0 ? (
        <MultiSelect
          values={roleIds}
          onChange={setRoleIds}
          options={guild.roles.map((r) => ({ value: r.id, label: `@ ${r.name}` }))}
          label={roleIds.length ? `${roleIds.length} team role${roleIds.length === 1 ? "" : "s"}` : "Pick team roles"}
          searchable
        />
      ) : (
        <p className="text-micro text-muted-foreground">
          The Discord bot is offline — role pickers are unavailable right now.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        You can also mark specific people regardless of roles —{" "}
        <Link to="/settings/members" className="underline underline-offset-2 hover:text-foreground">
          Settings → Members
        </Link>{" "}
        → link their Discord account. Linked members also unlock 👀 assign-to-me in the management forum.
      </p>
    </div>
  );
}
