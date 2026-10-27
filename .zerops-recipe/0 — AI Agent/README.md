<!-- #ZEROPS_EXTRACT_START:intro# -->
The development topology Noola was built on: dev + stage pairs of api, edge and web
over single-node stores, sharing one embedder and one runner. The dev containers
start with the whole monorepo checked out and idling for an AI agent (or you) to adopt
and drive — edit the mounted tree, run the dev servers via the agent — while the stage
pair builds from git as a live, always-running reference. The demo workspace is seeded
(sign in with ales@acme.test / demo1234). Non-HA and lightweight.
<!-- #ZEROPS_EXTRACT_END:intro# -->
