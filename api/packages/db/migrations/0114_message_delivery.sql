-- Per-message email delivery status for 1:1 agent replies. Until now a reply's only signal was the
-- self-hosted open pixel (messages.seen_at) — "did it actually send / did it bounce" was invisible,
-- because messages carried no provider id and no delivery head. This mirrors the broadcast delivery
-- columns (0109) onto messages so the SAME provider webhook + parser (broadcast-events.ts) can match a
-- delivery event back to the exact reply and advance a real status.
--
-- provider_message_id: the (unangled) Message-ID we stamp on the outbound reply, so a Resend/SendGrid
-- delivery event (which echoes it) matches back to this row. delivery_status head: sent -> delivered,
-- or bounced/complained. opened_at unifies with the existing seen_at pixel (either signal marks read).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status text;  -- sent|delivered|bounced|complained
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bounced_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bounce_kind text;      -- 'hard' | 'soft'
ALTER TABLE messages ADD COLUMN IF NOT EXISTS complained_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS opened_at timestamptz;

-- Match a provider delivery event back to the exact reply by the Message-ID we stamped at send.
CREATE INDEX IF NOT EXISTS messages_provider_msgid_idx
  ON messages (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
