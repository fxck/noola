-- The query the search model wrote for the docs search. NULL when retrieval searched the customer's message alone.
ALTER TABLE draft_traces ADD COLUMN IF NOT EXISTS search_query text;
