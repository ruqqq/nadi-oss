#!/usr/bin/env bash
# Build workspaces/<id>/secret-index from the secret keys already in KV.
#
# One-off: Nadi maintains the index on every write from the release that
# introduced it. Run this once per deployment, right after deploying that
# release and BEFORE serving traffic — until it runs, every settings page 500s
# with `index_missing` and every secret write is refused. That is deliberate:
# the alternative was a listing that silently showed no secrets.
#
# Idempotent. Re-running over a healthy index rewrites identical bytes.
#
# `celld kv list` is capped at a 49-byte prefix, so this lists on `workspaces/`
# (11 bytes) and filters here.
set -euo pipefail
cd "$(dirname "$0")"

kv() {
  # Capture docker's own exit status before any pipe — piping straight into
  # `grep -v` would make the function's exit status grep's (1 when the
  # filter drops every line, indistinguishable from a genuine docker/minio
  # failure). A successful-but-empty listing must return 0.
  #
  # `</dev/null` is load-bearing, not hygiene. `docker compose run` without it
  # attaches the caller's stdin, and this function is called from inside a
  # `while IFS= read -r key` loop — so the first `kv get` swallowed the rest of
  # the loop's input and every workspace was indexed with exactly one secret,
  # silently. Measured on the live host: two secrets in KV, one in the index.
  local out status
  out=$(docker compose run --rm --entrypoint celld migrate kv "$@" \
    --bucket s3://celld-fleet --endpoint http://minio:9000 2>/dev/null </dev/null)
  status=$?
  if [ "$status" -ne 0 ]; then
    return "$status"
  fi
  printf '%s\n' "$out" | grep -v "INFO object_store" || true
  return 0
}

# Capture the list call's own exit status before filtering, so a docker/minio
# failure (which also yields empty stdout) is not mistaken for "no keys".
if ! all_keys=$(kv list nadi-secrets --prefix "workspaces/" --all); then
  echo "error: celld kv list failed — aborting without writing an index" >&2
  exit 1
fi

keys=$(printf '%s\n' "$all_keys" | grep '/secrets/' || true)
# A workspace with a DEK but zero secret keys (its last secret got deleted)
# never shows up in $keys, but it still needs an index — a DEK with no index
# reads as "predates the index" and index_missing throws forever, with no
# runtime repair path. The DEK listing is already in hand from $all_keys.
dek_workspaces=$(printf '%s\n' "$all_keys" | grep -E '^workspaces/[^/]+/dek$' | sed -E 's#^workspaces/([^/]+)/dek$#\1#' | sort -u || true)

if [ -z "$keys" ] && [ -z "$dek_workspaces" ]; then
  echo "no secret keys found — nothing to backfill"
  exit 0
fi

secret_workspaces=$(printf '%s\n' "$keys" | sed -E 's#^workspaces/([^/]+)/secrets/.*#\1#' | sort -u || true)
workspaces=$(printf '%s\n%s\n' "$secret_workspaces" "$dek_workspaces" | sed '/^$/d' | sort -u)
for ws in $workspaces; do
  entries=""
  while IFS= read -r key; do
    name=${key#workspaces/$ws/secrets/}
    updated=$(kv get nadi-secrets "$key" | python3 -c 'import json,sys; print(json.load(sys.stdin)["updated_at"])')
    entries="$entries$(printf '%s\t%s\n' "$name" "$updated")"$'\n'
  done < <(printf '%s\n' "$keys" | grep "^workspaces/$ws/secrets/" || true)

  index=$(printf '%s' "$entries" | python3 -c '
import json,sys
entries = {}
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line: continue
    name, updated = line.split("\t", 1)
    entries[name] = {"updated_at": updated}
print(json.dumps({"version": 1, "entries": entries}))')

  kv put nadi-secrets "workspaces/$ws/secret-index" "$index" >/dev/null
  echo "$ws: $(printf '%s' "$index" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["entries"]))') secrets indexed"
done
echo "backfill complete"
