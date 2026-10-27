-- Lazy-promotion of broadcast replies (Intercom-parity outbound).
--
-- A broadcast is fire-and-forget at send time — it creates only broadcast_recipients delivery-log
-- rows, never a ticket per recipient (that would flood the "issues" queue with phantom problems nobody
-- ever had). The keystone: a broadcast email now carries a signed per-recipient Reply-To token, so when
-- a recipient REPLIES, the reply materializes a ticket via the normal contact-threading path — and these
-- columns record which broadcast (and which recipient row) it came from, so the resulting conversation
-- is born tagged with its outbound origin instead of arriving context-free. First origin wins; the
-- stamp is only ever written when currently null (a later broadcast reply never clobbers the first).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_broadcast_id uuid;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_broadcast_recipient_id uuid;

-- Look up "which ticket did this recipient's reply promote to" cheaply (the reverse of the stamp).
CREATE INDEX IF NOT EXISTS tickets_source_broadcast_idx
  ON tickets (tenant_id, source_broadcast_id)
  WHERE source_broadcast_id IS NOT NULL;
