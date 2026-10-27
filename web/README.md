# React Hello World Recipe App

<!-- #ZEROPS_EXTRACT_START:intro# -->
A minimal React + Vite + TypeScript app deployed as a static site on [Zerops](https://zerops.io) — built by Node.js, served by Nginx, with a build-time environment variable demo showing how static deployments consume configuration.
Used within [React Hello World recipe](https://app.zerops.io/recipes/react-hello-world) for [Zerops](https://zerops.io) platform.
<!-- #ZEROPS_EXTRACT_END:intro# -->

⬇️ **Full recipe page and deploy with one-click**

[![Deploy on Zerops](https://github.com/zeropsio/recipe-shared-assets/blob/main/deploy-button/light/deploy-button.svg)](https://app.zerops.io/recipes/react-hello-world?environment=small-production)

![react cover](https://github.com/zeropsio/recipe-shared-assets/blob/main/covers/svg/cover-react.svg)

## Integration Guide

<!-- #ZEROPS_EXTRACT_START:integration-guide# -->

### 1. Adding `zerops.yaml`
The main application configuration file you place at the root of your repository, it tells Zerops how to build, deploy and run your application.

```yaml
# zerops.yaml — React (Vite) Hello World
# Two setups: 'prod' for optimized static builds, 'dev' for SSH development.
zerops:

  # Production / Stage
  - setup: prod
    build:
      # Build with Node.js (npm/npx), serve with Nginx.
      # The build container compiles the React app into static HTML/CSS/JS
      # — Node.js is NOT present at runtime.
      base: nodejs@22

      # Bake the environment name into the JS bundle at build time.
      # Static deployments have no runtime process, so all env config must
      # be injected here. VITE_* vars are exposed to client code by Vite.
      # Zerops RUNTIME_ prefix pattern: a runtime var FOO is also readable
      # as RUNTIME_FOO during build — useful for promoting stage vars to prod
      # without code changes.
      envVariables:
        VITE_APP_ENV: production

      buildCommands:
        # npm install (not npm ci) — the build container runs Alpine Linux;
        # Vite's native Rollup binaries are platform-specific, so letting
        # npm resolve the correct musl binary is required here.
        - npm install
        - npm run build

      # Strip 'dist/' prefix — contents become the Nginx document root,
      # so dist/index.html becomes /index.html.
      deployFiles:
        - dist/~

      cache:
        - node_modules

    run:
      # Nginx serves the compiled output — no Node.js at runtime.
      # Built-in SPA fallback: unmatched routes serve /index.html,
      # so React Router and other client-side routers work out of the box.
      base: static

  # Development (SSH workspace)
  - setup: dev
    build:
      base: nodejs@22
      os: ubuntu

      buildCommands:
        # Install all deps (including devDeps) — the developer will run
        # 'npm run dev' or other scripts via SSH after deployment.
        - npm install

      # Deploy full source tree so the developer has everything in place.
      deployFiles: ./

      cache:
        - node_modules

    run:
      # Node.js runtime so the developer can run 'npm run dev' via SSH.
      # Nginx is NOT used here — the Vite dev server handles requests.
      base: nodejs@22
      os: ubuntu

      # Keep the container alive without starting any server.
      # The developer SSHs in and starts their own dev server.
      start: zsc noop --silent
```
<!-- #ZEROPS_EXTRACT_END:integration-guide# -->
