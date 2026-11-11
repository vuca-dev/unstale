#!/usr/bin/env bash
# ingest-cycles.sh's deploy retry, run end to end with fake npm, node, npx and sleep on PATH (the real timeout, at 1 s):
# one cycle drains, publishes and deploys. Run: bash .github/scripts/ingest-cycles.test.sh (needs bash, jq and timeout;
# nothing leaves the machine).
# The checks are conditions evaluated after each run, so they are single-quoted on purpose.
# shellcheck disable=SC2016,SC2034,SC2329
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
script="$(cd "$(dirname "$0")" && pwd)/ingest-cycles.sh"
failed=0

# $1: how many deploys fail before one succeeds; $2: what a failed deploy prints (HANG: it hangs instead). Leaves the exit status in $status and
# the log in $work/out.
run() {
  work="$(mktemp -d "$root/run.XXXXXX")"
  mkdir -p "$work/bin" "$work/repo/gateway" "$work/tmp" "$work/store"
  echo "$1" > "$work/fails"
  printf '%s\n' "$2" > "$work/failure"
  cat > "$work/bin/npm" << 'EOF'
#!/usr/bin/env bash
echo "npm $*" >> "$CALLS"
case "$*" in
  *" drain -- ack "*) ;;
  *" drain -- idle"*) ;;
  *" drain -- "*) echo '{"wall_s":1,"pulled":1,"taken":1,"started":1,"unfinished":0,"drained":true,"early":null,"held":null}' ;;
  *" catalog -- export "*) mkdir -p "$SITE_DIR/v1" && echo '{}' > "$SITE_DIR/v1/index.json" ;;
  *" state -- save "*) echo '{"deleted":[]}' ;;
esac
EOF
  cat > "$work/bin/node" << 'EOF'
#!/usr/bin/env bash
echo "node $*" >> "$CALLS"
case "$1" in gateway/scripts/pack.ts) echo packed ;; esac
EOF
  cat > "$work/bin/npx" << 'EOF'
#!/usr/bin/env bash
echo "npx $*" >> "$CALLS"
# Called as the script means to, with the Cloudflare variables and none of the secrets' own names.
if [ "$*" != "wrangler deploy --assets $SITE_DIR" ] || [ "${CLOUDFLARE_API_TOKEN:-}" != t ] \
  || [ "${CLOUDFLARE_ACCOUNT_ID:-}" != a ] || [ "${WRANGLER_SEND_METRICS:-}" != false ] \
  || [ -n "${SECRET_CLOUDFLARE_API_TOKEN:-}${SECRET_CLOUDFLARE_ACCOUNT_ID:-}${SECRET_SIGNING_KEY:-}" ] \
  || [ "$(basename "$PWD")" != gateway ]; then
  echo "badcall $*" >> "$CALLS"
  exit 3
fi
left="$(cat "$FAKE/fails")"
if [ "$left" -gt 0 ]; then
  echo $((left - 1)) > "$FAKE/fails"
  [ "$(cat "$FAKE/failure")" != HANG ] || { command -p sleep 30; exit 0; }
  cat "$FAKE/failure" >&2
  exit 1
fi
echo "Deployed unstale triggers"
EOF
  cat > "$work/bin/sleep" << 'EOF'
#!/usr/bin/env bash
echo "sleep $*" >> "$CALLS"
EOF
  chmod +x "$work/bin/"*
  : > "$work/calls" && : > "$work/github_output"
  set +e
  (cd "$work/repo" && PATH="$work/bin:$PATH" CALLS="$work/calls" FAKE="$work" RUNNER_TEMP="$work/tmp" \
    SITE_DIR="$work/site" UNSTALE_STORE="$work/store" TAKEN="$work/taken" GITHUB_OUTPUT="$work/github_output" \
    GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 DEPLOY_TIMEOUT_SECONDS=1 SECRET_SIGNING_KEY=k SECRET_CLOUDFLARE_API_TOKEN=t SECRET_CLOUDFLARE_ACCOUNT_ID=a \
    bash "$script") > "$work/out" 2>&1
  status=$?
  set -e
}

count() { grep -c "^$1" "$work/calls" || true; }

# Every run also: the fake npx was called as expected, the deploy output is gone, the wait parse wrote no shell error.
check() {
  if eval "$2" && ! grep -q "^badcall" "$work/calls" && [ ! -e "$work/tmp/deploy.log" ] \
    && ! grep -q "expression expected" "$work/out"; then
    echo "ok: $1"
  else
    echo "FAIL: $1"; sed 's/^/  | /' "$work/out" "$work/calls"; failed=1
  fi
}

throttled='Please wait and consider throttling your request speed [code: 971]
The API responded with a "Retry-After" header indicating you should wait 59 second(s) before retrying.'

run 0 ""
check "a deploy that succeeds is not retried" \
  '[ "$status" -eq 0 ] && [ "$(count npx)" -eq 1 ] && [ "$(count sleep)" -eq 0 ] && [ "$(count "npm.* ack ")" -eq 1 ]'

run 1 "$throttled"
check "a throttled deploy waits the stated 59 s and succeeds on the second attempt" \
  '[ "$status" -eq 0 ] && [ "$(count npx)" -eq 2 ] && grep -qx "sleep 59" "$work/calls" && [ "$(count sleep)" -eq 1 ] \
   && [ "$(count "npm.* ack ")" -eq 1 ] && grep -q "code: 971" "$work/out" && grep -q "Deployed unstale triggers" "$work/out"'

run 1 'The API responded with a "Retry-After" header indicating you should wait 900 second(s) before retrying.'
check "a stated wait is capped at 120 s" '[ "$status" -eq 0 ] && grep -qx "sleep 120" "$work/calls"'

run 1 'POST /accounts/x/workers/scripts/unstale/versions -> 504 Gateway Timeout'
check "a failure without a stated wait pauses 30 s" '[ "$status" -eq 0 ] && grep -qx "sleep 30" "$work/calls"'

run 1 'indicating you should wait 40 second(s) before retrying.
indicating you should wait 10 second(s) before retrying.'
check "of two stated waits the longer is taken" '[ "$status" -eq 0 ] && grep -qx "sleep 40" "$work/calls"'

run 1 'indicating you should wait 99999999999999999999999 second(s) before retrying.'
check "a stated wait too long for shell arithmetic is capped at 120 s, without a shell error" \
  '[ "$status" -eq 0 ] && grep -qx "sleep 120" "$work/calls"'

run 1 'indicating you should wait 0 second(s) before retrying.'
check "a stated wait of 0 s waits 5 s" '[ "$status" -eq 0 ] && grep -qx "sleep 5" "$work/calls"'

run 1 HANG
check "a hung attempt is stopped at the timeout, counted as failed, and retried after 30 s" \
  '[ "$status" -eq 0 ] && [ "$(count npx)" -eq 2 ] && grep -qx "sleep 30" "$work/calls" && grep -q "Deploy timed out" "$work/out" \
   && [ "$(count "npm.* ack ")" -eq 1 ]'

run 9 "$throttled"
check "a deploy failing every attempt fails the cycle: 3 attempts, state saved, nothing acknowledged, no continue" \
  '[ "$status" -eq 1 ] && [ "$(count npx)" -eq 3 ] && [ "$(count sleep)" -eq 2 ] && [ "$(count "npm.* state -- save ")" -eq 1 ] \
   && [ "$(count "npm.* ack ")" -eq 0 ] && grep -q "cycle 1; state saved, nothing acknowledged" "$work/out" \
   && [ ! -s "$work/github_output" ]'

exit "$failed"
