# Nadi compute image for the Cloudflare Sandbox provider.
#
# Mirrors the tool set baked into the Daytona snapshot
# (scripts/create-daytona-snapshot.mjs) so an agent sees the same environment
# whichever provider its workspace runs on.
#
# Build context is THIS directory (container/), not the repo root. Wrangler
# defaults a container's build context to the directory holding the Dockerfile,
# so `COPY verify-tools.sh` below must resolve relative to container/. Build it
# by hand the same way, or the COPY fails:
#
#   docker build --platform linux/amd64 -f container/Dockerfile container/
#
# Use scripts/smoke-cloudflare-sandbox-image.sh rather than running that by
# hand — it pins the platform and runs the tool verification.
#
# Pinned to 0.12.3 to match the @cloudflare/sandbox package version. The two
# MUST agree; test/unit/compute/cloudflare-image.test.ts enforces it.
FROM docker.io/cloudflare/sandbox:0.12.3-python

USER root

# mise installs tools into $MISE_DATA_DIR/shims. Putting that on the image PATH
# makes them resolve in any shell -- including the non-login, non-interactive
# shells the sandbox server spawns for exec. ENV here lands in the entrypoint's
# environment, which every spawned command inherits.
ENV MISE_DATA_DIR=/usr/local/share/mise
ENV MISE_CONFIG_DIR=/etc/mise
ENV PATH="/usr/local/share/mise/shims:${PATH}"

# The base is ubuntu:22.04 plus node/bun/python. It carries neither curl (mise's
# installer needs it) nor git (repository preparation clones with it).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh; \
    /usr/local/bin/mise --version

# COSIGN/SLSA verification off for build robustness; mise still checks sha256.
# The cache dir is build-only so runtime falls back to the writable per-user default.
RUN set -eux; \
    MISE_YES=1 MISE_AQUA_COSIGN=false MISE_AQUA_SLSA=false \
    MISE_CACHE_DIR=/tmp/mise-build-cache \
    /usr/local/bin/mise use -g gh jq ripgrep fd yq shellcheck; \
    /usr/local/bin/mise reshim

RUN set -eux; \
    npm install -g pnpm@10 yarn@latest

# The base already creates /workspace; assert it rather than assuming.
COPY verify-tools.sh /usr/local/bin/verify-nadi-tools
RUN chmod +x /usr/local/bin/verify-nadi-tools && /usr/local/bin/verify-nadi-tools
