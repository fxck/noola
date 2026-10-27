-- Wave 5: custom data events — a per-contact activity timeline (Intercom-style "events"). Each row is
-- a named event ("logged_in", "upgraded_plan", "invoice_paid") with an optional JSON metadata blob,
-- attributed to a contact. Custom data ATTRIBUTES already live on contacts.attributes; this adds the
-- time-series companion. Ingested via the authed API and a public api-key lane (events:write scope).

CREATE TABLE IF NOT EXISTS contact_events (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL,
  name       text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT contact_events_contact_fk
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);

-- Timeline reads: newest-first per contact.
CREATE INDEX IF NOT EXISTS contact_events_contact_idx
  ON contact_events (tenant_id, contact_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON contact_events TO app_user;
GRANT SELECT ON contact_events TO event_relay;
ALTER TABLE contact_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_events_isolation ON contact_events;
CREATE POLICY contact_events_isolation ON contact_events
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
