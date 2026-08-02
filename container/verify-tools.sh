#!/usr/bin/env bash
# Assert the curated Nadi tool set is present and callable.
#
# Runs as the final Dockerfile layer, so a missing tool fails the build rather
# than surfacing as a confusing "command not found" inside a live agent session.
# Also runnable against a built image:
#
#   docker run --rm --entrypoint /usr/local/bin/verify-nadi-tools <image>
#
# Each tool is invoked, not merely located: a mise shim can exist on PATH while
# the binary it points at is missing, and `command -v` would still succeed.
set -euo pipefail

failures=0

check() {
  local tool="$1"
  shift
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "MISSING  $tool (not on PATH)" >&2
    failures=$((failures + 1))
    return
  fi
  # Capture in full before trimming. Piping straight into `head -n 1` under
  # `set -o pipefail` lets SIGPIPE kill a tool that prints several version
  # lines (shellcheck, curl, gh do), reporting a healthy tool as BROKEN.
  local output
  if ! output="$("$@" 2>&1)"; then
    echo "BROKEN   $tool (on PATH at $(command -v "$tool") but failed to run)" >&2
    failures=$((failures + 1))
    return
  fi
  printf 'ok       %-11s %s\n' "$tool" "${output%%$'\n'*}"
}

echo "== runtimes provided by the base image"
check node node --version
check npm npm --version
check python3 python3 --version

echo "== package managers installed from npm"
check pnpm pnpm --version
check yarn yarn --version

echo "== tools baked in with mise"
check gh gh --version
check jq jq --version
check rg rg --version
check fd fd --version
check yq yq --version
check shellcheck shellcheck --version

echo "== tools installed from apt"
check git git --version
check curl curl --version

echo "== workspace root"
# The sandbox server chroots nothing; /workspace is the agreed working root and
# every compute file-tool path resolves under it.
if [ ! -d /workspace ]; then
  echo "MISSING  /workspace (expected the base image to create it)" >&2
  failures=$((failures + 1))
elif ! touch /workspace/.nadi-write-probe 2>/dev/null; then
  echo "BROKEN   /workspace is not writable" >&2
  failures=$((failures + 1))
else
  rm -f /workspace/.nadi-write-probe
  echo "ok       /workspace exists and is writable"
fi

if [ "$failures" -ne 0 ]; then
  echo >&2
  echo "verify-nadi-tools: $failures check(s) failed" >&2
  exit 1
fi

echo
echo "verify-nadi-tools: all checks passed"
