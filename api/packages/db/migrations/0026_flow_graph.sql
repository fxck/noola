-- 0026_flow_graph.sql — Lane 1: the executable-DAG model for automations. A nullable `graph`
-- column holds {nodes:[{id,type,config}], edges:[{from,to,when?}]}. When present, the engine
-- walks the graph (topological order, branch true/false routing, data-passing via
-- {{steps.<id>.<field>}}); when NULL it falls back to the linear `actions` list — so every
-- existing automation keeps working unchanged. Additive + idempotent (reruns every deploy).
ALTER TABLE automations ADD COLUMN IF NOT EXISTS graph jsonb;
