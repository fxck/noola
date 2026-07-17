import { useEffect, useState } from "react";
import { Users, Plus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { SettingsRail } from "@/components/settings-rail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { FormDialog } from "@/components/ui/form-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import type { ApiError } from "@/lib/api";
import { type AgentUser, fetchUsers, relativeTime } from "@/lib/tickets";
import { type Team, fetchTeams, createTeam, updateTeam, deleteTeam } from "@/lib/teams";

// Settings → Teams — named agent groups: shared inbox lanes, routing/assignment
// targets, round-robin pools. GET is viewer+; create/edit/delete are admin-only —
// the API's 403/409 messages surface through the toast (err.detail).

interface Draft {
  id: string | null;
  name: string;
  emoji: string;
  memberIds: string[];
}

const EMPTY_DRAFT: Draft = { id: null, name: "", emoji: "", memberIds: [] };

export function SettingsTeamsPage() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Team | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  function load() {
    setError(false);
    fetchTeams().then(setTeams).catch(() => setError(true));
  }
  useEffect(() => {
    load();
    fetchUsers().then(setUsers).catch(() => setUsers([]));
  }, []);

  function editTeam(t: Team) {
    setDraft({ id: t.id, name: t.name, emoji: t.emoji ?? "", memberIds: t.memberIds });
  }

  async function saveDraft() {
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    // memberIds is full-replace on PATCH — always send the picker's exact selection.
    const payload = {
      name: draft.name.trim(),
      emoji: draft.emoji.trim() || null,
      memberIds: draft.memberIds,
    };
    try {
      if (draft.id) await updateTeam(draft.id, payload);
      else await createTeam(payload);
      toast.success(draft.id ? "Team updated." : "Team created.");
      setDraft(null);
      load();
    } catch (e) {
      // 409 = duplicate name, 403 = not an admin — the server's message says which.
      toast.error((e as ApiError).detail ?? "Couldn't save the team.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteTeam(deleting.id);
      toast.success("Team deleted.");
      setDeleting(null);
      load();
    } catch (e) {
      toast.error((e as ApiError).detail ?? "Couldn't delete the team.");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <SettingsRail active="teams" />
        <div className="min-w-0 flex-1 overflow-y-auto">
          <header className="flex h-12 shrink-0 items-center gap-2 px-6">
            <h1 className="text-sm font-semibold tracking-tight">Teams</h1>
            {teams && teams.length > 0 && (
              <span className="text-sm tabular-nums text-muted-foreground">{teams.length}</span>
            )}
            <Button size="sm" variant="brand" className="ml-auto gap-1.5" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              <Plus className="size-4" /> New team
            </Button>
          </header>
          <p className="px-6 text-small text-muted-foreground">
            Group agents into shared inbox lanes — assign tickets to a team, route to it, or round-robin across its members.
          </p>
          <div className="max-w-3xl px-6 pb-10 pt-4">
            {error ? (
              <ErrorState title="Couldn't load teams" onRetry={load} />
            ) : teams === null ? (
              <RowsSkeleton rows={4} />
            ) : teams.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No teams yet"
                description="Teams give each group of agents its own inbox lane, a routing target for rules, and a round-robin pool for auto-assignment. Start with the shape of your org — Support, Billing, Success."
                action={
                  <Button size="sm" variant="brand" className="gap-1.5" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                    <Plus className="size-4" /> New team
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border bg-card shadow-sm">
                {teams.map((t) => (
                  <TeamRow key={t.id} team={t} onEdit={() => editTeam(t)} onDelete={() => setDeleting(t)} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <FormDialog
        open={draft !== null}
        title={draft?.id ? "Edit team" : "New team"}
        description="Name the lane and pick its members — the roster is what routing rules and round-robin assignment draw from."
        onClose={() => setDraft(null)}
        onSubmit={() => void saveDraft()}
        submitLabel={saving ? "Saving…" : draft?.id ? "Update team" : "Create team"}
        submitDisabled={!draft?.name.trim()}
        busy={saving}
      >
        {draft && <TeamEditor draft={draft} users={users} onChange={setDraft} />}
      </FormDialog>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this team?"
        message={
          deleting
            ? `“${deleting.name}” will be removed and its lane cleared — ${
                deleting.openCount === 0
                  ? "any tickets"
                  : `its ${deleting.openCount} open ticket${deleting.openCount === 1 ? "" : "s"}`
              } in the lane return to the shared inbox. No conversations are deleted.`
            : undefined
        }
        confirmLabel="Delete team"
        destructive
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

function TeamRow({ team: t, onEdit, onDelete }: { team: Team; onEdit: () => void; onDelete: () => void }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-base" aria-hidden>
        {t.emoji || <Users className="size-4 text-muted-foreground" />}
      </span>
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium">{t.name}</span>
        <span className="block text-xs tabular-nums text-muted-foreground">
          {t.memberCount} member{t.memberCount === 1 ? "" : "s"} · {t.openCount} open · created {relativeTime(t.created_at)}
        </span>
      </button>
      <Menu
        trigger={(open, toggle) => (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label={`Actions for ${t.name}`}
            aria-expanded={open}
            onClick={toggle}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        )}
      >
        <MenuItem icon={Pencil} label="Edit" onSelect={onEdit} />
        <MenuSeparator />
        <MenuItem icon={Trash2} label="Delete…" destructive onSelect={onDelete} />
      </Menu>
    </li>
  );
}

function TeamEditor({
  draft,
  users,
  onChange,
}: {
  draft: Draft;
  users: AgentUser[];
  onChange: (d: Draft) => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  const toggleMember = (id: string) =>
    set({
      memberIds: draft.memberIds.includes(id)
        ? draft.memberIds.filter((x) => x !== id)
        : [...draft.memberIds, id],
    });

  return (
    <div className="space-y-5">
      <div className="flex gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="team-name">Team name</Label>
          <Input
            id="team-name"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Billing"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-emoji">
            Emoji <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="team-emoji"
            value={draft.emoji}
            onChange={(e) => set({ emoji: e.target.value })}
            placeholder="💳"
            maxLength={4}
            className="w-20 text-center"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>
          Members{" "}
          <span className="font-normal text-muted-foreground">
            {draft.memberIds.length > 0 && `(${draft.memberIds.length} selected)`}
          </span>
        </Label>
        {users.length === 0 ? (
          <p className="text-xs text-muted-foreground">No agents in this workspace yet.</p>
        ) : (
          <div className="max-h-56 overflow-y-auto rounded-md border">
            <ul className="divide-y divide-border/50">
              {users.map((u) => {
                const on = draft.memberIds.includes(u.id);
                return (
                  // Row-click toggles; the Checkbox is the focusable control and
                  // stops propagation so its own toggle doesn't double-fire.
                  <li
                    key={u.id}
                    onClick={() => toggleMember(u.id)}
                    className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={on}
                      aria-label={`${on ? "Remove" : "Add"} ${u.name}`}
                      onClick={(e) => e.stopPropagation()}
                      onCheckedChange={() => toggleMember(u.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{u.name}</span>
                      <span className="block text-xs text-muted-foreground">{u.role}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Membership is the full list you save here — routing pools and round-robin use exactly these agents.
        </p>
      </div>
    </div>
  );
}
