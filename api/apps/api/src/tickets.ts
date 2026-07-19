import { withTenant, relayPool } from "@repo/db";
import type { PoolClient } from "pg";

export type View = "my" | "unassigned" | "needs_reply" | "closed" | "all";

export interface TicketRow {
  id: string;
  subject: string;
  status: string;
  channel_type: string;
  external_channel_id: string | null;
  whose_turn: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar_url: string | null;
  priority: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** First agent reply time (min agent-message created_at) — drives first-response SLA. */
  first_response_at: string | null;
  /** Tenant-defined ticket type (taxonomy), or null. Name/color hydrated from ticket_types. */
  type_id: string | null;
  type_name: string | null;
  type_color: string | null;
  /** When this ticket was merged into another as a duplicate, the canonical ticket's id (else null).
   *  A merged ticket is closed + emptied (its messages moved to the canonical). */
  merged_into: string | null;
  /** When set (future), the ticket is snoozed — hidden from the open queues until this time, then
   *  auto-resurfaced. null = not snoozed. */
  snoozed_until: string | null;
  /** Keyword-classified customer sentiment (positive/neutral/negative), or null if unclassified. */
  sentiment: string | null;
  /** The team lane this conversation sits in (Wave 3), or null. Name hydrated from teams. */
  team_id: string | null;
  team_name: string | null;
  /** The contact this conversation belongs to (omnichannel), or null. Name hydrated from contacts. */
  contact_id: string | null;
  contact_name: string | null;
  contact_avatar_url: string | null;
  /** The contact's company (account), hydrated via contacts.company_id — row/rail context. */
  company_id: string | null;
  company_name: string | null;
  /** One-line snippet of the LATEST message (whitespace-collapsed, capped) — the list row's
   *  scan line, so the inbox reads what the conversation is at without opening it. */
  preview: string | null;
}

// The columns every ticket-list query selects (kept in one place so the view listing, the
// search hydrate, and the rich table query never drift). `first_response_at` is a correlated
// subquery (min agent-message time) so SLA state can be computed without a second round-trip.
const TICKET_COLS = `t.id, t.subject, t.status, t.channel_type, t.external_channel_id,
              t.whose_turn, t.assignee_id, u.name AS assignee_name, u.avatar_url AS assignee_avatar_url, t.priority, t.tags,
              t.created_at, t.updated_at, t.closed_at,
              (SELECT min(m.created_at) FROM messages m
                 WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id
                   AND m.author_type = 'agent') AS first_response_at,
              t.type_id,
              (SELECT tt.name FROM ticket_types tt
                 WHERE tt.tenant_id = t.tenant_id AND tt.id = t.type_id) AS type_name,
              (SELECT tt.color FROM ticket_types tt
                 WHERE tt.tenant_id = t.tenant_id AND tt.id = t.type_id) AS type_color,
              t.merged_into, t.snoozed_until, t.sentiment,
              t.support_mode, t.external_thread_id, t.external_guild_id,
              t.team_id,
              (SELECT tem.name FROM teams tem
                 WHERE tem.tenant_id = t.tenant_id AND tem.id = t.team_id) AS team_name,
              t.contact_id, co.name AS contact_name, co.avatar_url AS contact_avatar_url,
              co.company_id,
              (SELECT cp.name FROM companies cp
                 WHERE cp.tenant_id = t.tenant_id AND cp.id = co.company_id) AS company_name,
              (SELECT left(regexp_replace(m.body, '\\s+', ' ', 'g'), 140) FROM messages m
                 WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id
                 ORDER BY m.created_at DESC LIMIT 1) AS preview`;

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Inbox listing filtered by View. Tenant-scoped by RLS; the View is a WHERE over
 *  (status, assignee_id, whose_turn). 'my' with no assignee returns nothing. */
export async function listTickets(
  tenantId: string,
  view: View,
  assigneeId?: string,
): Promise<TicketRow[]> {
  let where = "WHERE t.status = 'open'";
  const params: unknown[] = [];
  if (view === "my") {
    if (!assigneeId) return [];
    params.push(assigneeId);
    where = `WHERE t.status = 'open' AND t.assignee_id = $${params.length}`;
  } else if (view === "unassigned") {
    where = "WHERE t.status = 'open' AND t.assignee_id IS NULL";
  } else if (view === "needs_reply") {
    // Community-mode threads (support_mode='community') keep whose_turn='us' (an unanswered
    // question → deflect-eligible) but are NOT agent work — exclude them from needs-reply (§5.1).
    where = "WHERE t.status = 'open' AND t.whose_turn = 'us' AND t.support_mode = 'staffed'";
  } else if (view === "closed") {
    where = "WHERE t.status = 'closed'";
  }
  // Snoozed tickets drop out of the open queues until their wake time (a closed-view listing still
  // shows them). The wake sweep clears the flag, but the predicate also resurfaces them the instant
  // the time passes even before the sweep runs.
  if (view !== "closed") where += " AND (t.snoozed_until IS NULL OR t.snoozed_until <= now())";
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${TICKET_COLS}
         FROM tickets t
         LEFT JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.assignee_id
         LEFT JOIN contacts co ON co.tenant_id = t.tenant_id AND co.id = t.contact_id
         ${where}
        ORDER BY t.updated_at DESC LIMIT 100`,
      params,
    );
    return r.rows as TicketRow[];
  });
}

// ── Deep ticketing: the rich, filterable/sortable/paginated ticket table ─────────
export interface TicketQuery {
  status?: "open" | "closed" | "all";
  priority?: string[];       // any-of
  tags?: string[];           // must contain ALL
  assigneeId?: string;       // "none" = unassigned
  teamId?: string;           // "none" = no team lane
  channelType?: string;
  q?: string;                // subject search (ILIKE)
  sortBy?: "updated_at" | "created_at" | "priority" | "sla";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

const TICKET_SORT_FIELDS = new Set(["updated_at", "created_at", "priority"]);

// The SLA-urgency sort key, computed in SQL so the ORDER BY (and thus pagination) sees the whole
// set — not just one page re-sorted in JS. `sla_due` is the wall-clock the ACTIVE target is due:
// first-response until an agent has replied, then resolution. NULL when SLA is off or the ticket is
// closed, so those sink to the end (NULLS LAST). This mirrors computeSla's calendar branch; when
// business hours are on the exact badge still comes from computeSla (JS), but the ORDER stays
// faithful because addBusinessMinutes is monotonic in created_at — same-target tickets keep order.
const SLA_DUE_EXPR = `CASE WHEN sp.enabled AND t.status = 'open' THEN
    t.created_at + (CASE WHEN (SELECT min(m.created_at) FROM messages m
                               WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id
                                 AND m.author_type = 'agent') IS NULL
                        THEN sp.first_response_mins ELSE sp.resolution_mins END) * interval '1 minute'
  END`;

/** Paginated ticket query for the tickets table. Every filter is a parameterised AND-clause;
 *  RLS scopes to the tenant underneath. Returns the page rows + the total match count (for
 *  pager UI). `priority` sort orders urgent→low via a CASE (text order would be alphabetical). */
export async function queryTickets(
  tenantId: string,
  query: TicketQuery,
): Promise<{ rows: TicketRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, val: unknown) => { params.push(val); clauses.push(sql.replace("$?", `$${params.length}`)); };

  if (query.status && query.status !== "all") add("t.status = $?", query.status);
  // Hide currently-snoozed tickets from the open filter (they resurface at their wake time).
  if (query.status === "open") clauses.push("(t.snoozed_until IS NULL OR t.snoozed_until <= now())");
  if (query.priority?.length) add("t.priority = ANY($?::text[])", query.priority);
  if (query.tags?.length) add("t.tags @> $?::text[]", query.tags);
  if (query.assigneeId === "none") clauses.push("t.assignee_id IS NULL");
  else if (query.assigneeId) add("t.assignee_id = $?", query.assigneeId);
  if (query.teamId === "none") clauses.push("t.team_id IS NULL");
  else if (query.teamId) add("t.team_id = $?", query.teamId);
  if (query.channelType) add("t.channel_type = $?", query.channelType);
  if (query.q?.trim()) add("t.subject ILIKE $?", `%${query.q.trim()}%`);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const isSla = query.sortBy === "sla";
  const sortBy = !isSla && query.sortBy && TICKET_SORT_FIELDS.has(query.sortBy) ? query.sortBy : "updated_at";
  const dir = query.sortDir === "asc" ? "ASC" : "DESC";
  // priority is a text column with no natural order → rank it explicitly.
  const orderExpr = sortBy === "priority"
    ? `CASE t.priority WHEN 'urgent' THEN 3 WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END`
    : `t.${sortBy}`;
  // SLA urgency: smaller sla_due = more urgent, so the table's default DESC ("urgent first", like
  // priority) maps to sla_due ASC. NULLS LAST keeps off-SLA/closed tickets at the bottom either way.
  const orderClause = isSla
    ? `sla_due ${dir === "DESC" ? "ASC" : "DESC"} NULLS LAST`
    : `${orderExpr} ${dir}`;
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  return withTenant(tenantId, async (c) => {
    const totalR = await c.query(`SELECT count(*)::int AS n FROM tickets t ${where}`, params);
    const total = (totalR.rows[0]?.n as number) ?? 0;
    const rowsR = await c.query(
      `SELECT ${TICKET_COLS}, ${SLA_DUE_EXPR} AS sla_due
         FROM tickets t
         LEFT JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.assignee_id
         LEFT JOIN contacts co ON co.tenant_id = t.tenant_id AND co.id = t.contact_id
         LEFT JOIN sla_policies sp ON sp.tenant_id = t.tenant_id
         ${where}
        ORDER BY ${orderClause}, t.updated_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { rows: rowsR.rows as TicketRow[], total };
  });
}

// Read a single ticket's full row on an EXISTING tenant-scoped connection (so a read-after-write
// in the same transaction sees the uncommitted write). getTicketDetail wraps this in withTenant.
async function selectTicket(c: PoolClient, id: string): Promise<TicketRow | null> {
  const r = await c.query(
    `SELECT ${TICKET_COLS}
       FROM tickets t
       LEFT JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.assignee_id
       LEFT JOIN contacts co ON co.tenant_id = t.tenant_id AND co.id = t.contact_id
      WHERE t.id = $1`,
    [id],
  );
  return r.rowCount ? (r.rows[0] as TicketRow) : null;
}

/** A single ticket's full row (for the routed /tickets/:id detail page). null if not visible. */
export async function getTicketDetail(tenantId: string, id: string): Promise<TicketRow | null> {
  return withTenant(tenantId, (c) => selectTicket(c, id));
}

/**
 * The channels an agent can send a reply on for this ticket — the union of the ticket's current
 * reply channel and every channel the contact is reachable on (their linked identities). Powers the
 * composer's channel picker so a reply can go out on any of the contact's channels, not just the
 * last inbound one. `current` is the default (the ticket's channel); `channels` is the deduped set
 * (current always included, even if the contact has no identity row for it yet).
 */
export async function getReplyChannels(
  tenantId: string,
  id: string,
): Promise<{ current: string; channels: string[] }> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.channel_type AS current,
              array(
                SELECT DISTINCT ch FROM (
                  SELECT t.channel_type AS ch
                  UNION
                  SELECT ci.channel_type FROM contact_identities ci
                    WHERE ci.tenant_id = t.tenant_id AND ci.contact_id = t.contact_id
                ) s
                WHERE ch IS NOT NULL
              ) AS channels
         FROM tickets t WHERE t.id = $1`,
      [id],
    );
    if (!r.rowCount) return { current: "synthetic", channels: [] };
    const row = r.rows[0] as { current: string; channels: string[] };
    return { current: row.current, channels: row.channels };
  });
}

/** Patch a ticket's priority and/or tags. Only the provided fields change. null if absent. */
export async function patchTicket(
  tenantId: string,
  id: string,
  patch: { priority?: TicketPriority; tags?: string[]; typeId?: string | null },
): Promise<TicketRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.priority !== undefined) { params.push(patch.priority); sets.push(`priority = $${params.length}`); }
  if (patch.tags !== undefined) { params.push(patch.tags); sets.push(`tags = $${params.length}::text[]`); }
  if (patch.typeId !== undefined) { params.push(patch.typeId); sets.push(`type_id = $${params.length}::uuid`); }
  if (sets.length === 0) return getTicketDetail(tenantId, id);
  params.push(id);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE tickets SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (!r.rowCount) return null;
    // Re-read on the SAME connection/transaction so it reflects the update just made.
    return selectTicket(c, id);
  });
}

export type MergeResult =
  | { ok: true; target: TicketRow; movedMessages: number }
  | { ok: false; reason: "source_not_found" | "target_not_found" | "same_ticket" | "already_merged" | "target_merged" };

/** Merge a duplicate ticket into a canonical one: move the source's messages to the target, then
 *  close + flag the source (`merged_into`). One tenant transaction so the move + flag are atomic;
 *  the composite (tenant_id, ticket_id) FK guarantees both tickets are the caller's. The emptied
 *  source is deliberately NOT indexed as a resolved thread (we bypass setTicketStatus). */
export async function mergeTicket(tenantId: string, sourceId: string, targetId: string): Promise<MergeResult> {
  if (sourceId === targetId) return { ok: false, reason: "same_ticket" };
  return withTenant(tenantId, async (c) => {
    const src = await c.query("SELECT id, merged_into FROM tickets WHERE id = $1", [sourceId]);
    if (!src.rowCount) return { ok: false, reason: "source_not_found" } as MergeResult;
    if (src.rows[0].merged_into) return { ok: false, reason: "already_merged" } as MergeResult;
    const tgt = await c.query("SELECT id, merged_into FROM tickets WHERE id = $1", [targetId]);
    if (!tgt.rowCount) return { ok: false, reason: "target_not_found" } as MergeResult;
    if (tgt.rows[0].merged_into) return { ok: false, reason: "target_merged" } as MergeResult;

    // Move the source's messages onto the canonical ticket. idempotency_key stays unique
    // (per-tenant, unchanged by the move), so no conflict.
    const moved = await c.query("UPDATE messages SET ticket_id = $1 WHERE ticket_id = $2", [targetId, sourceId]);
    // Close + flag the source as a merged duplicate.
    await c.query(
      `UPDATE tickets SET status = 'closed', status_category = 'closed', closed_at = now(),
                          merged_into = $1, updated_at = now()
        WHERE id = $2`,
      [targetId, sourceId],
    );
    // Touch the target so it surfaces as recently active (it just absorbed messages).
    await c.query("UPDATE tickets SET updated_at = now() WHERE id = $1", [targetId]);
    const target = await selectTicket(c, targetId);
    if (!target) return { ok: false, reason: "target_not_found" } as MergeResult;
    return { ok: true, target, movedMessages: moved.rowCount ?? 0 } as MergeResult;
  });
}

/** Snooze a ticket until `until` (ISO), or unsnooze when null. Snoozed tickets drop out of the open
 *  queues until then. Returns the updated row, or null if the ticket isn't the tenant's. */
export async function snoozeTicket(tenantId: string, id: string, until: string | null): Promise<TicketRow | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "UPDATE tickets SET snoozed_until = $1, updated_at = now() WHERE id = $2 RETURNING id",
      [until, id],
    );
    if (!r.rowCount) return null;
    return selectTicket(c, id);
  });
}

export interface SchedulerLog {
  info?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

let wakeRunning = false;

/** Per-minute sweep (wired in server.ts): resurface snoozed tickets whose wake time has passed —
 *  clear the flag and flip whose_turn to 'us' so they read as needing attention. Cross-tenant
 *  discovery on the BYPASSRLS relayPool; the wake UPDATE is tenant-scoped (app_user). Overlap-guarded. */
export async function wakeSnoozedTickets(log?: SchedulerLog): Promise<void> {
  if (wakeRunning) return;
  wakeRunning = true;
  try {
    const tenants = await relayPool.query(
      "SELECT DISTINCT tenant_id FROM tickets WHERE snoozed_until IS NOT NULL AND snoozed_until <= now()",
    );
    for (const t of tenants.rows) {
      try {
        const r = await withTenant(t.tenant_id as string, (c) =>
          c.query(
            `UPDATE tickets SET snoozed_until = NULL, whose_turn = 'us', updated_at = now()
              WHERE snoozed_until IS NOT NULL AND snoozed_until <= now()`,
          ),
        );
        if (r.rowCount) log?.info?.({ tenantId: t.tenant_id, woke: r.rowCount }, "woke snoozed tickets");
      } catch (e) {
        log?.error?.({ err: e, tenantId: t.tenant_id }, "wake snoozed tickets failed");
      }
    }
  } catch (e) {
    log?.error?.({ err: e }, "snooze wake sweep failed");
  } finally {
    wakeRunning = false;
  }
}

/** Hydrate full ticket rows for a set of ids (from search), preserving the given
 *  order. Runs through RLS (withTenant) so it is a second, independent tenant
 *  guard on top of Typesense's filter_by: even a hit id smuggled from another
 *  tenant returns no row here. Ids not visible to this tenant silently drop. */
export async function hydrateTickets(tenantId: string, ids: string[]): Promise<TicketRow[]> {
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${TICKET_COLS}
         FROM tickets t
         LEFT JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.assignee_id
         LEFT JOIN contacts co ON co.tenant_id = t.tenant_id AND co.id = t.contact_id
        WHERE t.id = ANY($1::uuid[])
        ORDER BY array_position($1::uuid[], t.id)`,
      [ids],
    );
    return r.rows as TicketRow[];
  });
}

/** Assign (assigneeId=null unassigns). Throws pg 23503 if the assignee isn't a user
 *  in this tenant — the composite FK is the cross-tenant guard. null if ticket absent. */
export async function assignTicket(
  tenantId: string,
  ticketId: string,
  assigneeId: string | null,
): Promise<{ ticketId: string; assigneeId: string | null } | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "UPDATE tickets SET assignee_id = $1, updated_at = now() WHERE id = $2 RETURNING id, assignee_id",
      [assigneeId, ticketId],
    );
    return r.rowCount ? { ticketId: r.rows[0].id, assigneeId: r.rows[0].assignee_id } : null;
  });
}

/** Move a ticket into a team lane (teamId = null clears it). With autoAssign, also round-robins
 *  an assignee from the team's members — lane move + person pick land in ONE txn so the cursor
 *  bump is never orphaned. Throws pg 23503 for a foreign team id (composite FK guard). */
export async function setTicketTeam(
  tenantId: string,
  ticketId: string,
  teamId: string | null,
  autoAssign = false,
): Promise<{ ticketId: string; teamId: string | null; assigneeId: string | null } | null> {
  const { resolveAssignee } = await import("./assignments.js");
  return withTenant(tenantId, async (c) => {
    if (teamId && autoAssign) {
      const assigneeId = await resolveAssignee(c, {
        strategy: "round_robin",
        teamId,
        cursorKey: `team:${teamId}`,
      });
      const r = await c.query(
        "UPDATE tickets SET team_id = $1, assignee_id = COALESCE($2, assignee_id), updated_at = now() WHERE id = $3 RETURNING id, team_id, assignee_id",
        [teamId, assigneeId, ticketId],
      );
      return r.rowCount
        ? { ticketId: r.rows[0].id, teamId: r.rows[0].team_id, assigneeId: r.rows[0].assignee_id }
        : null;
    }
    const r = await c.query(
      "UPDATE tickets SET team_id = $1, updated_at = now() WHERE id = $2 RETURNING id, team_id, assignee_id",
      [teamId, ticketId],
    );
    return r.rowCount
      ? { ticketId: r.rows[0].id, teamId: r.rows[0].team_id, assigneeId: r.rows[0].assignee_id }
      : null;
  });
}

/** Append tags (deduped, order-preserving) to a ticket — the atomic body behind the `add_tags`
 *  flow action. Returns the updated row or null if the ticket is absent. */
export async function addTicketTags(
  tenantId: string,
  ticketId: string,
  tags: string[],
): Promise<TicketRow | null> {
  const clean = tags.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) return getTicketDetail(tenantId, ticketId);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE tickets SET tags = (
         SELECT array_agg(DISTINCT x) FROM unnest(tags || $1::text[]) x
       ), updated_at = now() WHERE id = $2 RETURNING id`,
      [clean, ticketId],
    );
    if (!r.rowCount) return null;
    return selectTicket(c, ticketId);
  });
}

/** Close/reopen — the open/closed lifecycle behind the Views. null if ticket absent. */
export async function setTicketStatus(
  tenantId: string,
  ticketId: string,
  status: "open" | "closed",
): Promise<{ ticketId: string; status: string } | null> {
  const closedAt = status === "closed" ? "now()" : "NULL";
  const out = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE tickets SET status = $1, closed_at = ${closedAt}, updated_at = now() WHERE id = $2 RETURNING id`,
      [status, ticketId],
    );
    return r.rowCount ? { ticketId: r.rows[0].id as string, status } : null;
  });
  // Score the conversation the moment it's resolved (best-effort, off the write path) so the QA
  // review list stays current without a backfill sweep. Reopens don't score.
  if (out && status === "closed") {
    void import("./qa.js").then((m) => m.scoreTicketBestEffort(tenantId, out.ticketId)).catch(() => {});
  }
  return out;
}

export type BulkAction = "close" | "reopen" | "assign" | "team" | "priority" | "tag";

/** Apply one action to many tickets in a single tenant-scoped transaction. `value` is the
 *  assignee id (assign, null=unassign), priority, or tag to append. Returns rows affected. */
/** Apply a bulk action and RETURN the ids actually affected (for `close`/`reopen`, only the tickets
 *  that transitioned — so the caller can emit `ticket.closed` exactly once per real close). */
export async function bulkTickets(
  tenantId: string,
  ids: string[],
  action: BulkAction,
  value: string | null,
): Promise<string[]> {
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (c) => {
    let sql: string;
    const params: unknown[] = [ids];
    switch (action) {
      case "close":
        // Only rows that were open transition — a re-close is not a fresh ticket.closed.
        sql = `UPDATE tickets SET status='closed', closed_at=now(), updated_at=now() WHERE id = ANY($1::uuid[]) AND status <> 'closed'`;
        break;
      case "reopen":
        sql = `UPDATE tickets SET status='open', closed_at=NULL, updated_at=now() WHERE id = ANY($1::uuid[]) AND status <> 'open'`;
        break;
      case "assign":
        params.push(value); // null = unassign
        sql = `UPDATE tickets SET assignee_id=$2, updated_at=now() WHERE id = ANY($1::uuid[])`;
        break;
      case "team":
        params.push(value); // null = clear the team lane
        sql = `UPDATE tickets SET team_id=$2, updated_at=now() WHERE id = ANY($1::uuid[])`;
        break;
      case "priority":
        params.push(value);
        sql = `UPDATE tickets SET priority=$2, updated_at=now() WHERE id = ANY($1::uuid[])`;
        break;
      case "tag":
        params.push(value);
        // Append the tag, de-duplicated, preserving existing order.
        sql = `UPDATE tickets SET tags = (
                 SELECT array_agg(DISTINCT x) FROM unnest(tags || ARRAY[$2]::text[]) x
               ), updated_at=now() WHERE id = ANY($1::uuid[])`;
        break;
    }
    const r = await c.query(`${sql} RETURNING id`, params);
    return r.rows.map((x: { id: string }) => x.id);
  });
}

export async function listUsers(tenantId: string): Promise<unknown[]> {
  const { clearExpiredOoo } = await import("./assignments.js");
  return withTenant(tenantId, async (c) => {
    await clearExpiredOoo(c); // auto-return: expired Away flags clear on read
    const r = await c.query(
      "SELECT id, name, email, role, skills, out_of_office, ooo_until, max_open_tickets, avatar_url FROM users ORDER BY name",
    );
    return r.rows;
  });
}
