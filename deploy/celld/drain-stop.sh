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
# This does not assume celld quiesces on SIGTERM. If it does, this is belt and
# braces; if it does not, this is the only thing standing between you and a
# silent rollback to the last eviction.
#
#   ./drain-stop.sh            # drain, then stop everything
#   ./drain-stop.sh --restart  # drain, then restart the node (e.g. after a deploy)

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

echo "Stopping traffic (caddy, ticker-watchdog)..."
compose stop caddy ticker-watchdog

echo "Draining for ${drain_s}s so every cell goes idle and replicates..."
sleep "$drain_s"

if [ "${1:-}" = "--restart" ]; then
	echo "Restarting celld (picks up the current deployment and vars file)..."
	compose restart celld
	compose start caddy ticker-watchdog
	echo "Up. A node loads a deployment at startup only, so this is what makes a"
	echo "'docker compose run --rm deploy' take effect."
else
	echo "Stopping celld..."
	compose stop celld
	echo "Stopped cleanly. Nothing was lost."
fi
