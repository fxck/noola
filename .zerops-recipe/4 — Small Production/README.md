<!-- OLD PUBLIC RECIPE, not this project's recipe — see ../README.md. This project's recipe lives in
     HQ's `group` repository and changes only through zerops_workflow action="group-recipe". -->

<!-- #ZEROPS_EXTRACT_START:intro# -->
Run Noola on a budget: single-node PostgreSQL, Valkey, NATS, Typesense and Qdrant,
with the api, edge and web runtimes on shared CPU autoscaling 1→2, plus a shared
embedder and runner. Ideal for evaluation, demos, or low-traffic teams. There's no
redundancy — a container restart briefly drops traffic — so step up to HA Production
for real load.
<!-- #ZEROPS_EXTRACT_END:intro# -->
