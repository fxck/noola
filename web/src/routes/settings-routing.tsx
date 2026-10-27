import { useEffect, useState } from "react";
import { Route as RouteIcon, Plus, X, Trash2, Pencil, Check, ChevronDown, GripVertical } from "lucide-react";
import { SettingsRail } from "@/components/settings-rail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Menu, MenuItem } from "@/components/ui/menu";
import { FormDialog } from "@/components/ui/form-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { type AgentUser, fetchUsers } from "@/lib/tickets";
import { type Team, fetchTeams } from "@/lib/teams";
import {
  type RoutingRule,
  type RoutingCondition,
  type RoutingField,
  type RoutingOp,
  type RoutingStrategy,
  ROUTING_FIELDS,
  ROUTING_OPS,
  ROUTING_STRATEGIES,
  STRATEGY_LABEL,
  fetchRoutingRules,
  createRoutingRule,
  updateRoutingRule,
  deleteRoutingRule,
} from "@/lib/routing";

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/**
 * Popover value picker for THIS page's FormDialog. `PopoverSelect` can't be used here:
 * the FormDialog overlay sits at z-[60] while ui/popover panels default to z-50, and
 * only `Menu` exposes the panel className needed to lift the menu above the overlay.
 * The trigger mirrors ui/input.tsx so it reads as a form control.
 */
function DialogSelect({
  value,
  options,
  onChange,
  fullWidth,
}: {
  value: string | null;
  options: { value: string | null; label: string }[];
  onChange: (v: string | null) => void;
  fullWidth?: boolean;
}) {
  const current = options.find((o) => (o.value ?? "") === (value ?? ""));
  return (
    <Menu
      align="start"
      width={192}
      className="z-[70]"
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "inline-flex h-9 max-w-full items-center justify-between gap-1.5 rounded-md border border-input bg-background px-3 py-1 text-sm font-normal shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            fullWidth && "w-full",
            (!current || current.value === null) && "text-muted-foreground",
          )}
        >
          <span className="truncate">{current?.label ?? "—"}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      )}
    >
      {options.map((o) => (
        <MenuItem
          key={o.value ?? "__none"}
          label={o.label}
          selected={(o.value ?? "") === (value ?? "")}
          onSelect={() => onChange(o.value)}
        />
      ))}
    </Menu>
  );
}
const FIELD_LABEL: Record<RoutingField, string> = { channel: "Channel", subject: "Subject", priority: "Priority", tag: "Tag" };
const OP_LABEL: Record<RoutingOp, string> = { eq: "is", contains: "contains" };

interface Draft {
  id: string | null;
  name: string;
  enabled: boolean;
  conditions: RoutingCondition[];
  strategy: RoutingStrategy;
  /** "team" targets a team lane + its member pool; "agents" is the classic pool. */
  target: "agents" | "team";
  teamId: string | null;
  assigneeIds: string[];
  setPriority: string;
  addTags: string[];
  requiredSkills: string[];
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  enabled: true,
  conditions: [],
  strategy: "round_robin",
  target: "agents",
  teamId: null,
  assigneeIds: [],
  setPriority: "",
  addTags: [],
  requiredSkills: [],
};

export function SettingsRoutingPage() {
  const [rules, setRules] = useState<RoutingRule[] | null>(null);
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    setError(false);
    fetchRoutingRules().then(setRules).catch(() => setError(true));
  }
  useEffect(() => {
    load();
    fetchUsers().then(setUsers).catch(() => setUsers([]));
    fetchTeams().then(setTeams).catch(() => setTeams([]));
  }, []);

  const nameById = (id: string) => users.find((u) => u.id === id)?.name ?? "—";
  const teamLabel = (id: string) => {
    const t = teams.find((x) => x.id === id);
    return t ? [t.emoji, t.name].filter(Boolean).join(" ") : "a team";
  };

  function editRule(r: RoutingRule) {
    setDraft({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      conditions: r.conditions,
      // The api treats team+"specific" as round_robin — mirror that in the form.
      strategy: r.team_id && r.strategy === "specific" ? "round_robin" : r.strategy,
      target: r.team_id ? "team" : "agents",
      teamId: r.team_id,
      assigneeIds: r.assignee_ids,
      setPriority: r.set_priority ?? "",
      addTags: r.add_tags,
      requiredSkills: r.required_skills,
    });
  }

  async function toggleEnabled(r: RoutingRule) {
    setRules((rs) => rs?.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) ?? null);
    try {
      await updateRoutingRule(r.id, { enabled: !r.enabled });
    } catch {
      toast.error("Couldn't update the rule.");
      load();
    }
  }

  async function remove(r: RoutingRule) {
    setRules((rs) => rs?.filter((x) => x.id !== r.id) ?? null);
    try {
      await deleteRoutingRule(r.id);
      toast.success("Rule deleted.");
    } catch {
      toast.error("Couldn't delete the rule.");
      load();
    }
  }

  async function saveDraft() {
    if (!draft || !draft.name.trim()) return;
    const teamMode = draft.target === "team";
    if (teamMode && !draft.teamId) return;
    setSaving(true);
    const payload = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      conditions: draft.conditions.filter((c) => c.value.trim()),
      strategy: draft.strategy,
      teamId: teamMode ? draft.teamId : null,
      assigneeIds: teamMode ? [] : draft.assigneeIds,
      setPriority: draft.setPriority || null,
      addTags: draft.addTags,
      requiredSkills: draft.requiredSkills,
    };
    try {
      if (draft.id) await updateRoutingRule(draft.id, payload);
      else await createRoutingRule(payload);
      toast.success(draft.id ? "Rule updated." : "Rule created.");
      setDraft(null);
      load();
    } catch {
      toast.error("Couldn't save the rule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <SettingsRail active="routing" />
        <div className="min-w-0 flex-1 overflow-y-auto">
          <header className="flex h-12 shrink-0 items-center gap-2 px-6">
            <h1 className="text-sm font-semibold tracking-tight">Routing &amp; assignment</h1>
            {rules && rules.length > 0 && (
              <span className="text-sm tabular-nums text-muted-foreground">{rules.length}</span>
            )}
            <Button size="sm" variant="brand" className="ml-auto gap-1.5" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              <Plus className="size-4" /> New rule
            </Button>
          </header>
          <p className="px-6 text-small text-muted-foreground">
            Auto-assign new tickets — rules run top to bottom and the first full match wins.
          </p>
          <div className="max-w-3xl px-6 pb-10 pt-4">
            {error ? (
              <ErrorState title="Couldn't load routing rules" onRetry={load} />
            ) : rules === null ? (
              <RowsSkeleton rows={4} />
            ) : rules.length === 0 ? (
              <EmptyState
                icon={RouteIcon}
                title="No routing rules yet"
                description="New tickets stay unassigned until an agent picks them up. Add a rule to auto-assign."
                action={
                  <Button size="sm" variant="brand" className="gap-1.5" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                    <Plus className="size-4" /> New rule
                  </Button>
                }
              />
            ) : (
              <ol className="space-y-2">
                {rules.map((r, i) => (
                  <li
                    key={r.id}
                    className={cn(
                      "flex items-start gap-3 rounded-xl border bg-card p-4",
                      !r.enabled && "opacity-60",
                    )}
                  >
                    <span className="mt-0.5 flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                      <GripVertical className="size-4 text-muted-foreground/40" /> {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {STRATEGY_LABEL[r.team_id && r.strategy === "specific" ? "round_robin" : r.strategy]}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {r.conditions.length === 0
                          ? "Matches every new ticket"
                          : r.conditions.map((c) => `${FIELD_LABEL[c.field]} ${OP_LABEL[c.op]} “${c.value}”`).join(" and ")}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-micro text-muted-foreground">
                        <span>
                          → {r.team_id
                            ? teamLabel(r.team_id)
                            : r.strategy === "specific"
                            ? nameById(r.assignee_ids[0] ?? "")
                            : r.assignee_ids.length === 0
                            ? "any agent"
                            : `${r.assignee_ids.length} agent${r.assignee_ids.length === 1 ? "" : "s"}`}
                        </span>
                        {r.required_skills.length > 0 && <span>· requires {r.required_skills.join(", ")}</span>}
                        {r.set_priority && <span>· priority: {r.set_priority}</span>}
                        {r.add_tags.map((t) => (
                          <span key={t}>#{t}</span>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Switch
                        checked={r.enabled}
                        aria-label={r.enabled ? "Disable rule" : "Enable rule"}
                        onCheckedChange={() => void toggleEnabled(r)}
                      />
                      <Button variant="ghost" size="icon" className="size-8" onClick={() => editRule(r)} aria-label="Edit rule">
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" onClick={() => void remove(r)} aria-label="Delete rule">
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>

      <FormDialog
        open={draft !== null}
        size="lg"
        title={draft?.id ? "Edit rule" : "New rule"}
        description="Match new tickets on their fields, then assign by strategy and optionally set a priority or add tags."
        onClose={() => setDraft(null)}
        onSubmit={() => void saveDraft()}
        submitLabel={saving ? "Saving…" : draft?.id ? "Update rule" : "Create rule"}
        submitDisabled={!draft?.name.trim() || (draft?.target === "team" && !draft.teamId)}
        busy={saving}
      >
        {draft && <RuleEditor draft={draft} users={users} teams={teams} onChange={setDraft} />}
      </FormDialog>
    </>
  );
}

function RuleEditor({
  draft,
  users,
  teams,
  onChange,
}: {
  draft: Draft;
  users: AgentUser[];
  teams: Team[];
  onChange: (d: Draft) => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const [tagDraft, setTagDraft] = useState("");
  const [skillDraft, setSkillDraft] = useState("");
  const teamMode = draft.target === "team";
  // "specific" is meaningless with a team (the api would treat it as round_robin).
  const strategies = teamMode ? ROUTING_STRATEGIES.filter((s) => s !== "specific") : ROUTING_STRATEGIES;

  const addCondition = () =>
    set({ conditions: [...draft.conditions, { field: "channel", op: "eq", value: "" }] });
  const updateCondition = (i: number, patch: Partial<RoutingCondition>) =>
    set({ conditions: draft.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const removeCondition = (i: number) => set({ conditions: draft.conditions.filter((_, j) => j !== i) });

  const toggleAssignee = (id: string) =>
    set({
      assigneeIds: draft.assigneeIds.includes(id)
        ? draft.assigneeIds.filter((x) => x !== id)
        : draft.strategy === "specific"
        ? [id]
        : [...draft.assigneeIds, id],
    });

  function addTag() {
    const v = tagDraft.trim();
    if (!v || draft.addTags.includes(v)) { setTagDraft(""); return; }
    set({ addTags: [...draft.addTags, v] });
    setTagDraft("");
  }

  // API limits: max 10 skills, each ≤40 chars (the input's maxLength enforces the latter).
  function addSkill() {
    const v = skillDraft.trim();
    if (!v || draft.requiredSkills.includes(v) || draft.requiredSkills.length >= 10) { setSkillDraft(""); return; }
    set({ requiredSkills: [...draft.requiredSkills, v] });
    setSkillDraft("");
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="rname">Rule name</Label>
        <Input id="rname" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Urgent email → senior team" autoFocus />
      </div>

      {/* Conditions */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label>Conditions {draft.conditions.length === 0 && <span className="font-normal text-muted-foreground">(matches every new ticket)</span>}</Label>
          <Button type="button" variant="ghost" size="sm" onClick={addCondition}><Plus className="size-3.5" /> Add</Button>
        </div>
        <div className="space-y-2">
          {draft.conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <DialogSelect
                value={c.field}
                options={ROUTING_FIELDS.map((f) => ({ value: f, label: FIELD_LABEL[f] }))}
                onChange={(v) => {
                  if (v !== null) updateCondition(i, { field: v as RoutingField });
                }}
              />
              <DialogSelect
                value={c.op}
                options={ROUTING_OPS.map((o) => ({ value: o, label: OP_LABEL[o] }))}
                onChange={(v) => {
                  if (v !== null) updateCondition(i, { op: v as RoutingOp });
                }}
              />
              <Input
                value={c.value}
                onChange={(e) => updateCondition(i, { value: e.target.value })}
                placeholder={c.field === "channel" ? "widget / email / discord…" : c.field === "priority" ? "urgent / high…" : "value"}
                className="h-9 w-44"
              />
              <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => removeCondition(i)} aria-label="Remove condition">
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Assignment target */}
      <div className="space-y-1.5">
        <Label>Assign to</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["agents", "team"] as const).map((t) => {
            const disabled = t === "team" && teams.length === 0;
            return (
              <button
                key={t}
                type="button"
                disabled={disabled}
                onClick={() =>
                  set(
                    t === "team"
                      ? { target: "team", strategy: draft.strategy === "specific" ? "round_robin" : draft.strategy }
                      : { target: "agents" },
                  )
                }
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  draft.target === t ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
                  disabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
                )}
              >
                {t === "agents" ? "Agents" : "Team"}
              </button>
            );
          })}
          {teams.length === 0 && (
            <span className="text-xs text-muted-foreground">Create teams in Settings → Teams</span>
          )}
        </div>
      </div>

      {/* Team target */}
      {teamMode && (
        <div className="space-y-1.5">
          {/* The label wraps the trigger so clicking it opens the menu */}
          <Label className="flex flex-col gap-1.5">
            <span>Team</span>
            <DialogSelect
              value={draft.teamId}
              options={teams.map((t) => ({ value: t.id, label: [t.emoji, t.name].filter(Boolean).join(" ") }))}
              onChange={(v) => set({ teamId: v })}
              fullWidth
            />
          </Label>
          <p className="text-xs text-muted-foreground">
            Matching tickets land in this team’s lane and are assigned from its members.
          </p>
        </div>
      )}

      {/* Strategy */}
      <div className="space-y-1.5">
        <Label>Assignment strategy</Label>
        <div className="flex flex-wrap gap-1.5">
          {strategies.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => set({ strategy: s, assigneeIds: s === "specific" ? draft.assigneeIds.slice(0, 1) : draft.assigneeIds })}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                draft.strategy === s ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {STRATEGY_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {draft.strategy === "specific"
            ? "Always assign to the one agent you pick."
            : draft.strategy === "round_robin"
            ? teamMode
              ? "Cycle through the team’s members in turn."
              : "Cycle through the selected agents in turn (all agents if none selected)."
            : teamMode
            ? "Assign to the team member with the fewest open tickets."
            : "Assign to whoever has the fewest open tickets (all agents if none selected)."}
        </p>
      </div>

      {/* Required skills — gates the pool in BOTH agent and team modes */}
      <div className="space-y-1.5">
        <Label>Required skills {draft.requiredSkills.length === 0 && <span className="font-normal text-muted-foreground">(optional)</span>}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            value={skillDraft}
            onChange={(e) => setSkillDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSkill(); } }}
            placeholder="Add a skill…"
            maxLength={40}
            className="h-9"
          />
          <Button type="button" variant="outline" size="icon" className="size-9 shrink-0" onClick={addSkill} aria-label="Add skill" disabled={draft.requiredSkills.length >= 10}><Plus className="size-4" /></Button>
        </div>
        {draft.requiredSkills.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {draft.requiredSkills.map((s) => (
              <span key={s} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
                {s}
                <button type="button" onClick={() => set({ requiredSkills: draft.requiredSkills.filter((x) => x !== s) })} aria-label={`Remove ${s}`}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">Only agents carrying every listed skill are eligible.</p>
      </div>

      {/* Assignee pool */}
      {!teamMode && (
        <div className="space-y-1.5">
          <Label>{draft.strategy === "specific" ? "Agent" : "Agent pool"}</Label>
          <div className="flex flex-wrap gap-1.5">
            {users.length === 0 && <span className="text-xs text-muted-foreground">No agents in this workspace yet.</span>}
            {users.map((u) => {
              const on = draft.assigneeIds.includes(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => toggleAssignee(u.id)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {on && <Check className="size-3" />} {u.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Optional effects */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          {/* The label wraps the trigger so clicking it opens the menu */}
          <Label className="flex flex-col gap-1.5">
            <span>Also set priority</span>
            <DialogSelect
              value={draft.setPriority || null}
              options={[
                { value: null, label: "— leave unchanged —" },
                ...PRIORITIES.map((p) => ({ value: p as string, label: p })),
              ]}
              onChange={(v) => set({ setPriority: v ?? "" })}
              fullWidth
            />
          </Label>
        </div>
        <div className="space-y-1.5">
          <Label>Also add tags</Label>
          <div className="flex items-center gap-1.5">
            <Input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              placeholder="Add a tag…"
              className="h-9"
            />
            <Button type="button" variant="outline" size="icon" className="size-9 shrink-0" onClick={addTag} aria-label="Add tag"><Plus className="size-4" /></Button>
          </div>
          {draft.addTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {draft.addTags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
                  #{t}
                  <button type="button" onClick={() => set({ addTags: draft.addTags.filter((x) => x !== t) })} aria-label={`Remove ${t}`}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
