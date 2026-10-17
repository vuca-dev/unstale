#!/usr/bin/env bash
# Bare `npx unstale` rehearsal against a LOCAL registry only: Verdaccio on 127.0.0.1 (no uplinks, so nothing can be
# proxied from npmjs.org), the npm/dist tarballs published to it, then `npx unstale --version`, `init` and `run` in a
# clean directory with a fresh HOME, npm cache and user config, on a `cp -cR` copy of the next-prisma-app repository.
#
#   VERDACCIO_DIR=<dir with node_modules/.bin/verdaccio> npm/rehearse-npx.sh <scratch dir>
# Run npm/build.sh first. Verdaccio is stopped on exit. Never publishes anywhere but http://127.0.0.1:<port>.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
W="${1:?usage: npm/rehearse-npx.sh <scratch dir>}"
V="${VERDACCIO_DIR:?set VERDACCIO_DIR to a directory where verdaccio is installed (npm install verdaccio)}"
REPO_SRC="${NPX_REPO:-$HOME/ati-slice0/e2e/next-prisma-app/repo}"
CATALOG="${NPX_CATALOG:-$here/../.store/catalog}"
mkdir -p "$W" && W="$(cd "$W" && pwd)"
rm -rf "$W/run" && mkdir -p "$W/run"/{home,storage,clean}
R="$W/run"

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
REG="http://127.0.0.1:$PORT"
cat >"$R/config.yaml" <<EOF
storage: $R/storage
auth:
  htpasswd:
    file: $R/htpasswd
    max_users: -1
uplinks: {}
packages:
  '**':
    access: \$all
    publish: \$all
    unpublish: \$all
listen: 127.0.0.1:$PORT
log: { type: stdout, format: pretty, level: warn }
EOF
"$V/node_modules/.bin/verdaccio" --config "$R/config.yaml" >"$R/verdaccio.log" 2>&1 &
VPID=$!
stop() { kill "$VPID" 2>/dev/null; wait "$VPID" 2>/dev/null; }
trap stop EXIT
for _ in $(seq 100); do curl -sf "$REG/-/ping" >/dev/null && break; sleep 0.2; done
curl -sf "$REG/-/ping" >/dev/null || { echo "verdaccio did not start"; cat "$R/verdaccio.log"; exit 1; }

# A fresh npm environment: its own HOME, user and global config, cache. The token is a placeholder for the local
# registry only (npm refuses to publish without one; Verdaccio here lets anyone publish).
export HOME="$R/home" npm_config_cache="$R/home/.npm" npm_config_userconfig="$R/home/.npmrc" npm_config_globalconfig="$R/globalnpmrc"
unset npm_config_registry NPM_CONFIG_REGISTRY
printf 'registry=%s/\n//127.0.0.1:%s/:_authToken=local-rehearsal-placeholder\nupdate-notifier=false\nfund=false\naudit=false\n' "$REG" "$PORT" >"$npm_config_userconfig"
: >"$npm_config_globalconfig"

echo "# Verdaccio $("$V/node_modules/.bin/verdaccio" --version) on $REG (no uplinks); node $(node --version), npm $(npm --version)"
echo "# HOME=$HOME (fresh), npm cache $npm_config_cache (empty)"

local_publish() {
  # Refuse anything but a localhost registry, checked on the exact string passed to npm.
  case "$2" in http://127.0.0.1:[0-9]*) ;; *) echo "REFUSING to publish to $2"; exit 1 ;; esac
  echo "\$ npm publish $(basename "$1") --registry $2"
  npm publish "$1" --registry "$2" 2>&1 | grep -E '^\+|npm (error|ERR)|notice Publishing'
}
for t in "$here"/dist/unstale-cli-*.tgz "$here"/dist/unstale-0*.tgz; do
  local_publish "$t" "$REG"
done

echo; echo "\$ npm view unstale optionalDependencies --registry $REG"
npm view unstale optionalDependencies --registry "$REG"

cp -cR "$REPO_SRC" "$R/repo"
export UNSTALE_CACHE_DIR="$R/unstale-cache"
cd "$R/clean" || exit 1
echo; echo "\$ cd <clean dir> && npx --yes --registry $REG unstale --version"
npx --yes --loglevel http --registry "$REG" unstale --version 2>"$R/npx-http.log"; echo "(exit $?)"
echo "registry requests made by npx: $(grep -c "npm http fetch" "$R/npx-http.log"), to hosts: $(grep -o 'npm http fetch GET [0-9]* https\?://[^/]*' "$R/npx-http.log" | awk '{print $NF}' | sort -u | tr '\n' ' ')"
echo "platform packages installed by npx: $(ls "$HOME"/.npm/_npx/*/node_modules/@unstale/ | tr '\n' ' ')"

cd "$R/repo" || exit 1
echo; echo "\$ cd <copy of next-prisma-app/repo> && npx --registry $REG unstale init --catalog ~/unstale/.store/catalog --yes"
npx --yes --registry "$REG" unstale init --catalog "$CATALOG" --yes; echo "(exit $?)"
echo; echo "\$ npx --registry $REG unstale run"
npx --yes --registry "$REG" unstale run >"$R/run.out" 2>&1; rc=$?
head -8 "$R/run.out" | cut -c1-200
echo "... ($(wc -l <"$R/run.out" | tr -d ' ') lines)"
tail -3 "$R/run.out" | cut -c1-200
echo "(exit $rc)"
ls .unstale/skills/*/SKILL.md

stop; trap - EXIT
sleep 0.5
if curl -s -m 2 "$REG/-/ping" >/dev/null; then echo "verdaccio still answering on $REG"; exit 1; fi
echo; echo "# Verdaccio stopped; $REG no longer answers."
