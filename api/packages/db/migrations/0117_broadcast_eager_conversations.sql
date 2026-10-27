-- Broadcast outbound = a real conversation per recipient, created AT SEND (Intercom parity).
--
-- 0116 made a broadcast reply LAZILY materialize a ticket. But Intercom lets you open the conversation
-- right after sending — the sent message sits in a thread even before a reply. So a broadcast now
-- creates a conversation per recipient at send time. To avoid flooding the active inbox with thousands
-- of "waiting on them" rows, those conversations are flagged `outbound_pending`: excluded from the
-- default inbox views (visible on the contact's profile + a dedicated Outbound view), and surfaced into
-- the active queue the moment the recipient replies (the flag clears on their first inbound).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS outbound_pending boolean NOT NULL DEFAULT false;

-- The default inbox views scan open, non-pending tickets; a partial index keeps that filter cheap and
-- also powers the reverse "show me everything still awaiting a first reply" Outbound view.
CREATE INDEX IF NOT EXISTS tickets_outbound_pending_idx
  ON tickets (tenant_id, updated_at DESC)
  WHERE outbound_pending;

-- The eager per-recipient conversation this send opened, so a `+b.` reply threads back onto THAT exact
-- ticket (rather than the lazy contact-threading fallback). Null for pre-0117 recipients.
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS ticket_id uuid;
