#!/usr/bin/env bash
# http(s) catalog location, end to end: serve a COPY of the catalog with `python3 -m http.server` bound to 127.0.0.1
# (Last-Modified validators, no ETag), and drive `unstale init/sync/run` on a `cp -cR` copy of the next-prisma-app
# e2e repository. Checks: first sync downloads, second sync is "unchanged" via 304s, a corrupted shard is refused
# with the cache kept (exit 1), a 404 index means "not covered", a 404 root and a dead server are clear errors.
# Nothing is served beyond 127.0.0.1; ~/unstale/.store and the source repository are never written.
#
#   scripts/http-sync-e2e.sh            # uses `unstale` on PATH (or UNSTALE_BIN)
# Exit status: 0 when every check passes, 1 otherwise.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG_SRC="${HTTP_E2E_CATALOG:-$ROOT/.store/catalog}"
REPO_SRC="${HTTP_E2E_REPO:-$HOME/ati-slice0/e2e/next-prisma-app/repo}"
UNSTALE="${UNSTALE_BIN:-unstale}"
export PATH="$HOME/.cargo/bin:$PATH"
command -v "$UNSTALE" >/dev/null || { echo "unstale not found"; exit 1; }
[ -f "$CATALOG_SRC/v1/root.json" ] || { echo "no catalog at $CATALOG_SRC"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/unstale-http-e2e.XXXXXX")"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  if [ "${KEEP:-0}" = 1 ]; then echo "scratch kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

FAILS=0
check() { if eval "$2"; then echo "  PASS $1"; else echo "  FAIL $1"; FAILS=$((FAILS + 1)); fi; }
step() { echo; echo "\$ $*"; }

cp -cR "$CATALOG_SRC" "$WORK/site" 2>/dev/null || cp -R "$CATALOG_SRC" "$WORK/site"
cp -cR "$REPO_SRC" "$WORK/repo" 2>/dev/null || cp -R "$REPO_SRC" "$WORK/repo"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WORK/site" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/v1/root.json" >/dev/null && break; sleep 0.1; done
URL="http://127.0.0.1:$PORT"
export UNSTALE_CACHE_DIR="$WORK/cache" UNSTALE_HTTP_TIMEOUT=10
cd "$WORK/repo" || exit 1
requests() { grep -c "\"GET $1 HTTP/1.1\" $2" "$WORK/server.log"; }

echo "catalog served from a copy at $URL (python3 http.server, 127.0.0.1 only)"
step unstale init --catalog "$URL" --yes
"$UNSTALE" init --catalog "$URL" --yes; rc=$?
check "init accepts an http catalog (exit 0)" '[ $rc = 0 ] && grep -q "\"catalog\": *\"$URL\"" .unstale/config.json'

step unstale sync
out="$("$UNSTALE" sync 2>&1)"; rc=$?; echo "$out"
check "first sync downloads next and prisma (exit 0)" '[ $rc = 0 ] && echo "$out" | grep -q "synced next:.*downloaded" && echo "$out" | grep -q "synced prisma:.*downloaded"'
check "index requests answered 200" '[ "$(requests /v1/tech/next.json 200)" = 1 ]'

step unstale sync
out="$("$UNSTALE" sync 2>&1)"; rc=$?; echo "$out"
check "second sync is unchanged (exit 0)" '[ $rc = 0 ] && echo "$out" | grep -q "synced next: .*unchanged" && echo "$out" | grep -q "synced prisma: .*unchanged"'
check "second sync got 304 Not Modified for the indexes" '[ "$(requests /v1/tech/next.json 304)" = 1 ] && [ "$(requests /v1/tech/prisma.json 304)" = 1 ]'

step unstale run
"$UNSTALE" run >"$WORK/run.out" 2>&1; rc=$?; head -12 "$WORK/run.out"
check "run over the http catalog (exit 0, review context written)" '[ $rc = 0 ] && [ -f .unstale/review/upgrades.md ]'

echo; echo "# corrupt one next shard on the server and drop it from the cache"
shard="$(ls "$WORK/site/v1/shards/next" | head -1)"
python3 - "$WORK/site/v1/shards/next/$shard" <<'PY'
import sys
p = sys.argv[1]; b = bytearray(open(p, "rb").read()); b[-1] ^= 0xFF; open(p, "wb").write(b)
PY
touch "$WORK/site/v1/tech/next.json"   # new Last-Modified: the index is fetched again
rm "$UNSTALE_CACHE_DIR/v1/shards/next/$shard"
before="$(shasum -a 256 "$UNSTALE_CACHE_DIR/v1/tech/next.json")"
step unstale sync
out="$("$UNSTALE" sync 2>&1)"; rc=$?; echo "$out"
check "corrupted shard refused with exit 1, sha256 named" '[ $rc = 1 ] && echo "$out" | grep -q "error: next: .*sha256.*cached copy kept"'
check "cached next index untouched" '[ "$(shasum -a 256 "$UNSTALE_CACHE_DIR/v1/tech/next.json")" = "$before" ]'
check "prisma still synced in the same run" 'echo "$out" | grep -q "synced prisma: .*unchanged"'

echo; echo "# remove prisma's index from the server (404)"
rm "$WORK/site/v1/tech/prisma.json"
step unstale sync
out="$("$UNSTALE" sync 2>&1)"; rc=$?; echo "$out"
check "404 index: prisma no longer reported as synced, counted as not covered" '! echo "$out" | grep -q "synced prisma" && echo "$out" | grep -q "Not covered by the catalog"'
check "404 index request was made" '[ "$(requests /v1/tech/prisma.json 404)" -ge 1 ]'

echo; echo "# remove the root (404)"
mv "$WORK/site/v1/root.json" "$WORK/site/v1/root.json.off"
step unstale sync
out="$("$UNSTALE" sync 2>&1)"; rc=$?; echo "$out"
check "404 root: exit 1 and 'no catalog at'" '[ $rc = 1 ] && echo "$out" | grep -q "no catalog at $URL/v1/root.json"'
mv "$WORK/site/v1/root.json.off" "$WORK/site/v1/root.json"

echo; echo "# a newer schema at the root"
cp "$WORK/site/v1/root.json" "$WORK/root.bak"; echo '{"schema":2,"min_client":"0.1.0"}' >"$WORK/site/v1/root.json"
step unstale sync
out="$("$UNSTALE" sync 2>&1)"; rc=$?; echo "$out"
check "newer schema over http: exit 4" '[ $rc = 4 ]'
cp "$WORK/root.bak" "$WORK/site/v1/root.json"

echo; echo "# stop the server"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
step unstale sync
out="$("$UNSTALE" sync 2>&1)"; rc=$?; echo "$out"
check "server down: exit 1 naming the URL" '[ $rc = 1 ] && echo "$out" | grep -q "GET $URL/v1/root.json"'

echo
if [ "$FAILS" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
[ "$FAILS" = 0 ]
