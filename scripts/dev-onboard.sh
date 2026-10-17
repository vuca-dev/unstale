#!/usr/bin/env bash
# Run the actual native client against the unpublished development central service.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
repo="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi
[ -x "$root/.dev/npm/bin/unstale" ] || { echo 'Prepare once: scripts/prepare-dogfood.sh' >&2; exit 1; }
export UNSTALE_SERVICE="${UNSTALE_SERVICE:-http://127.0.0.1:47831}"
# Let generated skill instructions invoke the same client, not an older global binary.
export PATH="$root/.dev/npm/bin:$PATH"
"$root/scripts/dev-central.sh" start >/dev/null
exec "$root/.dev/npm/bin/unstale" -C "$repo" init "$@"
