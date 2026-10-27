#!/usr/bin/env bash
# Whether a weekly lane runs (agents.yml, gate job), decided without a model:
#   - never while the lane has an open PR (label agent:<lane>): one at a time, so they do not pile up;
#   - FORCE=true runs it otherwise;
#   - else it runs when its paths changed since the commit its last run reviewed (state.json on the agent-memory
#     branch), and for qa also when the week's observations show failed runs or Worker errors.
# A lane with no recorded run always runs.
#
#   gate.sh <lane> <observations dir>     writes run, base, reason to $GITHUB_OUTPUT
# Environment: GH_TOKEN (read), GITHUB_REPOSITORY, FORCE.
set -euo pipefail
lane="$1" obs="$2"

out() { echo "$1=$2" >> "$GITHUB_OUTPUT"; }
head_sha=$(git rev-parse HEAD)
out head "$head_sha"

decide() { out run "$1"; out reason "$2"; echo "$lane: run=$1 ($2)"; exit 0; }

open=$(gh pr list --repo "$GITHUB_REPOSITORY" --label "agent:$lane" --state open --json number --jq 'length')
[ "$open" = "0" ] || decide false "an agent:$lane PR is still open"
[ "${FORCE:-false}" = "true" ] && decide true "forced"

base=""
if git fetch -q --depth=1 origin agent-memory 2>/dev/null; then
  base=$(git show FETCH_HEAD:state.json 2>/dev/null | jq -r --arg l "$lane" '.[$l].sha // empty' || true)
fi
[ -n "$base" ] || decide true "no previous run recorded"
out base "$base"
git cat-file -e "$base^{commit}" 2>/dev/null || decide true "last reviewed commit $base not found"

case "$lane" in
  security) paths=(local central gateway npm schema scripts .github) ;;
  performance) paths=(local central gateway) ;;
  cost) paths=(central gateway local eval/select) ;;
  qa) paths=(local central gateway .github) ;;
  *) echo "unknown lane $lane" >&2; exit 1 ;;
esac
changed=$(git diff --name-only "$base" "$head_sha" -- "${paths[@]}" | wc -l | tr -d ' ')
[ "$changed" = "0" ] || decide true "$changed files changed under ${paths[*]} since ${base:0:7}"

if [ "$lane" = "qa" ]; then
  failed=$(ls "$obs"/failed-*.log 2>/dev/null | wc -l | tr -d ' ')
  [ "$failed" = "0" ] || decide true "$failed failed runs this week"
  # Invocation statuses other than success and client disconnects (diagnostics.ts prints one row per hour and status).
  if grep -q -E ' (scriptThrewException|exceededResources|exceededCpu|exceededMemory|internalError|responseStreamDisconnected)\b' "$obs/gateway-analytics.txt" 2>/dev/null; then
    decide true "Worker errors in the week's analytics"
  fi
fi
decide false "nothing changed since ${base:0:7}"
