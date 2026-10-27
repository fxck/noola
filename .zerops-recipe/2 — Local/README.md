<!-- #ZEROPS_EXTRACT_START:intro# -->
Just the backing stores — PostgreSQL, Valkey, NATS, Typesense, Qdrant and object
storage — plus Mailpit, and no app containers. Bring up the Zerops VPN
(`zcli vpn up`) and run api, edge, embedder and web on your own machine, pointing their
connection env at the internal `db` / `cache` / `broker` / `search` / `qdrant` /
`storage` hostnames. Cheapest way to develop against real managed services.
<!-- #ZEROPS_EXTRACT_END:intro# -->
