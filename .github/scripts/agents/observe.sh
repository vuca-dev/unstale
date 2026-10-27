#!/usr/bin/env bash
# The week's observations for a weekly lane (agents.yml, gate job), collected before any model runs so the agent never
# holds the Cloudflare token: run conclusions, failed steps, the ingest runs' Usage output and step durations, and the
# gateway's analytics. Everything here is already printed in this public repository's Actions logs; each file is
# capped so the bundle stays small in context.
#
#   observe.sh <out dir>
# Environment: GH_TOKEN (actions: read), GITHUB_REPOSITORY, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (optional:
# without them the analytics file says so).
set -uo pipefail
out="$1"
mkdir -p "$out"
since=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
repo="$GITHUB_REPOSITORY"
cap() { tail -c "$1"; }

gh run list --repo "$repo" -L 300 --created ">=$since" \
  --json databaseId,workflowName,conclusion,status,event,createdAt,updatedAt > "$out/runs.json" || echo '[]' > "$out/runs.json"
jq -r 'group_by(.workflowName)[] | "\(.[0].workflowName): " + (group_by(.conclusion) | map("\(if (.[0].conclusion // "") == "" then "running" else .[0].conclusion end) \(length)") | join(", "))' \
  "$out/runs.json" > "$out/runs-summary.txt"
echo "since $since" >> "$out/runs-summary.txt"

# Failed runs, newest 10: the failed steps' last lines.
for id in $(jq -r '[.[] | select(.conclusion == "failure")] | .[0:10][] | .databaseId' "$out/runs.json"); do
  gh run view "$id" --repo "$repo" --log-failed 2>/dev/null | cap 20000 > "$out/failed-$id.log"
done

# Ingest runs that finished, newest 5: the Usage step's output and every step's duration.
for id in $(jq -r '[.[] | select(.workflowName == "ingest" and (.conclusion == "success" or .conclusion == "failure"))] | .[0:5][] | .databaseId' "$out/runs.json"); do
  gh api "repos/$repo/actions/runs/$id/jobs" --jq '.jobs[] | .name as $j | .steps[] | select(.started_at and .completed_at)
    | "\($j)\t\(.name)\t\(.conclusion)\t\(((.completed_at | fromdate) - (.started_at | fromdate)) / 60 | floor)m"' \
    > "$out/steps-$id.txt" 2>/dev/null
  job=$(gh api "repos/$repo/actions/runs/$id/jobs" --jq '.jobs[] | select(.name == "ingest") | .id' 2>/dev/null | head -1)
  [ -n "$job" ] && gh run view "$id" --repo "$repo" --job "$job" --log 2>/dev/null \
    | awk -F'\t' '$2 == "Usage" { sub(/^[0-9T:.Z-]+ /, "", $3); print $3 }' | cap 24000 > "$out/usage-$id.txt"
done

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  node gateway/scripts/diagnostics.ts analytics --hours 168 2>&1 | cap 30000 > "$out/gateway-analytics.txt"
else
  echo "unavailable: no Cloudflare credentials in this run" > "$out/gateway-analytics.txt"
fi
find "$out" -type f -empty -delete
ls -la "$out"
