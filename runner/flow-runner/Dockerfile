# ── Noola flow-runner ephemeral run container (Studio→Studio fold, Phase 3) ────
# Headless Chromium + Stagehand/Claude + the containerized item-flow executor. The Go runner
# worker launches ONE `docker run --rm --network=host` of this image per browser/AI flow job, so
# every run is a fresh, self-cleaning sandbox (no cross-tenant state bleed). Mirrors the in-process
# executor's runtime: node 22 (Debian, for apt) + playwright chromium pinned to the app's version.
FROM node:22-bookworm-slim

WORKDIR /app

# JS deps first so this layer caches unless package.json changes.
COPY package.json ./
RUN npm install

# Chromium (matching the installed playwright) + its system libraries. Build runs as root, so
# --with-deps' apt works without sudo. ffmpeg encodes the run's frame stream into the .webm
# replay (0092) — libvpx ships in Debian's ffmpeg.
# The browser binary download hits the Playwright CDN and occasionally times out (30s socket
# timeout) — a single blip must NOT fail the whole runner boot, so retry up to 5× before giving up.
RUN for i in 1 2 3 4 5; do \
      npx -y playwright@1.61.1 install --with-deps chromium && break; \
      if [ "$i" = 5 ]; then echo "playwright chromium install failed after 5 attempts" >&2; exit 1; fi; \
      echo "playwright chromium install attempt $i failed — retrying in 10s…" >&2; sleep 10; \
    done \
 && apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# The shared DB-free item-node core (@repo/flow-core) must be present in the build context so
# esbuild can inline it into the bundle. The runner build wiring vendors the monorepo source
# (api/packages/flow-core/src/index.ts) to ./flow-core/index.ts before this image builds — the same
# path `npm run vendor:flow-core` writes — so this COPY resolves whether the context is the repo root
# or a pre-vendored runner/flow-runner. esbuild aliases `@repo/flow-core` → ./flow-core/index.ts.
COPY flow-core ./flow-core

# Bundle the TS executor to ESM with esbuild (strips types, no external tsc). Playwright + Stagehand
# stay external (native/large deps installed via npm above); @repo/flow-core is inlined via alias.
COPY exec.mts ./
RUN npm run build

ENV NODE_ENV=production
ENTRYPOINT ["node", "exec.mjs"]
