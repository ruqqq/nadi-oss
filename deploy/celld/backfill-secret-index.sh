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
  docker compose run --rm --entrypoint celld migrate kv "$@" \
    --bucket s3://celld-fleet --endpoint http://minio:9000 2>/dev/null \
    | grep -v "INFO object_store"
}

# Capture the list call's own exit status before filtering, so a docker/minio
# failure (which also yields empty stdout) is not mistaken for "no keys".
if ! all_keys=$(kv list nadi-secrets --prefix "workspaces/" --all); then
  echo "error: celld kv list failed — aborting without writing an index" >&2
  exit 1
fi

keys=$(printf '%s\n' "$all_keys" | grep '/secrets/' || true)
if [ -z "$keys" ]; then
  echo "no secret keys found — nothing to backfill"
  exit 0
fi

workspaces=$(printf '%s\n' "$keys" | sed -E 's#^workspaces/([^/]+)/secrets/.*#\1#' | sort -u)
for ws in $workspaces; do
  entries=""
  while IFS= read -r key; do
    name=${key#workspaces/$ws/secrets/}
    updated=$(kv get nadi-secrets "$key" | python3 -c 'import json,sys; print(json.load(sys.stdin)["updated_at"])')
    entries="$entries$(printf '%s\t%s\n' "$name" "$updated")"$'\n'
  done < <(printf '%s\n' "$keys" | grep "^workspaces/$ws/secrets/")

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
