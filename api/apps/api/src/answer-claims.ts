import { withTenant } from "@repo/db";

// Answer arbitration (§5.2) — one claim per customer turn, channel-agnostic. Three answerers can
// fire on one turn (evaluateAutoreply, the automations `reply` action, and a future on-demand /ask);
// the single-row INSERT into answer_claims serializes them so exactly one posts. The claim is taken
// at the LAST moment (after every gate passes and the answerer is about to POST) — a bail must never
// call this, or it starves the turn's single claim.

/** Take the single answer claim for a customer turn. Returns true iff THIS caller won.
 *  Call ONLY after every gate has passed and you are about to POST (a bail must never
 *  call this — else it starves the turn). §5.2. Runs via app_user/withTenant → the
 *  0076 INSERT grant covers it; the prune's DELETE runs separately as event_relay. */
export async function claimAnswer(
  tenantId: string,
  messageId: string,
  claimant: "autoreply" | "automations" | "on_demand",
): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO answer_claims (tenant_id, message_id, claimant)
         VALUES (current_tenant(), $1, $2)
       ON CONFLICT (tenant_id, message_id) DO NOTHING
       RETURNING message_id`,
      [messageId, claimant],
    );
    return r.rowCount === 1;
  });
}

/** The automations `reply` action's arbitration + mode gate — kept OUT of automations.ts so the
 *  studio merge touches that file in exactly one preserved line. Returns true iff the reply may post.
 *  Resolves the triggering customer message from ctx.messageId, else the ticket's latest customer
 *  message; if none, there is no turn to arbitrate → allow. On support_mode='community' the reply
 *  action stands down (Phase 1 default: the deflect answerer is autoreply, not a Studio reply). */
export async function claimAnswerForAutomationReply(
  tenantId: string,
  ctx: { ticketId?: string; messageId?: unknown },
): Promise<boolean> {
  if (!ctx.ticketId) return true;
  return withTenant(tenantId, async (c) => {
    let messageId = typeof ctx.messageId === "string" ? ctx.messageId : null;
    const t = await c.query("SELECT support_mode FROM tickets WHERE id = $1", [ctx.ticketId]);
    if (t.rowCount && t.rows[0].support_mode === "community") return false; // stand down
    if (!messageId) {
      const m = await c.query(
        "SELECT id FROM messages WHERE ticket_id = $1 AND author_type = 'customer' ORDER BY created_at DESC LIMIT 1",
        [ctx.ticketId],
      );
      messageId = m.rowCount ? (m.rows[0].id as string) : null;
    }
    if (!messageId) return true; // agent-initiated event, no customer turn → nothing to arbitrate
    const r = await c.query(
      `INSERT INTO answer_claims (tenant_id, message_id, claimant)
         VALUES (current_tenant(), $1, 'automations')
       ON CONFLICT (tenant_id, message_id) DO NOTHING RETURNING message_id`,
      [messageId],
    );
    return r.rowCount === 1;
  });
}
