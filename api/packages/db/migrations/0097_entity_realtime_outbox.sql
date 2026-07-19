-- 0097_entity_realtime_outbox.sql
-- Universal live updates: fan out INSERT/UPDATE/DELETE on the core entity tables the UI lists
-- (contacts, companies, teams, custom fields, macros, ticket types), so those surfaces update
-- live off the same outbox → edge → web bus that tickets/messages already ride (mig 0096 did
-- tickets). One generic SECURITY DEFINER trigger function, parameterised by entity name via
-- TG_ARGV[0]; the outbox INSERT bypasses outbox's FORCE-RLS the same way 0096 does.
--
-- Envelope matches ingest.ts: {id,type,tenantId,ticketId,occurredAt,data}. ticketId is '' (these
-- aren't ticket events) so the inbox — which refetches on ticket-bearing events — ignores them;
-- each entity surface subscribes on the `<entity>.` type prefix instead. Idempotent (re-runnable).

CREATE OR REPLACE FUNCTION emit_entity_outbox() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec   RECORD := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  ent   text   := TG_ARGV[0];
  verb  text   := CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END;
  etype text   := ent || '.' || verb;
BEGIN
  INSERT INTO outbox (tenant_id, event_type, subject, payload)
  VALUES (
    rec.tenant_id,
    etype,
    'noola.events.' || rec.tenant_id,
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'type', etype,
      'tenantId', rec.tenant_id,
      'ticketId', '',
      'occurredAt', to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'data', jsonb_build_object('entity', ent, 'entityId', rec.id, 'op', verb)
    )
  );
  RETURN NULL; -- AFTER trigger: return value ignored
END;
$$;

-- Attach INSERT + DELETE (always) and UPDATE (any change) for the settings-like tables whose
-- updates are user edits, not high-frequency system writes.
DO $$
DECLARE
  t text;
  ent text;
  pairs text[][] := ARRAY[
    ARRAY['companies','company'],
    ARRAY['teams','team'],
    ARRAY['custom_field_defs','custom_field'],
    ARRAY['macros','macro'],
    ARRAY['ticket_types','ticket_type']
  ];
  p text[];
BEGIN
  FOREACH p SLICE 1 IN ARRAY pairs LOOP
    t := p[1]; ent := p[2];
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_entity_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION emit_entity_outbox(%L)',
      'trg_entity_' || t, t, ent);
  END LOOP;
END $$;

-- contacts: INSERT/DELETE always, but UPDATE only when a LIST-VISIBLE identity field changes.
-- Contacts are UPDATE'd on every presence tick (bumpContactSeen writes last_seen_at / Web sessions);
-- firing on those would storm the bus. Guard to name/email/company/avatar so real edits still fan out.
DROP TRIGGER IF EXISTS trg_entity_contacts_ins ON contacts;
DROP TRIGGER IF EXISTS trg_entity_contacts_del ON contacts;
DROP TRIGGER IF EXISTS trg_entity_contacts_upd ON contacts;
CREATE TRIGGER trg_entity_contacts_ins AFTER INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION emit_entity_outbox('contact');
CREATE TRIGGER trg_entity_contacts_del AFTER DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION emit_entity_outbox('contact');
CREATE TRIGGER trg_entity_contacts_upd AFTER UPDATE ON contacts
  FOR EACH ROW WHEN (
       OLD.name       IS DISTINCT FROM NEW.name
    OR OLD.email      IS DISTINCT FROM NEW.email
    OR OLD.company_id IS DISTINCT FROM NEW.company_id
    OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
  ) EXECUTE FUNCTION emit_entity_outbox('contact');
