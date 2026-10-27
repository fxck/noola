# Noola — an AI-native, self-hosted support platform

Noola is a multi-tenant customer-support platform — an omnichannel shared inbox, a
knowledge base, and a visual automation studio — that runs **entirely on your own
Zerops project**. The only thing that ever leaves your infrastructure is the LLM call,
and even that is bring-your-own-key.

> **Open source** · built and hosted on **[Zerops](https://zerops.io)**

## Features

- **Omnichannel shared inbox** — email, an embeddable chat widget, Discord, Slack, Telegram and WhatsApp collapse into one conversation per contact.
- **AI answers grounded in your content** — retrieval-augmented generation over your knowledge base, with a self-hosted embedding sidecar so nothing but the final LLM call leaves your infra.
- **Bring-your-own model key** — the provider key is per-tenant and encrypted at rest; no shared vendor dependency.
- **Visual automation Studio** — compose automations and AI agents on a live multiplayer canvas, run them, and watch each step stream with a saved replay.
- **Isolated execution** — one ephemeral `docker run --rm` container per automation run, guaranteed cleanup.
- **Teams, routing, SLA & broadcasts** — round-robin/skill routing, SLA policies with business hours, tracked outbound broadcasts, and an analytics suite.
- **Enterprise-ready** — TOTP 2FA, SSO + SCIM provisioning, per-tenant data retention, IP allowlists and GDPR export/erase.

## How it works

A monorepo of seven runtime services over six managed stores:

| Service | Stack | Role |
|---|---|---|
| **api** | Node 24 · Fastify · Bun | the domain core — auth (better-auth, 2FA, SSO/SCIM), tickets, contacts, teams, routing, SLA, broadcasts, KB, and the RAG pipeline; serves REST and emits domain events to NATS. |
| **edge** | Elixir 1.16 · Phoenix Channels | fans the api's events out to browsers over WebSockets and hosts the Studio's collaborative (Yjs) canvas. |
| **embedder** | Node 24 | a self-hosted all-MiniLM sidecar; the model is baked at build time, so the runtime is keyless and offline. |
| **geo** | Node 24 | a self-hosted IP→location sidecar for live contact enrichment; the DB-IP City Lite database is baked at build, so lookups stay keyless and in-infra. |
| **runner** | Docker-in-VM · Go | consumes automation-run jobs from NATS JetStream and launches one ephemeral container per run. |
| **web** | Vite · React 19 · TanStack | the console SPA; reaches the api and edge over their public subdomains. |
| **site** | Vite · React 19 · TanStack | the public marketing site, served as static nginx — separate from the console. |

```
                       ┌──────────────── NATS JetStream ────────────────┐
                       │                                                 │
  web ──REST(Bearer)──▶ api ──emit──▶ (events) ──▶ edge ──WebSocket──▶ web   (realtime + Studio canvas)
                       │  │                                  runner ──▶ ephemeral run containers
                       │  ├── embedder ──vectors──▶ Qdrant
                       │  └── geo ──▶ ip → contact location
                       └── PostgreSQL · Valkey · Typesense · object storage
```

Managed stores: **PostgreSQL** (source of truth), **Valkey** (sessions + hot state),
**NATS JetStream** (events + run queue), **Typesense** (full-text), **Qdrant** (vectors),
and **object storage** (files + run replays).

## Deploy your own

One click via the Zerops recipe — it ships the whole dev-lifecycle ladder: **AI Agent**
and **Remote (CDE)** dev topologies, **Local** (stores only), **Stage**, and **Small**
or **HA Production**. Dev and Stage need **zero secrets** (every signing/DB secret is
generated) and seed a demo workspace — sign in with `ales@acme.test` / `demo1234`.

▶ **[Deploy on Zerops](https://app.zerops.io/recipes/detail?github=https://github.com/fxck/noola)**

The recipe manifest lives in [`.zerops-recipe/`](./.zerops-recipe/).

## Local development

Bring up the **Local** recipe environment (the backing stores over the Zerops VPN),
then run the services on your machine:

```sh
# api (Node/Bun · Fastify) — REST + domain events
cd api && bun install && npm run migrate && npm run dev

# web (Vite · React) — the console SPA
cd web && npm install && npm run dev

# embedder (Node) — the embedding sidecar
cd embedder && npm install && node server.mjs

# geo (Node) — the IP→location enrichment sidecar
cd geo && npm install && node server.mjs

# edge (Elixir · Phoenix) — realtime + canvas
cd edge && mix deps.get && mix phx.server
```

Point `DB_*`, `CACHE_URL`, `NATS_*`, `SEARCH_*`, `QDRANT_URL` and `STORAGE_*` at the
`db` / `cache` / `broker` / `search` / `qdrant` / `storage` internal hostnames, and set
`VITE_API_URL` / `VITE_EDGE_URL` for the SPA. See each environment's `import.yaml` for
the exact wiring.

## Repository layout

```
api/             Node/Fastify API — domain core, auth, RAG, REST + events (Bun workspaces)
edge/            Elixir/Phoenix — realtime WebSocket fan-out + collaborative canvas
embedder/        Node — self-hosted all-MiniLM embedding sidecar
geo/             Node — self-hosted IP→location sidecar (DB-IP City Lite, baked at build)
runner/          Go — Docker-in-VM automation-run worker
web/             Vite + React 19 SPA — the console
site/            Vite + React 19 — the public marketing site (static nginx)
zerops.yaml      build/run setups for every service (*dev + *prod)
.zerops-recipe/  Zerops recipe variants (AI Agent · Remote CDE · Local · Stage · Small/HA Production)
```

## License

[MIT](./LICENSE).

---

Built on **[Zerops](https://zerops.io)**.
