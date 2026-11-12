<!-- PUBLIC RECIPE: deploys your own copy of Noola from GitHub. The Noola application's Mates, Stage
     and Production in Zerops Mate come from HQ's `group` recipe instead — see ../README.md. -->

<!-- #ZEROPS_EXTRACT_START:intro# -->
A single, non-HA running instance built with the production setups — one container
per service over single-node stores, with a shared embedder, runner and Mailpit. Use
it to validate a build end-to-end (the demo workspace is seeded) before promoting to
Small or HA Production. Cheaper than production; not redundant.
<!-- #ZEROPS_EXTRACT_END:intro# -->
