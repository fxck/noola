import { useEffect, useMemo, useRef, useState } from "react";
import {
  UserPlus,
  Link2,
  Copy,
  Trash2,
  X,
  Plus,
  Loader2,
  AlertTriangle,
  SlidersHorizontal,
  Hash,
} from "lucide-react";
import { SettingsRail } from "@/components/settings-rail";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { Combobox } from "@/components/ui/combobox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toaster";
import { fetchInstanceConfig } from "@/lib/instance";
import { avatarSrc } from "@/lib/avatar-upload";
import {
  type Member,
  type PendingInvite,
  type InviteLink,
  type InviteRole,
  type MemberRole,
  fetchMembers,
  fetchInvites,
  inviteMember,
  cancelInvite,
  createInviteLink,
  disableInviteLink,
  changeMemberRole,
  removeMember,
  setMemberDiscordId,
} from "@/lib/members";
import {
  type AgentUser,
  type UserRoutingResult,
  fetchUsers,
  updateUserRouting,
  relativeTime,
} from "@/lib/tickets";
import { cn } from "@/lib/utils";

const RANK: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };
const ROLE_OPTIONS: { value: MemberRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "agent", label: "Agent" },
  { value: "viewer", label: "Viewer" },
];
// Short, legible permission summaries per role (D9) — rendered as a legend so the roster
// controls stay uncluttered while the meaning of each role is one glance away.
const ROLE_DESC: Record<MemberRole, string> = {
  owner: "Full access, including billing and ownership transfer.",
  admin: "Manage members, settings, and integrations.",
  agent: "Handle conversations, contacts, and the knowledge base.",
  viewer: "Read-only access — can't reply or change settings.",
};
const INVITE_ROLE_OPTIONS = ROLE_OPTIONS.filter((o) => o.value !== "owner") as { value: InviteRole; label: string }[];

function statusFromError(e: unknown): number | undefined {
  return (e as { status?: number } | undefined)?.status;
}

export function SettingsMembersPage() {
  const { user } = useAuth();
  const isAdmin = (RANK[user?.role ?? ""] ?? -1) >= RANK.admin;

  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [loadError, setLoadError] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("agent");
  const [inviting, setInviting] = useState(false);
  const [linkRole, setLinkRole] = useState<InviteRole>("agent");
  const [creatingLink, setCreatingLink] = useState(false);
  const [roleBusy, setRoleBusy] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [removing, setRemoving] = useState(false);
  // Routing v2 — the per-agent routing signals live on GET /users rows (same ids as
  // the better-auth members); joined by id below. Best-effort: the roster still
  // renders if /users fails.
  const [routingUsers, setRoutingUsers] = useState<Map<string, AgentUser>>(new Map());
  const [routingTarget, setRoutingTarget] = useState<Member | null>(null);
  const [discordTarget, setDiscordTarget] = useState<Member | null>(null);

  const load = useRef(async (admin: boolean) => {
    setLoadError(false);
    try {
      setMembers(await fetchMembers());
      if (admin) {
        const inv = await fetchInvites();
        setInvites(inv.invites);
        setLinks(inv.links);
      }
    } catch {
      setLoadError(true);
    }
    try {
      setRoutingUsers(new Map((await fetchUsers()).map((u) => [u.id, u])));
    } catch {
      /* signals stay hidden — the roster itself is unaffected */
    }
  }).current;

  useEffect(() => {
    void load(isAdmin);
  }, [load, isAdmin]);

  const ownerCount = useMemo(() => (members ?? []).filter((m) => m.role === "owner").length, [members]);
  const joinBase = typeof window !== "undefined" ? window.location.origin : "";

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied to clipboard`);
    } catch {
      toast.error("Couldn't copy — copy it manually.");
    }
  }

  async function onInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    try {
      await inviteMember(email, inviteRole);
      // Honest success: without SMTP the email silently no-ops — point at the copyable link.
      const inst = await fetchInstanceConfig();
      toast.success(
        inst.emailEnabled
          ? `Invitation sent to ${email}.`
          : `Invite created for ${email} — email isn't configured, copy the link from Pending invitations.`,
      );
      setInviteEmail("");
      await load(true);
    } catch (e) {
      const s = statusFromError(e);
      toast.error(s === 409 ? "That person is already a member or has a pending invite." : "Couldn't send the invitation.");
    } finally {
      setInviting(false);
    }
  }

  async function onCreateLink() {
    setCreatingLink(true);
    try {
      const { url } = await createInviteLink({ role: linkRole });
      await copy(url || `${joinBase}/join/`, "Invite link");
      await load(true);
    } catch {
      toast.error("Couldn't create an invite link.");
    } finally {
      setCreatingLink(false);
    }
  }

  async function onDisableLink(token: string) {
    try {
      await disableInviteLink(token);
      setLinks((ls) => ls.filter((l) => l.token !== token));
    } catch {
      toast.error("Couldn't disable the link.");
    }
  }

  async function onCancelInvite(id: string) {
    try {
      await cancelInvite(id);
      setInvites((xs) => xs.filter((i) => i.id !== id));
    } catch {
      toast.error("Couldn't cancel the invitation.");
    }
  }

  async function onRoleChange(m: Member, role: MemberRole) {
    if (role === m.role) return;
    setRoleBusy(m.userId);
    try {
      await changeMemberRole(m.userId, role);
      setMembers((ms) => (ms ?? []).map((x) => (x.userId === m.userId ? { ...x, role } : x)));
      toast.success(`${m.name || m.email} is now ${role}.`);
    } catch (e) {
      toast.error(statusFromError(e) === 400 ? "A workspace must keep at least one owner." : "Couldn't change the role.");
    } finally {
      setRoleBusy(null);
    }
  }

  async function onConfirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await removeMember(removeTarget.userId);
      setMembers((ms) => (ms ?? []).filter((x) => x.userId !== removeTarget.userId));
      toast.success(`${removeTarget.name || removeTarget.email} was removed.`);
      setRemoveTarget(null);
    } catch (e) {
      toast.error(statusFromError(e) === 400 ? "A workspace must keep at least one owner." : "Couldn't remove the member.");
    } finally {
      setRemoving(false);
    }
  }

  function onRoutingSaved(m: Member, res: UserRoutingResult) {
    setRoutingUsers((prev) => {
      const next = new Map(prev);
      const existing = next.get(res.user.id);
      next.set(res.user.id, {
        ...(existing ?? { id: res.user.id, name: m.name, email: m.email, role: m.role }),
        skills: res.user.skills,
        out_of_office: res.user.out_of_office,
        ooo_until: res.user.ooo_until,
        max_open_tickets: res.user.max_open_tickets,
      });
      return next;
    });
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <SettingsRail active="members" />

        {/* body */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <header className="flex h-12 shrink-0 items-center gap-2 px-6">
            <h1 className="text-sm font-semibold tracking-tight">Members</h1>
          </header>
          <p className="px-6 text-small text-muted-foreground">
            Everyone with access to this workspace
            {isAdmin ? " — invite teammates and manage their roles." : " — only owners and admins can invite or change roles."}
          </p>
          <div className="max-w-3xl px-6 pb-10 pt-4">
            {members === null && !loadError ? (
              <div className="grid place-items-center py-16">
                <Spinner />
              </div>
            ) : loadError ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <AlertTriangle className="size-7 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">Couldn't load your team.</p>
                <Button variant="outline" size="sm" onClick={() => void load(isAdmin)}>
                  Try again
                </Button>
              </div>
            ) : (
              <div className="space-y-6">
                {/* ── invite controls (admin only) ── */}
                {isAdmin && (
                  <div className="space-y-4 rounded-xl border bg-card p-5 shadow-sm">
                    <div>
                      <h2 className="text-sm font-semibold">Invite by email</h2>
                      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
                        <Input
                          type="email"
                          placeholder="teammate@company.com"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void onInvite()}
                          className="sm:flex-1"
                          autoComplete="off"
                        />
                        <div className="w-full sm:w-36">
                          <Combobox value={inviteRole} onChange={(v) => setInviteRole(v as InviteRole)} options={INVITE_ROLE_OPTIONS} />
                        </div>
                        <Button onClick={() => void onInvite()} disabled={inviting || !inviteEmail.trim()}>
                          {inviting ? <Loader2 className="animate-spin" /> : <UserPlus />}
                          Send invite
                        </Button>
                      </div>
                    </div>

                    <div className="border-t pt-4">
                      <h2 className="text-sm font-semibold">Share an invite link</h2>
                      <p className="mt-1 text-xs text-muted-foreground">Anyone with the link can join with the chosen role.</p>
                      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="w-full sm:w-36">
                          <Combobox value={linkRole} onChange={(v) => setLinkRole(v as InviteRole)} options={INVITE_ROLE_OPTIONS} />
                        </div>
                        <Button variant="outline" onClick={() => void onCreateLink()} disabled={creatingLink}>
                          {creatingLink ? <Loader2 className="animate-spin" /> : <Link2 />}
                          Create &amp; copy link
                        </Button>
                      </div>

                      {links.length > 0 && (
                        <ul className="mt-3 space-y-1.5">
                          {links.map((l) => (
                            <li key={l.token} className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm">
                              <span className="shrink-0 text-xs capitalize text-muted-foreground">{l.role}</span>
                              <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{`${joinBase}/join/${l.token}`}</code>
                              <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
                                {l.uses}{l.maxUses != null ? `/${l.maxUses}` : ""} used
                              </span>
                              <Button variant="ghost" size="icon" className="size-7" title="Copy link" aria-label="Copy link" onClick={() => void copy(`${joinBase}/join/${l.token}`, "Invite link")}>
                                <Copy className="size-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" title="Disable link" aria-label="Disable link" onClick={() => void onDisableLink(l.token)}>
                                <Trash2 className="size-3.5" />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {invites.length > 0 && (
                      <div className="border-t pt-4">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pending invitations</h3>
                        <ul className="mt-2 space-y-1.5">
                          {invites.map((i) => (
                            <li key={i.id} className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm">
                              <span className="min-w-0 flex-1 truncate">{i.email}</span>
                              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                                <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                                <span className="capitalize">{i.role}</span>
                              </span>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                title="Copy invite link"
                                aria-label="Copy invite link"
                                onClick={() => void copy(`${window.location.origin}/invite/${i.id}`, "Invite link")}
                              >
                                <Copy className="size-3.5" />
                              </Button>
                              <Button variant="ghost" size="sm" className="h-7 text-muted-foreground hover:text-foreground" onClick={() => void onCancelInvite(i.id)}>
                                <X className="size-3.5" /> Cancel
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* ── roster ── */}
                <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
                  <div className="flex items-center justify-between border-b px-4 py-2.5">
                    <h2 className="text-sm font-semibold">Team</h2>
                    <span className="text-xs tabular-nums text-muted-foreground">{members?.length ?? 0} {members?.length === 1 ? "member" : "members"}</span>
                  </div>
                  <ul className="divide-y">
                    {(members ?? []).map((m) => {
                      const isSelf = m.userId === user?.id;
                      const canEdit = isAdmin && !isSelf;
                      const lastOwner = m.role === "owner" && ownerCount <= 1;
                      const routing = routingUsers.get(m.userId);
                      const skills = routing?.skills ?? [];
                      return (
                        <li key={m.userId} className="flex items-center gap-3 px-4 py-2.5">
                          <span className="relative shrink-0">
                            <Avatar name={m.name} image={avatarSrc(m.avatarUrl)} className="size-8 text-xs" />
                            {isSelf && (
                              <span
                                className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-success"
                                title="Online now"
                                aria-label="Online now"
                              />
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {m.name || m.email}
                              {isSelf && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span className="truncate">{m.email}</span>
                              <span className="shrink-0 text-muted-foreground/40">·</span>
                              <span className="shrink-0 whitespace-nowrap tabular-nums">
                                Joined {relativeTime(m.createdAt)}
                              </span>
                              {m.discordId && (
                                <>
                                  <span className="shrink-0 text-muted-foreground/40">·</span>
                                  <span className="shrink-0 whitespace-nowrap" title={`Discord ID ${m.discordId}`}>
                                    Discord linked
                                  </span>
                                </>
                              )}
                              {m.twoFactorEnabled && (
                                <>
                                  <span className="shrink-0 text-muted-foreground/40">·</span>
                                  <span className="shrink-0 whitespace-nowrap text-success" title="Two-factor authentication is on">
                                    2FA
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          {/* Routing v2 signals — compact, read-at-a-glance (skills, Away, load cap) */}
                          {(skills.length > 0 || routing?.out_of_office || routing?.max_open_tickets != null) && (
                            <div className="hidden shrink-0 items-center gap-1.5 md:flex">
                              {skills.slice(0, 3).map((s) => (
                                <span key={s} className="rounded-full border bg-muted px-2 py-0.5 text-micro text-muted-foreground">
                                  {s}
                                </span>
                              ))}
                              {skills.length > 3 && (
                                <span className="text-micro tabular-nums text-muted-foreground" title={skills.slice(3).join(", ")}>
                                  +{skills.length - 3}
                                </span>
                              )}
                              {routing?.out_of_office && (() => {
                                const back = oooBack(routing.ooo_until);
                                return (
                                  <span
                                    className="whitespace-nowrap rounded-full bg-warning/15 px-2 py-0.5 text-micro font-medium text-warning"
                                    title={back ? `Back ${back.full}` : undefined}
                                  >
                                    {back ? `Away · back ${back.short}` : "Away"}
                                  </span>
                                );
                              })()}
                              {routing?.max_open_tickets != null && (
                                <span className="text-micro tabular-nums text-muted-foreground" title="Won't be assigned more open tickets than this">
                                  cap {routing.max_open_tickets}
                                </span>
                              )}
                            </div>
                          )}
                          <div className="flex shrink-0 items-center gap-1">
                            {isAdmin && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={cn("size-8 hover:text-foreground", m.discordId ? "text-foreground" : "text-muted-foreground")}
                                  title={m.discordId ? `Discord linked (${m.discordId})` : "Link Discord account"}
                                  aria-label={`Discord link for ${m.name || m.email}`}
                                  onClick={() => setDiscordTarget(m)}
                                >
                                  <Hash className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8 text-muted-foreground hover:text-foreground"
                                  title="Routing"
                                  aria-label={`Routing for ${m.name || m.email}`}
                                  onClick={() => setRoutingTarget(m)}
                                >
                                  <SlidersHorizontal className="size-4" />
                                </Button>
                              </>
                            )}
                            {canEdit ? (
                              <>
                                <div className={cn("w-32", roleBusy === m.userId && "opacity-60")}>
                                  <Combobox
                                    value={m.role}
                                    onChange={(v) => void onRoleChange(m, v as MemberRole)}
                                    options={ROLE_OPTIONS}
                                  />
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8 text-muted-foreground hover:text-destructive"
                                  title={lastOwner ? "A workspace must keep an owner" : "Remove member"}
                                  aria-label={`Remove ${m.name || m.email}`}
                                  disabled={lastOwner}
                                  onClick={() => setRemoveTarget(m)}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </>
                            ) : (
                              <span className={cn("text-xs capitalize text-muted-foreground", m.role === "owner" && "font-medium")}>
                                {m.role}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  {/* Role permission legend (D9) */}
                  <dl className="grid gap-x-4 gap-y-2 border-t bg-muted/30 px-4 py-3 sm:grid-cols-2">
                    {ROLE_OPTIONS.map((r) => (
                      <div key={r.value} className="flex items-baseline gap-2">
                        <dt className="shrink-0 text-xs font-medium capitalize">{r.value}</dt>
                        <dd className="text-xs text-muted-foreground">{ROLE_DESC[r.value]}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!removeTarget}
        title="Remove member?"
        message={
          removeTarget ? (
            <>
              <span className="font-medium text-foreground">{removeTarget.name || removeTarget.email}</span> will lose access to
              this workspace and be unassigned from their tickets. This can't be undone.
            </>
          ) : undefined
        }
        confirmLabel="Remove"
        destructive
        busy={removing}
        onConfirm={() => void onConfirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />

      {/* Mounted per open so the draft state resets from the member's current signals. */}
      {routingTarget && (
        <RoutingDialog
          member={routingTarget}
          routing={routingUsers.get(routingTarget.userId)}
          onClose={() => setRoutingTarget(null)}
          onSaved={(res) => onRoutingSaved(routingTarget, res)}
        />
      )}

      {/* Mounted per open so the draft resets from the member's current link. */}
      {discordTarget && (
        <DiscordLinkDialog
          member={discordTarget}
          onClose={() => setDiscordTarget(null)}
          onSaved={(discordId) => {
            setMembers((ms) => (ms ?? []).map((x) => (x.userId === discordTarget.userId ? { ...x, discordId } : x)));
            setDiscordTarget(null);
          }}
        />
      )}
    </>
  );
}

// datetime-local is timezone-naive — its value is LOCAL wall time, so both
// directions must go through local getters, never an ISO string slice
// (the broadcasts scheduler idiom).
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO auto-return time → the two local renderings the Away badge needs
 *  (short for the visible text, full for the tooltip). Null when unset/invalid. */
function oooBack(iso: string | null | undefined): { short: string; full: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    short: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    full: d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  };
}

/**
 * Per-agent routing controls (Routing v2): skills gate routing pools (an agent must
 * carry EVERY skill a rule demands), out-of-office removes them from all pools —
 * optionally handing their open queue back — and max open tickets caps load at
 * assignment time (empty = unlimited).
 */
function RoutingDialog({
  member,
  routing,
  onClose,
  onSaved,
}: {
  member: Member;
  routing: AgentUser | undefined;
  onClose: () => void;
  onSaved: (res: UserRoutingResult) => void;
}) {
  const wasAway = routing?.out_of_office ?? false;
  const [skills, setSkills] = useState<string[]>(routing?.skills ?? []);
  const [skillDraft, setSkillDraft] = useState("");
  const [away, setAway] = useState(wasAway);
  // Draft held as a datetime-local (LOCAL) string; ISO conversion happens only at submit.
  const [oooUntil, setOooUntil] = useState(() => {
    const b = routing?.ooo_until ? new Date(routing.ooo_until) : null;
    return b && !Number.isNaN(b.getTime()) ? toDatetimeLocal(b) : "";
  });
  const [handBack, setHandBack] = useState(true);
  const [cap, setCap] = useState(routing?.max_open_tickets != null ? String(routing.max_open_tickets) : "");
  const [saving, setSaving] = useState(false);

  // Same limits as routing rules' required-skills input: max 10, each ≤40 chars (maxLength).
  function addSkill() {
    const v = skillDraft.trim();
    if (!v || skills.includes(v) || skills.length >= 10) { setSkillDraft(""); return; }
    setSkills([...skills, v]);
    setSkillDraft("");
  }

  async function save() {
    setSaving(true);
    try {
      const capNum = cap.trim() === "" ? null : Math.max(1, Math.floor(Number(cap.trim())));
      // datetime-local parses as LOCAL time; toISOString does the UTC conversion.
      const until = away && oooUntil !== "" ? new Date(oooUntil) : null;
      const res = await updateUserRouting(member.userId, {
        skills,
        outOfOffice: away,
        oooUntil: until && !Number.isNaN(until.getTime()) ? until.toISOString() : null,
        maxOpenTickets: capNum == null || Number.isNaN(capNum) ? null : capNum,
        ...(away && !wasAway && handBack ? { reassign: true } : {}),
      });
      if (res.handback) {
        toast.success(
          `${member.name || member.email} is away — ${res.handback.reassigned} reassigned · ${res.handback.unassigned} back to Unassigned.`,
        );
      } else {
        toast.success(`Routing updated for ${member.name || member.email}.`);
      }
      onSaved(res);
      onClose();
    } catch (e) {
      const detail = (e as { detail?: string } | undefined)?.detail;
      toast.error(
        detail || (statusFromError(e) === 403 ? "Only admins can change routing." : "Couldn't update routing."),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormDialog
      open
      title="Routing"
      description={`How ${member.name || member.email} participates in automatic assignment.`}
      onClose={onClose}
      onSubmit={() => void save()}
      submitLabel={saving ? "Saving…" : "Save"}
      busy={saving}
    >
      {/* Skills — tag input (Enter or + adds; × removes), the routing-rules idiom */}
      <div className="space-y-1.5">
        <Label>
          Skills {skills.length === 0 && <span className="font-normal text-muted-foreground">(none — matches only rules without skill requirements)</span>}
        </Label>
        <div className="flex items-center gap-1.5">
          <Input
            value={skillDraft}
            onChange={(e) => setSkillDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSkill(); } }}
            placeholder="Add a skill…"
            maxLength={40}
            className="h-9"
            autoFocus
          />
          <Button type="button" variant="outline" size="icon" className="size-9 shrink-0" onClick={addSkill} aria-label="Add skill" disabled={skills.length >= 10}>
            <Plus className="size-4" />
          </Button>
        </div>
        {skills.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {skills.map((s) => (
              <span key={s} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
                {s}
                <button type="button" onClick={() => setSkills(skills.filter((x) => x !== s))} aria-label={`Remove ${s}`}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">Rules that demand skills only assign to agents who carry every one of them.</p>
      </div>

      {/* Out of office — removes the agent from all routing pools */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <Label className="flex flex-col gap-1">
            Out of office
            <span className="text-xs font-normal leading-snug text-muted-foreground">
              Removes them from all routing pools until switched back.
            </span>
          </Label>
          <Switch checked={away} onCheckedChange={setAway} aria-label="Out of office" />
        </div>
        {away && (
          <div className="space-y-1.5">
            <Label htmlFor="routing-ooo-until">
              Until <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="routing-ooo-until"
              type="datetime-local"
              value={oooUntil}
              min={toDatetimeLocal(new Date())}
              onChange={(e) => setOooUntil(e.target.value)}
              className="h-9 w-fit"
            />
            <p className="text-xs text-muted-foreground">Automatically back after this time; leave empty for indefinite.</p>
          </div>
        )}
        {away && !wasAway && (
          <label className="flex cursor-pointer items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-small">
            <Checkbox checked={handBack} onCheckedChange={setHandBack} aria-label="Hand back their open conversations" />
            <span>
              Hand back their open conversations
              <span className="block text-xs text-muted-foreground">
                Team conversations go to eligible teammates; the rest return to Unassigned.
              </span>
            </span>
          </label>
        )}
      </div>

      {/* Load cap — empty = unlimited */}
      <div className="space-y-1.5">
        <Label htmlFor="routing-cap">Max open tickets</Label>
        <Input
          id="routing-cap"
          type="number"
          min={1}
          step={1}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          placeholder="Unlimited"
          className="h-9 w-32 tabular-nums"
        />
        <p className="text-xs text-muted-foreground">Assignment skips them once they hold this many open tickets. Leave empty for no cap.</p>
      </div>
    </FormDialog>
  );
}

/**
 * Link a member's Discord account (the explicit teammate mark). A linked member's messages in
 * customer channels never open tickets, and reacting 👀 in the ops-mirror forum assigns the
 * ticket to their seat.
 */
function DiscordLinkDialog({
  member,
  onClose,
  onSaved,
}: {
  member: Member;
  onClose: () => void;
  onSaved: (discordId: string | null) => void;
}) {
  const [discordId, setDiscordId] = useState(member.discordId ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    const value = discordId.trim();
    if (value && !/^\d{5,25}$/.test(value)) {
      toast.error("Use the numeric Discord user ID — right-click the user in Discord → Copy User ID.");
      return;
    }
    setSaving(true);
    try {
      await setMemberDiscordId(member.userId, value || null);
      toast.success(value ? "Discord account linked." : "Discord link removed.");
      onSaved(value || null);
    } catch (e) {
      const detail = (e as { detail?: string } | undefined)?.detail;
      toast.error(detail || "Couldn't update the Discord link.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormDialog
      open
      title="Link Discord account"
      description={`Mark ${member.name || member.email}'s Discord identity as part of your team.`}
      onClose={onClose}
      onSubmit={() => void save()}
      submitLabel={saving ? "Saving…" : discordId.trim() ? "Save" : member.discordId ? "Remove link" : "Save"}
      busy={saving}
    >
      <div className="space-y-1.5">
        <Label htmlFor="member-discord-id">Discord user ID</Label>
        <Input
          id="member-discord-id"
          value={discordId}
          onChange={(e) => setDiscordId(e.target.value)}
          placeholder="e.g. 1521941266038919299"
          inputMode="numeric"
          autoComplete="off"
          className="h-9 tabular-nums"
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          Right-click the user in Discord → Copy User ID (enable Developer Mode in Discord's settings if you don't
          see it). Their messages in customer channels then count as your team — no tickets, no customer seat — and
          reacting 👀 on a mirrored conversation assigns it to them. Leave empty to remove the link.
        </p>
      </div>
    </FormDialog>
  );
}
