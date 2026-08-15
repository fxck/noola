-- 0113_discord_relay_outbox.sql
-- Reliable delivery for Discord ops-mirror WRITES (relayed ticket messages, internal-note relays, and
-- the 📤-promote ✅ confirmation react).
--
-- Before this, every mirror write was fire-and-forget straight into discord.js's IN-MEMORY REST queue
-- (relayTicketMessage → postToThread, the promote react). When the bot's gateway connection degraded,
-- those calls didn't fail — they HUNG in that queue with no timeout, no throw, no log, and were LOST
-- OUTRIGHT when the api process cycled (a deploy wipes the in-memory queue). Observed in prod: two AI
-- replies never reached Discord, and a promote's ✅ landed ~30 min late (queue finally drained).
--
-- Fix: a transactional outbox (same shape as the realtime outbox in 0096/0097). Each intended write is
-- an idempotent row here; a single-flight drainer leases due rows, performs the Discord write behind a
-- deadline, and marks 'delivered' or backs off + retries — surviving restarts and degraded connections,
-- with a durable, queryable record of what was and wasn't delivered. Dead-letters to 'failed' + logs
-- loudly after max_attempts. Also closes the relay-before-mirror-exists race: a message enqueued before
-- the forum post is ready simply retries ("mirror not ready" is retriable) until the post lands.
--
-- RLS posture: relay-accessible (GRANT to event_relay, NO RLS) — the drainer and the enqueue points run
-- pre-tenant on relayPool, exactly like ticket_mirror (0088). Not tenant-session scoped.

CREATE TABLE IF NOT EXISTS discord_relay_outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  ticket_id       uuid NOT NULL,
  -- 'message' → relay a ticket message into the mirror thread; 'note' → relay an internal note;
  -- 'react' → add a reaction (the 📤-promote ✅ confirmation) to a specific Discord message.
  kind            text NOT NULL CHECK (kind IN ('message', 'note', 'react')),
  -- Idempotency key: enqueuing the same logical write twice is a no-op (ON CONFLICT DO NOTHING).
  -- e.g. 'message:<messageId>', 'note:<noteId>', 'react:<discordMessageId>:<emoji>'.
  dedupe_key      text NOT NULL UNIQUE,
  -- kind-specific args the drainer needs to perform the write (messageId / {authorName,body} /
  -- {threadId,discordMessageId,emoji}).
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 10,
  -- Lease + backoff clock: a claim pushes this forward (so a crashed/hung attempt is retried after the
  -- lease); a retriable failure pushes it forward by exponential backoff.
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The drainer's hot path: oldest due, still-pending rows. Partial index keeps it tiny (delivered/failed
-- rows drop out).
CREATE INDEX IF NOT EXISTS idx_discord_relay_outbox_due
  ON discord_relay_outbox (next_attempt_at)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON discord_relay_outbox TO event_relay;
