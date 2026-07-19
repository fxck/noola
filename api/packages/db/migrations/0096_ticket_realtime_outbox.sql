-- 0096_ticket_realtime_outbox.sql
-- Live inbox on ticket STATE changes, not just new messages.
--
-- The realtime path is the transactional outbox (INSERT INTO outbox → the single-writer drainer
-- publishes to NATS → the Phoenix edge fans it out as "new_event" → the web reloads the inbox).
-- Message ingest writes an outbox row, so message-driven updates propagate live. But a standalone
-- ticket state change — a Discord ✅-reaction close, a bulk close, an automation set_status, an API
-- PATCH — only UPDATEs the row and writes NO outbox event, so the inbox stayed stale until reload.
--
-- Fix it at the source: an AFTER UPDATE trigger on tickets emits a 'ticket.updated' outbox row (the
-- same envelope shape ingest.ts uses) whenever a user-visible triage field changes. One trigger
-- covers every mutation path, current and future. `whose_turn` is intentionally excluded — it flips
-- alongside a message, which already emits its own outbox event, so including it would double-fire.
--
-- SECURITY DEFINER (owner = the superuser migration role) so the outbox INSERT lands regardless of
-- the updating session's tenant GUC — mirrors the 0021 projection triggers. Idempotent (re-runnable).

CREATE OR REPLACE FUNCTION emit_ticket_update_outbox() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (NEW.status        IS DISTINCT FROM OLD.status
   OR NEW.assignee_id   IS DISTINCT FROM OLD.assignee_id
   OR NEW.priority      IS DISTINCT FROM OLD.priority
   OR NEW.team_id       IS DISTINCT FROM OLD.team_id
   OR NEW.type_id       IS DISTINCT FROM OLD.type_id
   OR NEW.snoozed_until IS DISTINCT FROM OLD.snoozed_until
   OR NEW.tags          IS DISTINCT FROM OLD.tags) THEN
    INSERT INTO outbox (tenant_id, event_type, subject, payload)
    VALUES (
      NEW.tenant_id,
      'ticket.updated',
      'noola.events.' || NEW.tenant_id,
      jsonb_build_object(
        'id', gen_random_uuid()::text,
        'type', 'ticket.updated',
        'tenantId', NEW.tenant_id,
        'ticketId', NEW.id,
        'occurredAt', to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'data', jsonb_build_object(
          'status', NEW.status,
          'assigneeId', NEW.assignee_id,
          'priority', NEW.priority,
          'teamId', NEW.team_id
        )
      )
    );
  END IF;
  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$$;

DROP TRIGGER IF EXISTS trg_emit_ticket_update_outbox ON tickets;
CREATE TRIGGER trg_emit_ticket_update_outbox
  AFTER UPDATE ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION emit_ticket_update_outbox();
