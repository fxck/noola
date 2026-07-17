import { api } from "@/lib/api";

// Teams (Wave 3) — named agent groups: inbox lanes, assignment targets, routing pools.
// Mirrors the api's Team shape (src/teams.ts) + the ticket team-lane mutation.

export interface Team {
  id: string;
  name: string;
  emoji: string | null;
  memberIds: string[];
  memberCount: number;
  /** Open tickets currently in this team's lane. */
  openCount: number;
  created_at: string;
}

export interface TeamInput {
  name: string;
  emoji?: string | null;
  /** Full-replace membership list. Omit to leave membership unchanged. */
  memberIds?: string[];
}

export async function fetchTeams(): Promise<Team[]> {
  return (await api<{ teams: Team[] }>("/teams")).teams;
}

export async function createTeam(input: TeamInput): Promise<Team> {
  return (await api<{ team: Team }>("/teams", { method: "POST", body: JSON.stringify(input) })).team;
}

export async function updateTeam(id: string, patch: Partial<TeamInput>): Promise<Team> {
  return (await api<{ team: Team }>(`/teams/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).team;
}

export async function deleteTeam(id: string): Promise<void> {
  await api(`/teams/${id}`, { method: "DELETE" });
}

/** Move a ticket into a team lane (teamId=null clears it). `autoAssign` also round-robins an
 *  assignee from the team's members. */
export async function setTicketTeam(
  ticketId: string,
  teamId: string | null,
  autoAssign = false,
): Promise<{ ticketId: string; teamId: string | null; assigneeId: string | null }> {
  return api(`/tickets/${ticketId}/team`, { method: "POST", body: JSON.stringify({ teamId, autoAssign }) });
}
