#!/usr/bin/env bash
#
# Build and verify the Nadi Cloudflare Sandbox container image.
#
# ---------------------------------------------------------------------------
# WHY THIS SCRIPT EXISTS
# ---------------------------------------------------------------------------
# Cloudflare Containers build their image locally with Docker at `wrangler
# deploy` time and push it to Cloudflare's registry. Nadi's primary development
# box has no Docker, so the image recipe (container/Dockerfile) cannot be
# exercised there at all. This script is the gate that proves the recipe builds
# and produces a container with the tool set Nadi's agents expect.
#
# It PUBLISHES NOTHING. It builds locally, runs the in-image verifier, and
# throws the container away. Shipping the image to Cloudflare is a separate
# step -- see "AFTER THIS PASSES" at the bottom.
#
# ---------------------------------------------------------------------------
# HOW TO RUN
# ---------------------------------------------------------------------------
#   git clone <this repo> && cd nadi
#   git checkout feat/cloudflare-compute
#   ./scripts/smoke-cloudflare-sandbox-image.sh
#
# No pnpm install, no .dev.vars, no Cloudflare credentials needed. Only Docker
# (or a Docker-compatible CLI such as Podman aliased to `docker`, or Colima /
# Rancher Desktop / OrbStack on macOS) and network access to Docker Hub, the
# mise CDN, GitHub releases, and the npm registry.
#
# Expect roughly 5-15 minutes on a first run: the base image is ~350 MiB
# compressed, and mise compiles nothing but downloads six tools.
#
# ---------------------------------------------------------------------------
# IF IT FAILS -- CONTEXT FOR WHOEVER (OR WHATEVER) DEBUGS THIS
# ---------------------------------------------------------------------------
# The Dockerfile was written against facts read out of the published image
# manifest for docker.io/cloudflare/sandbox:0.12.3-python, NOT against the
# Cloudflare docs. Those facts, and why each line depends on them:
#
#   * The base is ubuntu:22.04 + node + npm + npx + bun + python3.11. It runs
#     as root, its entrypoint is /container-server/sandbox, and its WORKDIR is
#     /container-server (so `pwd` inside is NOT /workspace).
#
#   * The base is amd64-only -- the tag resolves to a single manifest, not a
#     multi-arch index. On Apple Silicon or any arm64 host, Docker must emulate
#     via QEMU. That is why every docker command below passes
#     `--platform linux/amd64`. Without it you get "no matching manifest for
#     linux/arm64/v8". With it, the build works but is slow, and the odd
#     segfault in an emulated binary is an emulation artifact rather than a
#     defect in the recipe -- retry once before believing it.
#
#   * The base has NO curl and NO git. Ubuntu's base image ships neither. mise's
#     installer needs curl; Nadi's repository preparation clones with git. The
#     apt layer installs both. If apt fails with "Unable to locate package",
#     the `apt-get update` line was skipped or its lists were wiped by an
#     earlier layer.
#
#   * The base provides npm and npx on PATH. pnpm and yarn are installed
#     explicitly with npm during the image build instead of relying on Corepack.
#     If package-manager installation fails, first confirm npm still works in
#     the base image:
#       docker run --rm --platform linux/amd64 --entrypoint /bin/bash \
#         docker.io/cloudflare/sandbox:0.12.3-python \
#         -lc 'npm --version'
#
#   * The base already runs `mkdir -p /workspace`. Nadi treats /workspace as the
#     working root for every compute file tool, so verify-tools.sh asserts it
#     exists and is writable rather than creating it. If that assertion fails,
#     the base image changed and src/compute/thread-service.ts (WORKSPACE_ROOT)
#     needs to hear about it.
#
#   * mise installs into /usr/local/share/mise and its shims go on PATH via ENV,
#     so tools resolve in the non-login, non-interactive shells the sandbox
#     server spawns. A tool that works in `docker run -it bash` but not through
#     the sandbox's exec is almost always a PATH-not-inherited problem: check
#     that the ENV PATH line survived, not the shim itself.
#
#   * Build context is container/, not the repo root, because Wrangler defaults
#     a container's build context to the directory holding the Dockerfile.
#     `COPY verify-tools.sh` therefore resolves against container/. If you see
#     "failed to compute cache key: verify-tools.sh not found", something
#     changed the context to the repo root.
#
# Version pinning: @cloudflare/sandbox (package.json) and the base image tag
# (container/Dockerfile) must be the same version -- the Worker's client and the
# in-container server speak a versioned protocol. Both are pinned to 0.12.3 and
# test/unit/compute/cloudflare-image.test.ts fails if they drift. Do not bump
# one to fix a build error.
#
# ---------------------------------------------------------------------------
# AFTER THIS PASSES
# ---------------------------------------------------------------------------
# From this same Docker-capable checkout, with a complete .dev.vars:
#
#   pnpm install
#   pnpm run types      # regenerate worker-configuration.d.ts, then commit it
#   pnpm run check
#   pnpm run deploy     # builds the image again and pushes it to Cloudflare
#   pnpm wrangler containers list
#
# The first deploy uploads every layer and can take several minutes; later ones
# push only changed layers. See docs/operations/cloudflare-sandbox.md.
#
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-nadi-cloudflare-sandbox:0.12.3}"
PLATFORM="${PLATFORM:-linux/amd64}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dockerfile="$repo_root/container/Dockerfile"
context="$repo_root/container"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

step "Checking for a running Docker daemon"
if ! command -v docker >/dev/null 2>&1; then
  fail "docker is not on PATH. This script cannot run on a machine without Docker.
       Nadi's primary dev box is one such machine -- that is the whole reason
       this script exists as a handoff to a Docker-capable host."
fi
if ! docker info >/dev/null 2>&1; then
  fail "docker is installed but the daemon is not reachable. Start Docker Desktop,
       Colima, OrbStack, or your system's docker service, then re-run."
fi
docker version --format '    client {{.Client.Version}}, server {{.Server.Version}}' 2>/dev/null || true

if [ ! -f "$dockerfile" ]; then
  fail "$dockerfile is missing. Are you on the feat/cloudflare-compute branch?"
fi

host_arch="$(uname -m)"
if [ "$host_arch" != "x86_64" ]; then
  printf '    note: host is %s but the base image is amd64-only; building under emulation.\n' "$host_arch"
  printf '          This is slow but expected. Set PLATFORM= to override.\n'
fi

step "Building $IMAGE_TAG for $PLATFORM"
printf '    context: %s\n    dockerfile: %s\n\n' "$context" "$dockerfile"
docker build --platform "$PLATFORM" -f "$dockerfile" -t "$IMAGE_TAG" "$context" \
  || fail "image build failed -- read the layer that broke against the notes at the top of this script."

step "Verifying the baked-in tool set"
# The Dockerfile already ran this as its final layer, so a successful build
# implies a successful verify. Running it again catches a stale cached image and
# prints the version table for the record.
docker run --rm --platform "$PLATFORM" --entrypoint /usr/local/bin/verify-nadi-tools "$IMAGE_TAG" \
  || fail "the in-image tool verifier failed. Its output above names the missing or broken tool."

step "Checking the sandbox server survived our layers"
# We add layers on top of Cloudflare's image; the entrypoint binary must still
# be present and executable, or the container will boot and immediately die on
# Cloudflare with no useful log.
docker run --rm --platform "$PLATFORM" --entrypoint /bin/bash "$IMAGE_TAG" -lc '
  set -e
  test -x /container-server/sandbox || { echo "sandbox server binary missing or not executable" >&2; exit 1; }
  echo "    entrypoint: $(ls -l /container-server/sandbox | awk "{print \$1, \$NF}")"
  echo "    node:       $(node --version)"
  echo "    python3:    $(python3 --version 2>&1)"
  echo "    PATH:       $PATH"
' || fail "the image builds but its entrypoint or runtime is broken."

step "Image size"
# Cloudflare caps image size at the disk of the instance type: 8 GB for
# standard-1, 16 GB for standard-3. Nadi uses both. Expect ~1.5 GB.
size_bytes="$(docker image inspect "$IMAGE_TAG" --format '{{.Size}}')"
printf '    %s %s MiB uncompressed\n' "$IMAGE_TAG" "$((size_bytes / 1048576))"

printf '\n\033[32mAll checks passed.\033[0m The image recipe is sound.\n'
printf 'Next: see "AFTER THIS PASSES" in the header of this script.\n\n'
