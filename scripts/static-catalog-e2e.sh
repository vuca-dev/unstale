#!/usr/bin/env bash
# Static catalog, end to end: `npm run catalog -- export` from a COPY of the catalog (and of the onboarding jobs,
# for `components`), served by `python3 -m http.server` bound to 127.0.0.1 as a stand-in for GitHub Pages (no
# coverage service behind it: /health and /coverage answer 404 or 501). Drives `unstale init/sync/run` on a `cp -cR` copy of
# the e2e repository. Checks: the export reruns byte-identical with `.nojekyll`; init, sync and run exit 0 with
# records synced; no coverage request is made without a configured service; with the static URL also given as the
# service (`init --service`), init still exits 0, makes no POST /coverage and prints no error. Nothing is served
# beyond 127.0.0.1; ~/unstale/.store and the source repository are never written.
#
#   scripts/static-catalog-e2e.sh       # builds local/target/release/unstale unless UNSTALE_BIN is set
# Environment: STATIC_E2E_CATALOG (default <repo>/.store/catalog), STATIC_E2E_JOBS (default
# <repo>/.store/central/onboarding/jobs), HTTP_E2E_REPO (as scripts/http-sync-e2e.sh), KEEP=1 keeps the scratch.
# Exit status: 0 when every check passes, 1 otherwise.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG_SRC="${STATIC_E2E_CATALOG:-$ROOT/.store/catalog}"
JOBS_SRC="${STATIC_E2E_JOBS:-$ROOT/.store/central/onboarding/jobs}"
REPO_SRC="${HTTP_E2E_REPO:-$HOME/ati-slice0/e2e/next-prisma-app/repo}"
export PATH="$HOME/.cargo/bin:$PATH"
if [ -z "${UNSTALE_BIN:-}" ]; then
  # Never bake a default coverage service into this build (scripts/prepare-dogfood.sh does).
  env -u UNSTALE_DEFAULT_SERVICE cargo build -q --release --manifest-path "$ROOT/local/Cargo.toml" || { echo "client build failed"; exit 1; }
  UNSTALE_BIN="$ROOT/local/target/release/unstale"
fi
UNSTALE="$UNSTALE_BIN"
[ -x "$UNSTALE" ] || { echo "unstale not found at $UNSTALE"; exit 1; }
[ -f "$CATALOG_SRC/v1/root.json" ] || { echo "no catalog at $CATALOG_SRC"; exit 1; }
[ -d "$REPO_SRC" ] || { echo "no e2e repository at $REPO_SRC"; exit 1; }

# tsx's IPC socket path must stay under 104 bytes on macOS: a short scratch root.
WORK="$(mktemp -d /tmp/ustatic.XXXXXX)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && wait "$SERVER_PID" 2>/dev/null
  if [ "${KEEP:-0}" = 1 ]; then echo "scratch kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

FAILS=0
check() { if eval "$2"; then echo "  PASS $1"; else echo "  FAIL $1"; FAILS=$((FAILS + 1)); fi; }
step() { echo; echo "\$ $*"; }

# A side store: the export prunes its source and takes technology locks, so neither touches ~/unstale/.store.
mkdir -p "$WORK/central/onboarding" "$WORK/tmp"
cp -cR "$CATALOG_SRC" "$WORK/catalog" 2>/dev/null || cp -R "$CATALOG_SRC" "$WORK/catalog"
if [ -d "$JOBS_SRC" ]; then cp -cR "$JOBS_SRC" "$WORK/central/onboarding/jobs" 2>/dev/null || cp -R "$JOBS_SRC" "$WORK/central/onboarding/jobs"; fi
cp -cR "$REPO_SRC" "$WORK/repo" 2>/dev/null || cp -R "$REPO_SRC" "$WORK/repo"
catalog() { TMPDIR="$WORK/tmp" UNSTALE_CATALOG_DIR="$WORK/catalog" UNSTALE_CENTRAL_DIR="$WORK/central" npm --prefix "$ROOT/central" run -s catalog -- "$@"; }

step npm run catalog -- export site
catalog export "$WORK/site"; rc=$?
check "export exits 0 and writes .nojekyll, root, indexes and shards" '[ $rc = 0 ] && [ -f "$WORK/site/.nojekyll" ] && [ -f "$WORK/site/v1/root.json" ] && ls "$WORK/site/v1/tech" | grep -q . && ls "$WORK/site/v1/shards" | grep -q .'
check "nothing outside v1/ but .nojekyll" '[ "$(ls -A "$WORK/site" | tr "\n" " ")" = ".nojekyll v1 " ]'
(cd "$WORK/site" && find . -type f -exec shasum -a 256 {} + | sort -k2) >"$WORK/first.sha"
step npm run catalog -- export site   "# rerun"
catalog export "$WORK/site" >/dev/null; rc=$?
(cd "$WORK/site" && find . -type f -exec shasum -a 256 {} + | sort -k2) >"$WORK/second.sha"
check "rerun is byte-identical ($(wc -l <"$WORK/first.sha" | tr -d ' ') files)" '[ $rc = 0 ] && cmp -s "$WORK/first.sha" "$WORK/second.sha"'
check "every index's shards are in the tree with their sha256" 'python3 - "$WORK/site" <<'"'"'PY'"'"'
import hashlib, json, os, sys
site = sys.argv[1]
for f in os.listdir(os.path.join(site, "v1", "tech")):
    for s in json.load(open(os.path.join(site, "v1", "tech", f)))["shards"]:
        p = s["path"] if s["path"].startswith("v1/") else "v1/" + s["path"]
        assert hashlib.sha256(open(os.path.join(site, p), "rb").read()).hexdigest() == s["sha256"], p
PY'

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WORK/site" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/v1/root.json" >/dev/null && break; sleep 0.1; done
URL="http://127.0.0.1:$PORT"
check "a shard is served as raw gzip bytes (no Content-Encoding)" 'p="$(cd "$WORK/site" && find v1/shards -type f | head -1)"; curl -s -D "$WORK/h" -o "$WORK/s.gz" "$URL/$p" && ! grep -qi "^content-encoding" "$WORK/h" && cmp -s "$WORK/s.gz" "$WORK/site/$p"'
unset UNSTALE_SERVICE UNSTALE_CATALOG
export UNSTALE_CACHE_DIR="$WORK/cache" UNSTALE_HTTP_TIMEOUT=10
cd "$WORK/repo" || exit 1
coverage_requests() { grep -cE '"(GET /health|POST /coverage|GET /coverage)' "$WORK/server.log"; }

echo; echo "static catalog served from $URL (python3 http.server, 127.0.0.1 only)"
step unstale init --catalog "$URL" --yes
out="$("$UNSTALE" init --catalog "$URL" --yes 2>&1)"; rc=$?; echo "$out"
check "init exits 0 with the static catalog, no service configured" '[ $rc = 0 ] && grep -q "\"catalog\": *\"$URL\"" .unstale/config.json && ! grep -q "\"service\"" .unstale/config.json'

step unstale sync
out="$("$UNSTALE" sync 2>&1)"; rc=$?; echo "$out"
check "sync exits 0 and downloads records" '[ $rc = 0 ] && echo "$out" | grep -qE "synced [^:]+: [1-9][0-9]* records.*downloaded"'
check "no error lines" '! echo "$out" | grep -qi "error"'
check "records arrived in the cache" '[ -n "$(find "$UNSTALE_CACHE_DIR/v1/shards" -name "*.jsonl.gz" 2>/dev/null | head -1)" ]'

step unstale run
"$UNSTALE" run >"$WORK/run.out" 2>&1; rc=$?; head -12 "$WORK/run.out"
check "run exits 0 and writes the skill file" '[ $rc = 0 ] && [ -f .unstale/skills/upgrade-review/SKILL.md ]'
check "no error lines in run" '! grep -qi "error" "$WORK/run.out"'
check "no coverage request reached the static host" '[ "$(coverage_requests)" = 0 ]'

echo; echo "# the static URL also given as the coverage service (no service behind it)"
rm -rf .unstale
export UNSTALE_CACHE_DIR="$WORK/cache2"
step unstale init --service "$URL" --yes --no-animation
out="$("$UNSTALE" init --service "$URL" --yes --no-animation 2>&1)"; rc=$?; echo "$out" | grep -iE "coverage|catalog|unavailable|error" | head -8
check "init --service <static host> exits 0" '[ $rc = 0 ]'
check "no POST /coverage was sent" '! grep -q "\"POST /coverage" "$WORK/server.log"'
check "no error lines about coverage" '! echo "$out" | grep -qiE "error.*coverage|coverage.*error"'
# Desired: a host that answers without the coverage service is a catalog-only host, not an outage to retry.
check "not reported as an unavailable service to retry" '! echo "$out" | grep -qiE "unavailable.*retry|retry.*unavailable"'
check "init itself synced the catalog" '[ -n "$(find "$UNSTALE_CACHE_DIR/v1/shards" -name "*.jsonl.gz" 2>/dev/null | head -1)" ]'
step unstale sync
out="$("$UNSTALE" sync 2>&1)"; rc=$?; echo "$out"
check "sync after init --service exits 0 with records" '[ $rc = 0 ] && echo "$out" | grep -qE "synced [^:]+: [1-9][0-9]* records"'
check "the onboarding report does not call the static host an outage" '! grep -qi "service was unavailable" .unstale/onboarding-report.md'

echo
if [ "$FAILS" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
[ "$FAILS" = 0 ]
