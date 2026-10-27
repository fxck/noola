# ── Noola flow-runner sandbox base (Studio→Studio fold, Phase 3) ────────────────
# Headless Chromium + Stagehand/Claude + the item-flow executor. Not run by Docker: the Go runner
# sends this directory to the Zerops Box, which builds it into a sandbox base named after a hash of
# the directory (noola-flow-runner-<hash>), and every browser/AI flow job runs in ONE fresh sandbox
# booted from it — its own microVM, terminated after the run (no cross-tenant state bleed). Mirrors
# the in-process executor's runtime: node 22 (Debian, for apt) + playwright chromium pinned to the
# app's version.
FROM node:22-bookworm-slim

WORKDIR /app

# JS deps first, exactly as the lockfile pins them (a bare `npm install` resolves the newest
# playwright in package.json's range, whose Chromium build is not the one installed below).
COPY package.json package-lock.json ./
RUN npm ci

# Chromium for the installed playwright (its own CLI, so the two can't drift) + its system
# libraries, in a fixed path so the run finds it whatever HOME the sandbox gives its process.
# Build runs as root, so --with-deps' apt works without sudo. ffmpeg encodes the run's frame
# stream into the .webm replay (0092) — libvpx ships in Debian's ffmpeg.
# The browser binary download hits the Playwright CDN and occasionally times out (30s socket
# timeout) — a single blip must NOT fail the whole runner boot, so retry up to 5× before giving up.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN for i in 1 2 3 4 5; do \
      npx --no-install playwright install --with-deps chromium && break; \
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
# The sandbox boots idle; the runner starts `node exec.mjs` in it as the job's own process, once it
# has written the job's files.
ENTRYPOINT []
CMD ["sleep", "infinity"]
