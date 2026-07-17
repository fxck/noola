-- Authoritative per-conversation AI mode for the widget (and any ticket).
-- When a visitor asks for a human, the AI assistant is muted on THAT conversation:
-- both the widget /public/ask lane and the autoreply/automations engine skip it, so the
-- customer isn't answered by the bot past the handoff. A "Ask the assistant" toggle flips
-- it back on. Default true = brand-new conversations start AI-answered (today's behaviour).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assistant_enabled boolean NOT NULL DEFAULT true;
