-- Multi-level unsubscribe (broadcast wave): subscription TOPICS. A contact can opt out of one
-- kind of marketing (e.g. "Product updates") while staying subscribed to another (e.g. "Security
-- notices"), layered ON TOP of the existing GLOBAL opt-out (contacts.unsubscribed_at = unsubscribe
-- from everything, 0065). A broadcast is optionally tagged with a topic; a contact opted out of
-- that topic — or globally — is excluded at resolve/preview time.

CREATE TABLE IF NOT EXISTS subscription_topics (
  tenant_id   uuid NOT NULL DEFAULT current_tenant(),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- Per-contact, per-topic opt-out. A row means "this contact opted OUT of this topic"; absence
-- means still subscribed (opt-out model, matching contacts.unsubscribed_at).
CREATE TABLE IF NOT EXISTS contact_topic_optouts (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  contact_id uuid NOT NULL,
  topic_id   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, topic_id)
);
CREATE INDEX IF NOT EXISTS contact_topic_optouts_topic_idx ON contact_topic_optouts (tenant_id, topic_id);

-- A broadcast's subscription topic (null = untopiced; the footer link does a GLOBAL opt-out as before).
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS topic_id uuid;

GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_topics TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_topic_optouts TO app_user;
GRANT SELECT ON subscription_topics TO event_relay;
GRANT SELECT ON contact_topic_optouts TO event_relay;

ALTER TABLE subscription_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_topics FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_topics_iso ON subscription_topics;
CREATE POLICY subscription_topics_iso ON subscription_topics
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE contact_topic_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_topic_optouts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_topic_optouts_iso ON contact_topic_optouts;
CREATE POLICY contact_topic_optouts_iso ON contact_topic_optouts
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
