#!/usr/bin/env bash
# The drain step of ingest.yml: cycles of drain then publish, so a package is published within a cycle of being
# worked instead of at the end of the run.
#
#   cycle: drain (CYCLE_MINUTES, pulling the gateway every PULL_MINUTES) -> export -> website -> verify -> pack -> deploy
#          -> save state -> acknowledge what the drain took
#
# Early publish: a cycle whose drain pulled packages new to central ends once each has a firm decision (its token-free
# first pass: admitted, refused and why, no official sources) and it has drained EARLY_MINUTES, with EARLY_GRACE_MINUTES
# for running slices, so decisions and advisories are published minutes after registration (onboarding/drain.ts).
# EARLY_MINUTES keeps publishes that far apart: at most about one every 7 minutes (5 of drain, 1 of grace, about 1 of
# publish), about 206 acknowledgements a day at ≤ 65 gateway rows each, inside the free tier (gateway/src/queue.ts).
#
# Cycles repeat while work is left and the run's window (RUN_MINUTES) lasts. A drain that ends because nothing more
# can start (queue empty, or the budget spent) ends the run. A window that ends with work left sets the step output
# `continue=true`, and ingest.yml's `continue` job starts the next run at once instead of waiting for the schedule. Every run is the same whatever started it, so a
# run that replaces another pending one (GitHub keeps one pending run per concurrency group) loses nothing.
#
# Crash safety: state and acknowledgement move in step, once a cycle. A cancelled run loses at most its current cycle,
# whose requests the gateway still holds (unacknowledged) and whose jobs resume from the last saved state; model
# calls are cached. Saved after a failed drain or publish too (writes are atomic per file, stale locks are detected
# by pid, and the model calls a partial run paid for are kept), then the step fails.
#
# Single cycle, state saved but nothing acknowledged: when the run does not deploy (DEPLOY=false: export and verify
# only). Several unacknowledged cycles would take the same requests twice.
#
# A failed pipeline (the catalog technologies' refresh, PIPELINE_OK=false) holds nothing back: the cycles publish as
# usual and the job still fails on the pipeline step. Holding the deploy protected nothing (the drain wrote the same
# store, the state was saved and the next run exported it) and only delayed every other technology by a run: in run
# 39155206031 a classifier refusal on `next` kept 490 starts and 411 registrations unpublished for 140 minutes.
#
# State: one generation per save (state-<stamp>-<run>-<attempt>), the newest of each run kept for the newest
# STATE_KEEP runs, so saving every cycle keeps the same rollback depth as one save a run; a save uploads only what the
# cycle changed.
#
# Environment: UNSTALE_STORE, SITE_DIR, TAKEN, UNSTALE_STATE_REMOTE and UNSTALE_STATE_SOCKET (ingest.yml's restore),
# PIPELINE_OK, DEPLOY, the central and gateway
# variables of ingest.yml, and the publish secrets under SECRET_* names, handed only to the command that needs them.
set -euo pipefail

: "${RUN_MINUTES:=140}" "${CYCLE_MINUTES:=15}" "${GRACE_MINUTES:=5}" "${PULL_MINUTES:=5}" "${CONCURRENCY:=6}"
: "${EARLY_MINUTES:=5}" "${EARLY_GRACE_MINUTES:=1}"
[[ "$CONCURRENCY" =~ ^[1-9][0-9]?$ ]] || { echo "CONCURRENCY must be 1-99, not '$CONCURRENCY'" >&2; exit 1; }
: "${STATE_KEEP:=3}" "${ASSET_FILE_LIMIT:=20000}" "${PIPELINE_OK:=true}" "${DEPLOY:=true}"

# The drain fetches untrusted pages; it never sees the publish secrets. Publishing never sees the model keys. Neither
# sees GH_TOKEN (the job's token, with write access to the state release): only this script's state save uses it.
drain_env=(env -u GH_TOKEN -u SECRET_SIGNING_KEY -u SECRET_CLOUDFLARE_API_TOKEN -u SECRET_CLOUDFLARE_ACCOUNT_ID)
publish_env=(env -u GH_TOKEN -u SECRET_SIGNING_KEY -u SECRET_CLOUDFLARE_API_TOKEN -u SECRET_CLOUDFLARE_ACCOUNT_ID -u JEV_API_KEY -u AI_GATEWAY_API_KEY -u GITHUB_TOKEN -u UNSTALE_GATEWAY_TOKEN)

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# Each command checked explicitly: called in a condition, a function runs without `set -e`, and a failed export must
# never let the previous cycle's tree be verified and deployed in its place.
#
# The export's shards may be hard links to the store's (central/src/pipeline/export.ts): every step here only reads,
# unlinks or adds files in "$SITE_DIR", never writes one in place, which would change the store's shard too.
publish_tree() {
  rm -rf "$SITE_DIR"
  "${publish_env[@]}" UNSTALE_SIGNING_KEY="$SECRET_SIGNING_KEY" npm --prefix central run -s catalog -- export "$SITE_DIR" || return 1
  # The website at unstale.sh (gateway/site/build.ts): built aside and copied in only when complete; a failure never
  # blocks the catalog deploy.
  local web="$RUNNER_TEMP/web"
  rm -rf "$web" && mkdir -p "$web" && ln -s "$SITE_DIR/v1" "$web/v1" || return 1
  if "${publish_env[@]}" node gateway/site/build.ts "$web" && rm "$web/v1" && cp -R "$web/." "$SITE_DIR/"; then
    :
  else
    echo "::warning title=Website not built::The catalog deploys without it."
  fi
  rm -rf "$web"
  "${publish_env[@]}" node .github/scripts/verify-catalog.mjs "$SITE_DIR" || return 1
  # Under the static asset file limit whatever the catalog holds: what does not fit as files goes into at most 4,096
  # bucket files the Worker reads (gateway/src/pack.ts); the most requested files stay as they are.
  local packed files big
  packed="$("${publish_env[@]}" node gateway/scripts/pack.ts "$SITE_DIR" --max-files "$ASSET_FILE_LIMIT")" || return 1
  log "pack: $packed"
  files="$(find "$SITE_DIR" -type f | wc -l)"
  big="$(find "$SITE_DIR" -type f -size +25M | wc -l)"
  log "site: $files files, $(du -sh "$SITE_DIR" | cut -f1)"
  [ "$files" -le "$ASSET_FILE_LIMIT" ] || { echo "::error::$files files, over the $ASSET_FILE_LIMIT static asset limit"; return 1; }
  [ "$big" -eq 0 ] || { echo "::error::$big files over the 25 MiB static asset limit"; return 1; }
}

deploy() {
  (cd gateway && "${publish_env[@]}" CLOUDFLARE_API_TOKEN="$SECRET_CLOUDFLARE_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$SECRET_CLOUDFLARE_ACCOUNT_ID" \
    WRANGLER_SEND_METRICS=false npx wrangler deploy --assets "$SITE_DIR")
}

# One generation a save (central/src/state/snapshot.ts): the members this cycle changed, in one new segment, then the
# manifest; older generations past the newest of the newest STATE_KEEP runs, and segments none of those references,
# are deleted. The parked rarity sample, the retired onboarding documents and watch specs, the day's shared docs page
# cache and the retired classifier's cache stay out (state/layout.ts); a month of the usage and timeline logs moves to
# an archive member once it is over. Then the technologies the cycle restored (docs stores, records, release notes)
# are removed from the store (`--evict`; the next cycle restores what it works again), and the site, deployed or not,
# is gone before the save writes its segment: at 20,000 technologies the disk holds one cycle's work, not the run's.
save_state() {
  local gen report
  rm -rf "$SITE_DIR"
  gen="state-$(date -u +%Y%m%dT%H%M%SZ)-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  report="$(npm --prefix central run -s state -- save --generation "$gen" --keep "$STATE_KEEP" --evict)"
  log "saved $gen: $(jq -c '{written, written_bytes, uploaded_bytes, cold, evicted, compacted_bytes, segments, total_bytes, rotated, deleted: (.deleted | length)}' <<< "$report")"
  log "disk: $(df -h "$UNSTALE_STORE" | awk 'NR == 2 {print $3 " used, " $4 " free"}')"
}

# The gateway starts no early run while this run pulls; tell it when the run is done (best effort: it stops waiting
# on its own 15 minutes after the last announced pull).
continuing=false
finish() {
  [ "$continuing" = true ] || "${drain_env[@]}" npm --prefix central run -s drain -- idle || true
}
trap finish EXIT

cycles=true
[ "$DEPLOY" = true ] || cycles=false
[ "$PIPELINE_OK" = true ] || echo "::warning title=Pipeline failed::The catalog technologies were not refreshed; the drain's cycles publish as usual."
start="$(date +%s)"
end=$((start + RUN_MINUTES * 60))
cycle=0
while :; do
  cycle=$((cycle + 1))
  left=$(((end - $(date +%s)) / 60))
  minutes=$left
  [ "$cycles" = true ] && [ "$CYCLE_MINUTES" -lt "$left" ] && minutes=$CYCLE_MINUTES
  [ "$minutes" -ge 1 ] || minutes=1
  # Early publish only between cycles: a single cycle (DEPLOY=false) works its whole window.
  early=()
  [ "$cycles" = true ] && early=(--early-minutes "$EARLY_MINUTES" --early-grace-minutes "$EARLY_GRACE_MINUTES")
  echo "::group::Cycle $cycle: drain up to $minutes min"
  log "cycle $cycle: drain up to $minutes min"
  set +e
  "${drain_env[@]}" npm --prefix central run -s drain -- --minutes "$minutes" --grace-minutes "$GRACE_MINUTES" \
    --pull-minutes "$PULL_MINUTES" --concurrency "$CONCURRENCY" --taken "$TAKEN" ${early[@]+"${early[@]}"} | tee "$RUNNER_TEMP/drain.log"
  status=$?
  set -e
  echo "::endgroup::"
  if [ "$status" -ne 0 ]; then
    echo "::error title=Drain failed::cycle $cycle exited $status; saving the state"
    save_state
    exit 1
  fi
  line="$(tail -n 1 "$RUNNER_TEMP/drain.log")"
  log "cycle $cycle drained: $(jq -c '{wall_s, pulled, taken, started, unfinished, drained, early, held, rate_limited, metrics}' <<< "$line")"
  echo "::group::Cycle $cycle: publish"
  ok=true
  publish_tree || ok=false
  if [ "$ok" = true ] && [ "$DEPLOY" = true ]; then deploy || ok=false; fi
  save_state
  if [ "$ok" != true ]; then echo "::endgroup::"; echo "::error title=Publish failed::cycle $cycle; state saved, nothing acknowledged"; exit 1; fi
  # The gateway stops holding what this cycle took: their status is deployed and the jobs are in the saved state.
  [ "$DEPLOY" = true ] && "${drain_env[@]}" npm --prefix central run -s drain -- ack "$TAKEN"
  echo "::endgroup::"
  log "cycle $cycle published"
  [ "$cycles" = true ] || break
  # Nothing more could start (queue empty, or the budget spent): the run is done; new registrations start an early run.
  jq -e '.drained or .held != null' <<< "$line" > /dev/null && break
  # Work is left. Another cycle while at least a few minutes of the window remain; else the next run continues it.
  if [ $((end - $(date +%s))) -lt 180 ]; then
    continuing=true
    break
  fi
done

if [ "$continuing" = true ]; then
  log "work left at the end of the window: the next run starts at once (the workflow's continue job)"
  echo "continue=true" >> "$GITHUB_OUTPUT"
fi
