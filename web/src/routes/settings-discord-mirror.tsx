import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Hash, Plus, Trash2, ChevronRight, Inbox, Repeat2, Check } from "lucide-react";
import { SettingsPage } from "@/components/settings-page";
import { cn } from "@/lib/utils";
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
  fetchDiscordForumTags,
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

// Discord settings, framed around the two jobs Discord actually does:
//   Step 1 — Connect a server (prerequisite; the pickers below only list connected servers).
//   Step 2 — Choose what Discord does — set up either or both:
//     A. Customers reach you in Discord — bind channels/forums; their posts become tickets.
//        (Team identity lives here: which roles are staff, so their messages never open tickets.)
//     B. Your team works tickets from Discord — a private mirror forum where every conversation
//        from email/widget/Slack shows up as a post the team reacts on (triage) and 📤 replies from.
// Save is a full replace per surface. Pickers hydrate from the live bot; offline → manual ID entry.
// The redesign is presentation-only: same fields, same save endpoints.

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/** Reaction cheat-sheet for the mirror forum — one behaviour per row, scannable. */
const REACTIONS: { emoji: string; label: string; effect?: string }[] = [
  { emoji: "📤", label: "Send to customer", effect: "posts your reply on their original channel" },
  { emoji: "✅", label: "Close" },
  { emoji: "🔄", label: "Reopen" },
  { emoji: "👀", label: "Assign to me" },
  { emoji: "💤", label: "Snooze" },
];

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

/** Numbered step marker — encodes the real prerequisite order (connect first, then configure). */
function StepHeader({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
          done ? "bg-primary text-primary-foreground" : "border text-muted-foreground",
        )}
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </div>
  );
}

/** One of the two Discord "jobs" — an icon-headed panel grouping everything for that direction. */
function DirectionPanel({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: typeof Inbox;
  title: string;
  subtitle: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-2xl border bg-card/40 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          <p className="mt-0.5 text-small text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** Collapsible "advanced" area on a card — keeps the common case one-line, reveals the rest on demand. */
function Disclosure({ label, defaultOpen, children }: { label: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border-t">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")} />
        {label}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

/** The reaction legend + working rules for the mirror forum — replaces the old prose paragraph. */
function MirrorRules() {
  return (
    <div className="rounded-lg border bg-muted/30 p-3.5">
      <p className="text-xs font-semibold text-foreground">React on a mirrored post to act on the ticket</p>
      <div className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {REACTIONS.map((r) => (
          <div key={r.emoji} className="flex items-baseline gap-2 text-small">
            <span className="text-base leading-none">{r.emoji}</span>
            <span className="min-w-0">
              <span className="font-medium text-foreground">{r.label}</span>
              {r.effect && <span className="text-muted-foreground"> — {r.effect}</span>}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 border-t pt-2.5 text-xs leading-relaxed text-muted-foreground">
        Anything you type in a post is an <strong>internal note</strong> — only 📤 reaches the customer. Closing archives
        the post; forum tags track status and priority. The emoji map is shared with Slack —{" "}
        <Link to="/settings/classification" className="underline underline-offset-2 hover:text-foreground">
          Settings → Classification
        </Link>
        .
      </p>
    </div>
  );
}

/** Step 1: connect a Discord server (guild) to this workspace. Invite the bot, then paste the Server
 *  ID — this writes the discord_links row that routes the server's messages here. The channel/mirror
 *  pickers below only list servers connected here, so this is the step that unblocks everything else. */
function ConnectServerSection({
  connectedGuildIds,
  onLinked,
}: {
  connectedGuildIds: string[];
  onLinked: () => void;
}) {
  const [guildId, setGuildId] = useState("");
  const [linking, setLinking] = useState(false);
  const connected = connectedGuildIds.length > 0;

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
      <StepHeader n={1} title="Connect your Discord server" done={connected} />
      <p className="text-small text-muted-foreground">
        Invite the bot to your server, then paste its Server ID. In Discord, turn on Developer Mode (User Settings →
        Advanced), right-click the server icon → <strong>Copy Server ID</strong>. The pickers below only list servers
        you've connected here.
      </p>

      {connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small text-muted-foreground">Connected:</span>
          {connectedGuildIds.map((id) => (
            <Badge key={id} variant="muted" className="font-mono">
              {id}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-small text-muted-foreground">No servers connected yet — add one to get started.</p>
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
          <Plus className="size-4" /> {connected ? "Connect another" : "Connect server"}
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
      toast.success("Saved — your open conversations are showing up in the forum now.");
    } catch {
      toast.error("Couldn't save — check that every forum has a server and channel.");
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
  const serverConnected = guilds.length > 0;
  const manualGuild = guilds.length === 0;

  return (
    <SettingsPage
      active="discord-mirror"
      title="Discord"
      description="Tickets in and out of Discord — where customers reach you, and where your team works the inbox."
    >
      <div className="max-w-3xl space-y-8 px-6 pb-12 pt-4">
        <ConnectServerSection connectedGuildIds={guilds.map((g) => g.id)} onLinked={() => setReloadKey((k) => k + 1)} />

        {!botOnline && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-small text-warning">
            The Discord bot is offline right now — dropdown pickers are unavailable, but you can still paste channel and
            role IDs by hand.
          </div>
        )}

        {/* ── Step 2 — choose what Discord does ── */}
        <div className="space-y-4">
          <div className="space-y-1">
            <StepHeader n={2} title="Choose what Discord does for you" />
            <p className="pl-[2.1rem] text-small text-muted-foreground">
              Discord works two ways — set up either or both.
            </p>
          </div>

          {/* A — customers reach you in Discord */}
          <DirectionPanel
            icon={Inbox}
            title="Customers reach you in Discord"
            subtitle="Bind the channels and help forums where customers post. Each message or post becomes a ticket in your inbox."
          >
            <CustomerChannelsSection key={reloadKey} serverConnected={serverConnected} />
          </DirectionPanel>

          {/* B — your team works tickets from Discord (the mirror) */}
          <DirectionPanel
            icon={Repeat2}
            title="Your team works tickets from Discord"
            subtitle="A private forum where every conversation from email, widget and Slack shows up as a post — so your team can triage and reply without leaving Discord. Conversations that already live in a Discord channel never show up here."
          >
            <MirrorRules />

            {status === "loading" && <p className="text-small text-muted-foreground">Loading…</p>}
            {status === "error" && <p className="text-small text-destructive">Couldn't load the Discord forum settings.</p>}

            {status === "ready" && (
              <div className="space-y-3">
                {bindings!.length === 0 && (
                  <div className="rounded-xl border border-dashed p-8 text-center">
                    <Hash className="mx-auto size-6 text-muted-foreground/60" />
                    <p className="mt-2 text-sm font-medium">No mirror forum yet</p>
                    <p className="mt-1 text-small text-muted-foreground">
                      Create a private, bot-only forum in Discord, then add it here.
                      {!serverConnected && " Connect a server above first."} By default every email, widget and Slack
                      conversation shows up — add filters to narrow it.
                    </p>
                  </div>
                )}

                {bindings!.map((b) => {
                  const guild = guilds.find((g) => g.id === b.guildId);
                  const forumName = guild?.forums.find((f) => f.id === b.forumChannelId)?.name;
                  const advancedSet =
                    !!b.responderRoleId ||
                    b.attributionMode !== "team" ||
                    !!b.attributionName ||
                    (b.filter.priorities?.length ?? 0) > 0 ||
                    (b.filter.tags?.length ?? 0) > 0 ||
                    (b.filter.topics?.length ?? 0) > 0;
                  return (
                    <section key={b._key} className="overflow-hidden rounded-xl border bg-card shadow-sm">
                      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
                        <Hash className="size-4 shrink-0 text-muted-foreground" />
                        <h4 className="min-w-0 truncate text-sm font-semibold">
                          {forumName ?? (b.forumChannelId || "New forum")}
                        </h4>
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
                            aria-label="Remove forum"
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
                              <Input value={b.guildId} onChange={(e) => patch(b._key, { guildId: e.target.value })} placeholder="Server ID" />
                            )}
                          </Field>
                        )}
                        <Field label="Forum channel" hint="The private forum the bot posts into.">
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
                      </div>

                      <Disclosure label="Advanced — who can act, reply identity, filters" defaultOpen={advancedSet}>
                        <div className="space-y-4 pt-1">
                          <div className="grid gap-4 sm:grid-cols-2">
                            <Field
                              label="Who can act"
                              hint="Sending 📤 and triage reactions are limited to this role. Members with a linked Discord account (Settings → Members) can always act."
                            >
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

                          <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                            <div>
                              <p className="text-sm font-medium">Which conversations show up here</p>
                              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                                Leave everything empty to show <strong>every</strong> non-Discord conversation. Add
                                filters to narrow it — a conversation must match all of them. Agents can always push one
                                in by hand.
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
                                          if (on) cur.delete(p);
                                          else cur.add(p);
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
                              <Field label="Tags" hint="Any match shows up.">
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
                        </div>
                      </Disclosure>
                    </section>
                  );
                })}

                <div className="flex items-center justify-between">
                  <Button variant="outline" size="sm" onClick={addBinding}>
                    <Plus className="size-4" /> Add a forum
                  </Button>
                  <Button size="sm" onClick={() => save(bindings!)} disabled={saving || bindings!.some((b) => !b.guildId || !b.forumChannelId)}>
                    {saving ? "Saving…" : "Save forum"}
                  </Button>
                </div>
              </div>
            )}
          </DirectionPanel>
        </div>
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

/** Per-forum "On close" config: which forum tag marks a post resolved (auto-detect by default),
 *  plus whether closing the ticket in Noola archives / locks the Discord post. Tag names are
 *  fetched live from the forum (falls back to any tag already stored when the bot is offline). */
function ForumCloseSection({
  guildId,
  channelId,
  closeTag,
  closeArchive,
  closeLock,
  onChange,
}: {
  guildId: string;
  channelId: string;
  closeTag: string | null | undefined;
  closeArchive: boolean | undefined;
  closeLock: boolean | undefined;
  onChange: (p: Partial<ChannelDraft>) => void;
}) {
  const [tags, setTags] = useState<string[] | null>(null);

  useEffect(() => {
    if (!guildId || !channelId) {
      setTags([]);
      return;
    }
    let live = true;
    fetchDiscordForumTags(guildId, channelId)
      .then((t) => live && setTags(t))
      .catch(() => live && setTags([]));
    return () => {
      live = false;
    };
  }, [guildId, channelId]);

  // Always offer the currently-saved tag even if it's not in the fetched list (bot offline / renamed).
  const options = [
    { value: "", label: "Auto-detect a Solved / Resolved tag" },
    ...(tags ?? []).map((t) => ({ value: t, label: `# ${t}` })),
    ...(closeTag && !(tags ?? []).includes(closeTag) ? [{ value: closeTag, label: `# ${closeTag}` }] : []),
  ];

  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-muted/20 p-3">
      <div>
        <Label className="text-foreground">On close</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          What happens to the Discord post when you close the ticket in Noola.
        </p>
      </div>
      <Field label="Resolved tag" hint="Applied to the post on close. Auto-detect finds the forum's own Solved-style tag.">
        <Combobox
          value={closeTag ?? ""}
          onChange={(v) => onChange({ closeTag: v || null })}
          options={options}
          placeholder="Auto-detect"
        />
      </Field>
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border bg-card p-3">
        <span>
          <span className="text-sm font-medium">Archive post</span>
          <span className="block text-xs text-muted-foreground">Close the forum post so it drops out of the active list.</span>
        </span>
        <Switch
          checked={closeArchive ?? true}
          onCheckedChange={(v) => onChange({ closeArchive: v })}
          aria-label="Archive post on close"
        />
      </label>
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border bg-card p-3">
        <span>
          <span className="text-sm font-medium">Lock post</span>
          <span className="block text-xs text-muted-foreground">Stop new replies — a customer message can't reopen it.</span>
        </span>
        <Switch
          checked={closeLock ?? false}
          onCheckedChange={(v) => onChange({ closeLock: v })}
          aria-label="Lock post on close"
        />
      </label>
    </div>
  );
}

function CustomerChannelsSection({ serverConnected }: { serverConnected: boolean }) {
  const [cfg, setCfg] = useState<DiscordChannelsConfig | null>(null);
  const [drafts, setDrafts] = useState<ChannelDraft[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    Promise.all([fetchDiscordChannelsConfig(), fetchCompanies({ limit: 200 }).then((r) => r.companies).catch(() => [])])
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
          closeTag: b.close_tag,
          closeArchive: b.close_archive,
          closeLock: b.close_lock,
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
        closeTag: b.close_tag, closeArchive: b.close_archive, closeLock: b.close_lock,
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
    <div className="space-y-3">
      {drafts.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Hash className="mx-auto size-6 text-muted-foreground/60" />
          <p className="mt-2 text-sm font-medium">No customer channels yet</p>
          <p className="mt-1 text-small text-muted-foreground">
            Pick a Discord channel or help forum where customers post.
            {!serverConnected && " Connect a server above first."} A forum opens one ticket per post; a text channel
            with <strong>ticket per message</strong> opens one per top-level message.
          </p>
        </div>
      )}

      {drafts.map((d) => {
        const guild = cfg.guilds.find((g) => g.id === d.guildId);
        const channelName = guild?.channels.find((c) => c.id === d.channelId)?.name;
        const optionsSet = !!d.companyId || !!d.autoreplyMode || (d.kind !== "forum" && !d.threadPerMessage);
        return (
          <div key={d._key} className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
              <Hash className="size-4 shrink-0 text-muted-foreground" />
              <h4 className="min-w-0 truncate text-sm font-semibold">
                {channelName ?? (d.channelId || "New channel")}
              </h4>
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
            </div>

            <Disclosure label="Options — account, AI replies, ticket-per-message" defaultOpen={optionsSet}>
              <div className="grid gap-4 pt-1 sm:grid-cols-2">
                <Field label="Customer account" hint="Conversations here roll up to this account.">
                  <Combobox
                    value={d.companyId ?? ""}
                    onChange={(v) => patch(d._key, { companyId: v || null })}
                    options={[{ value: "", label: "No account" }, ...companies.map((c) => ({ value: c.id, label: c.name }))]}
                    placeholder="No account"
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
                {d.kind !== "forum" && (
                  <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 sm:col-span-2">
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
                )}
              </div>
            </Disclosure>

            {d.kind === "forum" && (
              <div className="px-4 pb-4">
                <ForumCloseSection
                  guildId={d.guildId}
                  channelId={d.channelId}
                  closeTag={d.closeTag}
                  closeArchive={d.closeArchive}
                  closeLock={d.closeLock}
                  onChange={(p) => patch(d._key, p)}
                />
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
    </div>
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
    <div className="space-y-2.5 rounded-xl border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold tracking-tight">Who here is your team</h4>
          <p className="mt-0.5 text-small text-muted-foreground">
            Anyone with these server roles is staff — their messages in customer channels never open tickets and are
            never counted as customers.
          </p>
        </div>
        <Button size="sm" variant={dirty ? "brand" : "outline"} disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save team"}
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
        → link their Discord account. Linked members also unlock 👀 assign-to-me in the mirror forum.
      </p>
    </div>
  );
}
