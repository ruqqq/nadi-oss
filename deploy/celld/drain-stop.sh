#!/bin/sh
# Stop the stack without losing data.
#
# celld replicates a cell to the bucket only when that cell goes IDLE. Stopping
# the node while requests are still arriving therefore discards everything
# written since the last eviction — and it does so even though the machine and
# its disk are fine, because celld restores from the bucket at startup and
# drops local-only state.
#
# So the order matters: cut traffic first, wait past the eviction threshold so
# every cell replicates, and only then stop the node.
#
# celld v0.4.0 drains on SIGTERM — `docker compose stop` is no longer reckless —
# and this script is belt and braces over that: it cuts traffic first and waits
# past the eviction threshold so every cell replicates before the node stops.
#
#   ./drain-stop.sh            # drain, then stop everything
#   ./drain-stop.sh --restart  # drain, then restart the node (vars-file change,
#                              #  or a celld version bump — not a deploy)

set -eu

cd "$(dirname "$0")"

compose() {
	if docker compose version >/dev/null 2>&1; then
		docker compose "$@"
	else
		docker-compose "$@"
	fi
}

evict_s="$( (grep -E '^CELLD_IDLE_EVICT_S=' .env 2>/dev/null || echo 'CELLD_IDLE_EVICT_S=15') | tail -1 | cut -d= -f2)"
# Wait a full extra interval past the threshold: eviction is checked on a
# timer, so a cell that went quiet just after a check waits nearly two.
drain_s=$((evict_s * 2 + 5))

echo "Stopping traffic (caddy)..."
compose stop caddy

echo "Draining for ${drain_s}s so every cell goes idle and replicates..."
sleep "$drain_s"

if [ "${1:-}" = "--restart" ]; then
	echo "Restarting celld (picks up the current deployment and vars file)..."
	compose restart celld
	compose start caddy
	echo "Up. Vars-file changes and celld version bumps need a restart; a"
	echo "v0.4.0 node adopts a new deploy in place without one."
else
	echo "Stopping celld..."
	compose stop celld
	echo "Stopped cleanly. Nothing was lost."
fi
