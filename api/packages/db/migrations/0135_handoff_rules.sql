-- When the AI helps and when it hands off, as the workspace wrote it. NULL uses the default rules in the code.
ALTER TABLE agent_persona ADD COLUMN IF NOT EXISTS handoff_rules text;
