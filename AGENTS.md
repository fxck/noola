# Working on the Noola monorepo

One monorepo, deployed on **Zerops**. Every service builds from this repo; **production tracks `main`**.
This file is how to run the **develop → deploy → PR** loop without the sharp edges. Product overview
lives in [README.md](README.md).

## Layout

| dir | service | stack / build |
|---|---|---|
| `api/` | backend API (Fastify) — workspaces `apps/api`, `packages/contracts`, `packages/db` | Node 24, TS project refs (`tsc --build`) |
| `web/` | agent SPA (inbox, settings) | Vite + React (`tsc -b && vite build`) |
| `edge/` | realtime edge | Elixir / Phoenix |
| `embedder/` | RAG embeddings | Node |
| `geo/` | IP enrichment | Node |
| `runner/` | flow-runner (docker image + `runnerd`) | Go + Docker |
| `site/` | marketing | static |

## Zerops topology — how a service maps to a container

Each service has a **dev half** (`*dev`) and a **stage/prod half**:

- **`*dev`** (`apidev`, `webdev`, …) self-deploys the *whole monorepo* (`deployFiles: [.]`) and idles on
  `zsc noop`, so its container filesystem **is** the editable source — mounted on the control host at
  `/var/www/<svc>dev/`. **You edit these.**
- **stage / prod** builds the real artifact with the `*prod` setup. Stage is "the prod build inside a
  dev project"; a production-shaped project reuses the same `*prod` setups.

Setups live in `zerops.yaml`, named `<svc>dev` / `<svc>prod`:

- A `*dev` service **hostname-matches** its `<svc>dev` setup automatically.
- A **plain-named** service (`api`, `embedder`, … in a production-shaped project) does **not** match
  `*prod` — it must be **pinned** to the `*prod` setup (the GitHub build integration's setup field, or
  `zeropsSetup:` at import). A missing pin is the *"setup was not found: embedder"* build failure.

**Cross-service config comes from env, never hardcoded.** `requireEnv(key)`
([api/apps/api/src/env.ts](api/apps/api/src/env.ts)): **undefined → throws (boot-crash)**,
**empty string → feature disabled**, set → used. So `GEO_URL` / `EMBED_URL` must be wired (a URL) or
set empty (disabled) in **every** project, or the api won't boot.

## The develop loop

1. **Edit** in the dev mount (`/var/www/<svc>dev/…`) — that's the live container filesystem.
2. **Build / typecheck / test INSIDE the container over SSH** — the toolchain and `node_modules` live
   there, not on the control host. Dev containers are RAM-limited (~640 MB), so bump the Node heap or
   `tsc` OOMs:
   ```
   ssh apidev "cd /var/www/api && NODE_OPTIONS=--max-old-space-size=1024 npx tsc --build apps/api"
   ssh webdev "cd /var/www/web && NODE_OPTIONS=--max-old-space-size=1024 npx tsc -b"
   ssh apidev "cd /var/www/api && npm run test:<suite>"   # e.g. test:discord-mirror, test:threads
   ssh apidev "cd /var/www/api && npm run migrate"        # apply pending SQL
   ```
3. **Deploy + verify** to make it durable: `zerops_deploy targetService=<svc>dev`, start the dev
   server, then `zerops_verify`. (Code-only edits can also just reload the dev server; a deploy is what
   survives a container cycle.)

### Migrations
A new `api/packages/db/migrations/NNNN_name.sql` **must also be appended to the hardcoded `migrations`
array in [api/packages/db/src/migrate.ts](api/packages/db/src/migrate.ts)** — the runner uses that
list, not a directory glob, so an unregistered file silently never applies.

## The PR loop (→ `main` → production)

Production builds from `main`, so the deliverable is a **PR to `main`**.

- **One repo, many checkouts.** Each dev mount is a *separate* checkout. Backend edits land in
  `apidev`'s checkout, frontend edits in `webdev`'s. To make **one** PR, consolidate into a single
  checkout before committing:
  ```
  git -C /var/www/webdev diff -- web/ | git -C /var/www/apidev apply   # bring FE edits into the api checkout
  ```
- **Do git object ops IN the container, not on the control host.** A host-side `git add`/commit reads
  the SSHFS mount and can capture a file **mid-write** (empty / garbled — this has bitten us). Fetch and
  push from the host (that's where the git token is); do everything else in-container:
  ```
  git -C /var/www/apidev fetch origin main                                   # host (token lives here)
  ssh apidev "cd /var/www && git checkout -B feat/x origin/main && git add -A && git commit -m '…'"  # container: race-free
  git -C /var/www/apidev push origin feat/x                                  # host
  ```
  If you authored files *through* the mount, verify they aren't empty before pushing:
  `git show :<path> | wc -l`.
- **Branch off the latest `main`.** Keep **one PR per coherent change** — a feature that spans backend
  and frontend (a new field + its UI) belongs in *one* PR; splitting it ships a broken intermediate
  state.
- A `commit-msg` / husky hook can blank or reject a valid message — commit with `--no-verify`
  (or `HUSKY=0`) if it aborts.

## Gotchas checklist

- [ ] New service in a prod-shaped project? **Pin** its build to the `*prod` setup — a plain hostname
      won't match `*prod`.
- [ ] New env dependency? Wire it (URL) **or set it empty** in every project — `requireEnv` boot-crashes
      on undefined.
- [ ] New migration? **Register it** in `migrate.ts`.
- [ ] One feature touching frontend + backend? **One PR**, consolidated into one checkout.
- [ ] Committing? Do it **in-container**, verify files aren't empty, **push from the host**.
