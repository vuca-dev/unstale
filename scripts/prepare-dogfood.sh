#!/usr/bin/env bash
# Developer build and private local installation. Publishes nothing.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
platform="$(node -p 'process.platform+"-"+process.arch')"
export UNSTALE_DEFAULT_SERVICE="${UNSTALE_SERVICE:-http://127.0.0.1:${UNSTALE_PORT:-47831}}"
npm/build.sh "$platform"
npm install --global --prefix "$root/.dev/npm" --cache "$root/.dev/npm-cache" --offline --no-audit --no-fund \
  "$root/npm/dist/unstale-cli-$platform-0.1.0.tgz" "$root/npm/dist/unstale-0.1.0.tgz"
"$root/scripts/dev-central.sh" start
printf '\nReady. Try:\n  %s -C /path/to/repo init\n' "$root/.dev/npm/bin/unstale"
