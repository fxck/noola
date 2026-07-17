import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ScrollText,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  KeyRound,
  UserCog,
  GitMerge,
  type LucideIcon,
} from "lucide-react";
import { type AuditEntry, type AuditVerifyResult, fetchAudit, verifyAudit } from "@/lib/audit";
import { relativeTime } from "@/lib/tickets";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { SettingsPage } from "@/components/settings-page";
import { cn } from "@/lib/utils";

type Status = "loading" | "ready" | "error";

// Human labels for the recorded action verbs (falls back to the raw slug).
const ACTION_LABEL: Record<string, string> = {
  "member.role_changed": "Changed a member's role",
  "api_key.created": "Created an API key",
  "api_key.revoked": "Revoked an API key",
  "ticket.merged": "Merged a ticket",
  "contact.merged": "Merged a contact",
};

// Per-action icon + tint (D7). Semantic tints only where the action carries real weight —
// create is success, revoke is destructive — everything else stays neutral graphite so the
// ledger doesn't turn into a rainbow. Amber stays reserved as signal, not decoration.
const ACTION_META: Record<string, { Icon: LucideIcon; tint: string }> = {
  "member.role_changed": { Icon: UserCog, tint: "text-muted-foreground" },
  "api_key.created": { Icon: KeyRound, tint: "text-success" },
  "api_key.revoked": { Icon: KeyRound, tint: "text-destructive" },
  "ticket.merged": { Icon: GitMerge, tint: "text-muted-foreground" },
  "contact.merged": { Icon: GitMerge, tint: "text-muted-foreground" },
};

function actionMeta(action: string): { Icon: LucideIcon; tint: string } {
  return ACTION_META[action] ?? { Icon: ScrollText, tint: "text-muted-foreground" };
}

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function summarizeMeta(meta: Record<string, unknown>): string {
  const parts = Object.entries(meta)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  return parts.join(" · ");
}

export function SettingsAuditPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<AuditVerifyResult | null>(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      setEntries(await fetchAudit({ limit: 200 }));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runVerify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      setVerifyResult(await verifyAudit());
    } catch {
      setVerifyResult({ ok: false, count: 0, reason: "verification request failed" });
    } finally {
      setVerifying(false);
    }
  }

  // Action-type filter menu, seeded from the actions actually present, with per-type counts.
  const filterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
    return [
      { value: "all", label: "All actions", hint: entries.length },
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([action, n]) => ({ value: action, label: ACTION_LABEL[action] ?? action, hint: n })),
    ];
  }, [entries]);

  const visible = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.action === filter)),
    [entries, filter],
  );

  return (
    <SettingsPage
      active="audit"
      title="Audit log"
      description="A tamper-evident record of sensitive actions — each entry is chained to the last with a keyed hash."
      status={status}
      onRetry={() => void load()}
      errorTitle="Couldn't load the audit log"
      actions={
        <Button
          size="sm"
          className="h-8 shrink-0 gap-1.5 whitespace-nowrap"
          onClick={() => void runVerify()}
          disabled={verifying || status !== "ready"}
        >
          {verifying ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <ShieldCheck className="size-3.5" />
          )}
          Verify chain
        </Button>
      }
    >
      <div className="max-w-3xl px-6 pb-10 pt-4">
            {verifyResult && (
              <div
                className={cn(
                  "mb-4 flex items-center gap-2 rounded-lg border p-3 text-sm",
                  verifyResult.ok
                    ? "border-success/30 bg-success/5 text-success"
                    : "border-warning/30 bg-warning/5 text-warning",
                )}
              >
                {verifyResult.ok ? <ShieldCheck className="size-4" /> : <ShieldAlert className="size-4" />}
                {verifyResult.ok
                  ? `Chain intact — ${verifyResult.count} ${verifyResult.count === 1 ? "entry" : "entries"} verified.`
                  : `Chain broken at #${verifyResult.brokenAt ?? "?"}${verifyResult.reason ? ` (${verifyResult.reason})` : ""}.`}
              </div>
            )}

            {entries.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed p-8 text-center">
                <ScrollText className="size-6 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No audited actions yet.</p>
              </div>
            ) : (
              <>
                {filterOptions.length > 2 && (
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="w-56">
                      <Combobox value={filter} onChange={setFilter} options={filterOptions} align="start" />
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {visible.length} {visible.length === 1 ? "entry" : "entries"}
                    </span>
                  </div>
                )}

                {visible.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                    No entries for this action.
                  </div>
                ) : (
                  <ul className="overflow-hidden rounded-lg border">
                    {visible.map((e, i) => {
                      const metaStr = summarizeMeta(e.meta);
                      const { Icon, tint } = actionMeta(e.action);
                      const showDay = i === 0 || dayKey(e.createdAt) !== dayKey(visible[i - 1].createdAt);
                      return (
                        <li key={e.id}>
                          {showDay && (
                            <div className="border-b bg-muted/40 px-4 py-1.5 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                              {dayKey(e.createdAt)}
                            </div>
                          )}
                          <div className={cn("flex items-start gap-3 px-4 py-2.5", i > 0 && !showDay && "border-t")}>
                            <span className="mt-0.5 w-9 shrink-0 text-right font-mono text-micro tabular-nums text-muted-foreground/70">
                              #{e.seq}
                            </span>
                            <span
                              className={cn(
                                "mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted",
                                tint,
                              )}
                              aria-hidden
                            >
                              <Icon className="size-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium">
                                  {ACTION_LABEL[e.action] ?? e.action}
                                </span>
                                <span
                                  className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground"
                                  title={e.hash}
                                >
                                  {e.hash.slice(0, 8)}
                                </span>
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                                <span>{e.actorName || "system"}</span>
                                {e.entityId && (
                                  <>
                                    <span className="text-muted-foreground/40">·</span>
                                    <span className="font-mono">
                                      {e.entityType} {e.entityId.slice(0, 8)}
                                    </span>
                                  </>
                                )}
                                <span className="text-muted-foreground/40">·</span>
                                <span>{relativeTime(e.createdAt)}</span>
                              </div>
                              {metaStr && (
                                <div className="mt-0.5 truncate text-micro text-muted-foreground/80" title={metaStr}>
                                  {metaStr}
                                </div>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
      </div>
    </SettingsPage>
  );
}
