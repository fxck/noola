# Noola — Zerops recipe

See the [root README](../README.md).

## Recipe metadata

- **Name:** <!-- #ZEROPS_EXTRACT_START:name# -->Noola<!-- #ZEROPS_EXTRACT_END:name# -->
- **Shape:** <!-- #ZEROPS_EXTRACT_START:shape# -->app<!-- #ZEROPS_EXTRACT_END:shape# --> — you fork and deploy your own copy
- **Environments:** `AI Agent` · `Remote (CDE)` · `Local` · `Stage` · `Small Production` · `HA Production` — the dev-lifecycle ladder, from an agent-driven dev/stage pair up to a full HA cluster

## Tagline

<!-- #ZEROPS_EXTRACT_START:intro# -->
An AI-native, multi-tenant customer-support platform — shared inbox, knowledge base,
and a visual automation studio — that runs entirely on your own Zerops project. Only
the LLM call ever leaves your infrastructure, and even that is bring-your-own-key.
<!-- #ZEROPS_EXTRACT_END:intro# -->

## Overview

<!-- #ZEROPS_EXTRACT_START:description# -->
Noola is a self-hosted support platform: an omnichannel shared inbox (email, an
embeddable chat widget, Discord, Slack, Telegram and WhatsApp all collapse into one
conversation per contact), a knowledge base, and a visual "Studio" where you compose
automations and AI agents on a live multiplayer canvas and watch each run stream in
real time. AI answers are grounded in your own content through retrieval-augmented
generation — embeddings are computed in-process by a self-hosted all-MiniLM sidecar
and searched in Qdrant, so nothing but the final model call touches an external API,
and that key is per-tenant and yours.

It runs as a monorepo of five services over six managed stores. A Node/Fastify **api**
owns the domain, auth (better-auth, TOTP 2FA, SSO/SCIM), tickets, teams, routing, SLA,
broadcasts and the RAG pipeline; an Elixir/Phoenix **edge** fans realtime events and
the collaborative canvas out to browsers over WebSockets; a self-hosted **embedder**
turns text into vectors offline; a Docker **runner** launches one ephemeral, auto-removed
container per automation run for clean isolation; and a React 19 + Vite **web** SPA is
the console. Managed **PostgreSQL**, **Valkey**, **NATS JetStream**, **Typesense**,
**Qdrant** and **object storage** back them.

Several topologies ship as one recipe, covering the whole dev lifecycle: an agent-driven
dev/stage pair, a single remote CDE container, a backing-stores-only setup for local
development, a single-node stage, and production on shared (Small) or dedicated HA hardware.
<!-- #ZEROPS_EXTRACT_END:description# -->

## Features

<!-- #ZEROPS_EXTRACT_START:features# -->
- **Omnichannel shared inbox** — email, an embeddable chat widget, Discord, Slack, Telegram and WhatsApp collapse into one conversation per contact.
- **AI answers grounded in your content** — retrieval-augmented generation over your knowledge base, with a self-hosted embedding sidecar so nothing but the final LLM call leaves your infra.
- **Bring-your-own model key** — the LLM provider key is per-tenant and encrypted at rest; there is no shared vendor dependency.
- **Visual automation Studio** — compose automations and AI agents on a live multiplayer canvas, run them, and watch each step stream with a saved replay.
- **Isolated execution** — one ephemeral `docker run --rm` container per automation run, guaranteed cleanup.
- **Teams, routing, SLA & broadcasts** — round-robin/skill routing, SLA policies with business hours, outbound broadcasts with tracking, and an analytics suite.
- **Enterprise-ready** — TOTP 2FA, SSO + SCIM provisioning, per-tenant data retention, IP allowlists and GDPR export/erase.
- **One repo, one click** — a monorepo (api + edge + embedder + runner + web) deploys as a complete project from a single recipe.
<!-- #ZEROPS_EXTRACT_END:features# -->

## First-run setup

<!-- #ZEROPS_EXTRACT_START:takeover-guide# -->
**Dev and Stage need zero secrets.** Every signing and database secret is generated at
import time. The dev/stage environments seed a demo workspace so you can sign in
immediately at the `web` (or `webstage`) subdomain with **`ales@acme.test` / `demo1234`**
and explore a populated inbox, knowledge base and Studio.

**Production asks for one thing — your first admin.** The Small/HA Production
environments skip the demo seed (`DISABLE_DEMO_SEED=1`) and instead create a single
admin from `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` (set them at import).
That account owns the first workspace; invite the rest of your team from Settings.

**Add a model key to turn on AI (optional).** AI answers need a provider key, set
per-tenant and encrypted in **Settings → AI**. Without one, everything else — inbox,
routing, broadcasts, Studio's non-AI nodes — works; only model-backed replies are idle.

**Outbound email (optional).** Dev/Stage catch all mail in the bundled **Mailpit**
(open its subdomain to read it). Production ships without Mailpit — set `SMTP_HOST` /
`SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` to your provider to send real email.

**Open the app.** The public URL is the `web` service's subdomain (or attach your own
domain in Project → Public Access). The build wires the SPA to the `api` and `edge`
subdomains automatically (CORS is open, auth is Bearer).
<!-- #ZEROPS_EXTRACT_END:takeover-guide# -->

## Knowledge base

<!-- #ZEROPS_EXTRACT_START:knowledge-base# -->
### Architecture

Five runtime services over six managed stores:

- **api** (Node 24 / Fastify) — the domain core: auth (better-auth, TOTP 2FA, SSO/SCIM),
  tickets, contacts, teams, routing, SLA, broadcasts, knowledge base, and the RAG
  pipeline. Serves REST + emits domain events to NATS. Reads **PostgreSQL** (`db`,
  source of truth), **Valkey** (`cache`, sessions + hot state), **Typesense** (`search`,
  full-text) and **Qdrant** (`qdrant`, vector search); stores files in **object storage**
  (`storage`). Sends `Access-Control-Allow-Origin: *` (the SPA is Bearer, cross-origin).
- **edge** (Elixir 1.16 / Phoenix Channels) — subscribes to the api's NATS events and
  fans them to browsers over WebSockets; also hosts the Studio's collaborative (Yjs)
  canvas. Verifies socket tokens against the api at `API_INTERNAL_URL`.
- **embedder** (Node 24) — a self-hosted all-MiniLM sidecar; the api calls `POST /embed`
  at `EMBED_URL`. The model is baked at build time, so the runtime is keyless and offline.
- **runner** (Docker-in-VM, Go) — consumes automation-run jobs from NATS JetStream and
  launches one ephemeral `docker run --rm` container per run; replays are banked to object storage.
- **web** (Vite / React 19) — the console SPA, built with the `api` and `edge` public
  subdomains baked in.

### Environment variables

Managed-store wiring (`DB_*`, `CACHE_URL`, `NATS_*`, `SEARCH_*`, `STORAGE_*`, `QDRANT_*`)
resolves automatically from `zerops.yaml`. Cross-service URLs that vary by topology
(`EMBED_URL`, `API_INTERNAL_URL`, the SMTP/Mailpit endpoint) are project-level variables
set per environment in the import manifest. You never set store wiring by hand.

- Generated at import (project secrets): `AUTH_SECRET`, `MODEL_KEY_SECRET`,
  `EDGE_SHARED_SECRET`, `SECRET_KEY_BASE`, and the DB-role passwords `APP_DB_PASSWORD` /
  `RELAY_DB_PASSWORD` / `AUTH_DB_PASSWORD`.
- Production only: `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` (your first admin),
  `DISABLE_DEMO_SEED=1`.
- Optional: `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` (production email), and
  a per-tenant model key set in the app (not an env var).

### Troubleshooting

- **Can't sign in on a fresh Production deploy** — Production skips the demo seed; log in
  with the `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` you set at import. If both
  were left empty no admin was created — set them and restart `api` (migrations re-run idempotently).
- **AI replies do nothing** — no model key is set. Add one per-tenant in Settings → AI.
- **No email arrives** — Dev/Stage: open the `mailpit` subdomain (mail is caught, not sent).
  Production: set `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` to a real provider.
- **Realtime/Studio won't connect** — the `web` build must bake the `edge` subdomain
  (`VITE_EDGE_URL`); confirm the `edge` service has subdomain access enabled.
<!-- #ZEROPS_EXTRACT_END:knowledge-base# -->
