-- The answers model's thinking level, and an optional model and thinking level for the search and general jobs.
-- A job with neither set uses the answers settings.
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS effort text;
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS search_model text;
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS search_effort text;
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS general_model text;
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS general_effort text;

-- The thinking level the draft ran at, shown next to the model in the trace viewer.
ALTER TABLE draft_traces ADD COLUMN IF NOT EXISTS effort text;
