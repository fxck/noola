import { api } from "@/lib/api";
import type { User } from "@/auth/auth";

// Client for the members + invites API (Track A). The roster read is available to any member;
// the mutations + pending-invite/link listing are admin-gated server-side (a 403 surfaces as an
// ApiError with status 403). The public invite/join lookups + accept/redeem need no session.

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  /** API-relative avatar path (render via avatarSrc); null = initials fallback. */
  avatarUrl?: string | null;
  /** Linked Discord user id (the explicit teammate mark); null = not linked. */
  discordId?: string | null;
  /** TOTP 2FA confirmed (0092) — shown on the roster when the workspace requires it. */
  twoFactorEnabled?: boolean;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface InviteLink {
  token: string;
  organizationId: string;
  role: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  allowedDomain: string | null;
  enabled: boolean;
  createdAt: string;
}

export type InviteRole = "admin" | "agent" | "viewer";
export type MemberRole = "owner" | InviteRole;

/** The org's member roster (member ⋈ user). */
export async function fetchMembers(): Promise<Member[]> {
  return (await api<{ members: Member[] }>("/members")).members;
}

/** Pending email invitations + active shareable links (admin). */
export async function fetchInvites(): Promise<{ invites: PendingInvite[]; links: InviteLink[] }> {
  return await api<{ invites: PendingInvite[]; links: InviteLink[] }>("/members/invites");
}

/** Send an email invitation (admin). */
export async function inviteMember(email: string, role: InviteRole): Promise<void> {
  await api("/members/invites", { method: "POST", body: JSON.stringify({ email, role }) });
}

/** Cancel a pending email invitation (admin). */
export async function cancelInvite(id: string): Promise<void> {
  await api(`/members/invites/${id}`, { method: "DELETE" });
}

/** Mint a shareable invite link (admin); returns the link row + its full shareable URL. */
export async function createInviteLink(input: {
  role: InviteRole;
  maxUses?: number;
  expiresInDays?: number;
  allowedDomain?: string;
}): Promise<{ link: InviteLink; url: string }> {
  return await api<{ link: InviteLink; url: string }>("/members/invite-links", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Disable a shareable link (admin). */
export async function disableInviteLink(token: string): Promise<void> {
  await api(`/members/invite-links/${token}`, { method: "DELETE" });
}

/** Link/unlink a member's Discord account (admin). Their messages in customer channels then count
 *  as the team (never open tickets), and reaction-triage "assign to me" resolves to their seat.
 *  Pass null/empty to clear. */
export async function setMemberDiscordId(userId: string, discordId: string | null): Promise<void> {
  await api(`/members/${userId}/discord`, { method: "PUT", body: JSON.stringify({ discordId }) });
}

/** Change a member's role (admin). The last owner can't be demoted (server returns 400). */
export async function changeMemberRole(userId: string, role: MemberRole): Promise<void> {
  await api(`/members/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role }) });
}

/** Remove a member (admin). The last owner can't be removed (server returns 400). */
export async function removeMember(userId: string): Promise<void> {
  await api(`/members/${userId}`, { method: "DELETE" });
}

// ---- public invite / join (no session) -----------------------------------

export interface InviteLanding {
  id: string;
  email: string;
  role: string;
  status: string;
  orgName: string;
  inviterName: string | null;
}

export interface JoinLanding {
  token: string;
  orgName: string;
  role: string;
  valid: boolean;
  reason?: string;
}

/** Public landing lookup for an email invitation. */
export async function fetchInvite(id: string): Promise<InviteLanding> {
  return (await api<{ invite: InviteLanding }>(`/invite/${id}`)).invite;
}

/** Accept an email invitation — creates/authenticates the invited account, joins, returns the
 *  same { token, user } as login. */
export async function acceptInvite(id: string, password: string, name?: string): Promise<{ token: string; user: User }> {
  return await api<{ token: string; user: User }>(`/invite/${id}/accept`, {
    method: "POST",
    body: JSON.stringify({ password, name }),
  });
}

/** Public landing lookup for a shareable link. */
export async function fetchJoin(token: string): Promise<JoinLanding> {
  return (await api<{ link: JoinLanding }>(`/join/${token}`)).link;
}

/** Redeem a shareable link — creates/authenticates the account, joins, returns { token, user }. */
export async function joinViaLink(
  token: string,
  email: string,
  password: string,
  name?: string,
): Promise<{ token: string; user: User }> {
  return await api<{ token: string; user: User }>(`/join/${token}`, {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
}
