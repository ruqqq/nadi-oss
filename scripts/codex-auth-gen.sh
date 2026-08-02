#!/usr/bin/env bash
#
# Generate a Codex OAuth auth.json via the device-authorization flow in an
# ISOLATED Codex home, so your real ~/.codex login is never touched.
#
# The resulting auth.json is the secret Nadi stores for the openai-oauth
# provider. Pipe it straight into `pnpm secret:put` (which reads stdin), e.g.:
#
#   WORKSPACE_ID=... SECRET_NAME=openai-oauth \
#   SECRETS_STORE_KEK_RAW_B64=... KV_NAMESPACE_ID=... \
#     scripts/codex-auth-gen.sh -o - | pnpm secret:put
#
# Usage:
#   scripts/codex-auth-gen.sh [-o OUTPUT]
#
#   -o OUTPUT   Where to write the auth.json. A path, or "-" for stdout.
#               Default: ./codex-auth.json
#   -h          Show this help.
#
set -euo pipefail

OUTPUT="./codex-auth.json"
while getopts ":o:h" opt; do
  case "$opt" in
    o) OUTPUT="$OPTARG" ;;
    h)
      sed -n '3,18p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown option -$OPTARG (use -h for help)" >&2
      exit 2
      ;;
  esac
done

if ! command -v codex >/dev/null 2>&1; then
  echo "error: 'codex' CLI not found on PATH" >&2
  exit 1
fi

# This flow is intentionally device-auth only: it never opens a browser and
# never writes to your real Codex home. The flag was renamed across versions
# (--device-code -> --device-auth), so pick whichever this codex understands.
DEVICE_FLAG=""
login_help="$(codex login --help 2>&1 || true)"
if grep -q -- "--device-code" <<<"$login_help"; then
  DEVICE_FLAG="--device-code"
elif grep -q -- "--device-auth" <<<"$login_help"; then
  DEVICE_FLAG="--device-auth"
else
  echo "error: this codex build exposes neither --device-code nor --device-auth" >&2
  echo "       (\`codex login --help\` shows no device-authorization flag)" >&2
  exit 1
fi

# Isolated Codex home. Kept under \$HOME (not /tmp) so codex doesn't warn about
# refusing to create helper binaries under a temp dir.
ISOLATED_HOME="$(mktemp -d "${HOME%/}/.codex-auth-gen.XXXXXX")"
cleanup() {
  rm -rf "$ISOLATED_HOME"
}
trap cleanup EXIT

echo "Using isolated CODEX_HOME=$ISOLATED_HOME (your real ~/.codex is untouched)." >&2
echo "Running: codex login $DEVICE_FLAG" >&2
echo >&2

# Send all of codex's interactive chatter to stderr so stdout stays clean for
# the `-o -` (pipe to secret:put) case.
CODEX_HOME="$ISOLATED_HOME" codex login "$DEVICE_FLAG" 1>&2

AUTH_FILE="$ISOLATED_HOME/auth.json"
if [[ ! -f "$AUTH_FILE" ]]; then
  echo "error: login completed but no auth.json was written at $AUTH_FILE" >&2
  exit 1
fi

if [[ "$OUTPUT" == "-" ]]; then
  cat "$AUTH_FILE"
else
  install -m 600 /dev/null "$OUTPUT"
  cat "$AUTH_FILE" >"$OUTPUT"
  echo >&2
  echo "Wrote auth.json -> $OUTPUT (mode 600)." >&2
  echo "Store it in Nadi with, e.g.:" >&2
  echo "  SECRET_VALUE_FILE=$OUTPUT WORKSPACE_ID=... SECRET_NAME=openai-oauth \\" >&2
  echo "    SECRETS_STORE_KEK_RAW_B64=... KV_NAMESPACE_ID=... pnpm secret:put" >&2
fi
