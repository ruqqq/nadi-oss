# syntax=docker/dockerfile:1
#
# Images for running Nadi on celld. See docs/self-hosting-celld.md.
#
# The build context is the REPO ROOT, not this directory — docker-compose.yaml
# sets that. Building from here directly will fail to find package.json.
#
# Three things have to be built, and they are genuinely separate:
#
#   web-server  the SPA. celld has NO assets binding (wrangler.celld.jsonc has
#               no `assets` key, and `celld deploy` uploads only the Worker
#               bundle), so unlike Cloudflare the node does not serve the UI at
#               all — src/index.ts falls through to `route()` and 404s. Caddy
#               serves web/dist and proxies the app's routes to celld.
#   deployer    a one-shot that runs `pnpm celld:deploy` to push the Worker
#               bundle into the fleet bucket. Needs node + the repo + esbuild.
#               The same image also runs `celld d1 migrations apply` (see the
#               `migrate` service), which needs the repo for migrations/ and
#               the wrangler config that resolves the database name.
#   node        the long-running celld process. Needs only the binary.

ARG NODE_VERSION=22-slim

# --- deps: one pnpm install, shared by the node stages ----------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable
# Lockfile-only layer: dependency installs are cached until the manifests move.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

# --- web-build: the SPA bundle ---------------------------------------------
FROM deps AS web-build
COPY . .
# The PWA's install name (manifest + the iOS home-screen meta) is baked at
# build time, unlike the in-app title which the Worker's APP_NAME already
# drives at runtime. Set this when a deployment is installed ALONGSIDE another
# one — otherwise both appear in the launcher as an identical "Nadi". Blank
# falls back to "Nadi" in web/vite.config.ts.
ARG APP_NAME=""
ENV APP_NAME=${APP_NAME}
RUN pnpm web:build

# --- celld-bin: the celld binary, fetched once ------------------------------
FROM debian:bookworm-slim AS celld-bin
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ENV CELLD_INSTALL_ROOT=/usr/local
# Pinned so the image is reproducible and so it matches the version this
# deployment was actually verified against. Override with --build-arg
# CELLD_VERSION=… ; an empty value takes the latest release, which means two
# builds a week apart differ. Do not move this without re-reading the upgrade
# notes in docs/self-hosting-celld.md — v0.2.0 changed the listener flags, and
# v0.2.1 stopped trusting X-Forwarded-* by default.
ARG CELLD_VERSION="v0.3.0"
RUN CELLD_VERSION="${CELLD_VERSION}" sh -c 'curl -fsSL https://celld.dev/install.sh | sh'

# --- web-server: Caddy with the SPA baked in --------------------------------
FROM caddy:2-alpine AS web-server
COPY --from=web-build /app/web/dist /srv
COPY deploy/celld/Caddyfile /etc/caddy/Caddyfile

# --- deployer: one-shot `pnpm celld:deploy` ---------------------------------
FROM deps AS deployer
WORKDIR /app
COPY . .
# The installer's bin entry is a SYMLINK into lib/celld/releases/<version>/,
# so copying only /usr/local/bin/celld yields a dangling link.
COPY --from=celld-bin /usr/local/lib/celld /usr/local/lib/celld
COPY --from=celld-bin /usr/local/bin/celld /usr/local/bin/celld
# Overridden by the `migrate` service, which runs `celld d1` from this image.
ENTRYPOINT ["pnpm", "celld:deploy", "--"]

# --- node: the long-running celld process -----------------------------------
FROM debian:bookworm-slim AS node
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=celld-bin /usr/local/lib/celld /usr/local/lib/celld
COPY --from=celld-bin /usr/local/bin/celld /usr/local/bin/celld
ENTRYPOINT ["celld"]
