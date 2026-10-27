#!/usr/bin/env bash
# The publish job of agents.yml: the only step that holds the owner's token (AGENT_GH_TOKEN), and it runs no model and
# no code from the agent's branch. It takes the agent job's outputs ($OUT) as data:
#   patches/*.patch  applied with `git am` (hooks off); refused if any touches .github/, .claude/, CLAUDE.md,
#                    .gitattributes, .gitmodules or adds a symlink, or if any output contains a secret the agent job held;
#   pr.json          new run: the branch agent/<lane>/<date> is pushed and the PR opened (labels agent:<lane>, and
#                    needs-gate when the agent says the release gate must be run locally);
#   replies.json     review round: the fix commits are pushed (the last one gets `Agent-Round: <n>`), and each reply
#                    is posted to a comment of that round's review.json, with the handled marker;
#   comment.md       optional PR comment;
#   memory/<lane>.md the lane's log, pruned (prune.mjs) and pushed to the agent-memory branch with the lane's last
#                    reviewed commit (state.json; new runs only).
#
# Environment: GH_TOKEN (AGENT_GH_TOKEN), GITHUB_REPOSITORY, MODE (new|round), LANE, OUT, WORK (checkout of the base or
# PR branch), TRUSTED (this directory, from main), HEAD_SHA (new), PR and ROUND and REVIEW_FILE (round), SCAN_* (secret
# values to refuse).
set -euo pipefail
: "${GH_TOKEN:?AGENT_GH_TOKEN is not set: see agents.yml}"
repo="$GITHUB_REPOSITORY"
marker='<!-- agent:handled -->'
today=$(date -u +%Y-%m-%d)
remote="https://x-access-token:${GH_TOKEN}@github.com/${repo}.git"
git_() { git -c core.hooksPath=/dev/null -c user.name="unstale agents" -c user.email="agents@users.noreply.github.com" "$@"; }

# Secrets the agent job held must not leave in any output.
for var in $(compgen -e | grep '^SCAN_' || true); do
  val="${!var}"
  [ ${#val} -ge 12 ] || continue
  if grep -rqF -- "$val" "$OUT"; then echo "refused: an output contains the value of ${var#SCAN_}" >&2; exit 1; fi
done

cd "$WORK"
start=$(git rev-parse HEAD)
shopt -s nullglob
patches=("$OUT"/patches/*.patch)
if [ ${#patches[@]} -gt 0 ]; then
  git_ am --keep-cr "${patches[@]}"
  bad=$(git diff --name-only "$start" HEAD | grep -E '^\.github/|(^|/)\.claude/|(^|/)CLAUDE\.md$|(^|/)\.git(attributes|modules)$' || true)
  [ -z "$bad" ] || { echo "refused: the agent changed protected paths:"; echo "$bad"; exit 1; } >&2
  ! git diff --summary "$start" HEAD | grep -q 'mode 120000' || { echo "refused: the agent added a symlink" >&2; exit 1; }
fi
changed=$([ "$(git rev-parse HEAD)" != "$start" ] && echo true || echo false)
# Commits without PR text are a failed run, not a decision: recording it as reviewed would skip the lane next week.
if [ "$MODE" = "new" ] && [ "$changed" = "true" ] && [ ! -f "$OUT/pr.json" ]; then
  echo "refused: the agent committed changes but wrote no pr.json" >&2; exit 1
fi
# Capped inside jq or by reading a bounded prefix: `jq ... | head -c` would fail the step under pipefail once jq is cut
# off, and the outputs are model-written, so none is held whole.

pr_number=""
if [ "$MODE" = "new" ] && [ "$changed" = "true" ] && [ -f "$OUT/pr.json" ]; then
  title=$(jq -r '.title // "" | .[0:120]' "$OUT/pr.json")
  [ -n "$title" ] || { echo "refused: pr.json has no title" >&2; exit 1; }
  body=$(jq -r '.body // "" | .[0:60000]' "$OUT/pr.json")
  gate=$(jq -r '.needs_local_gate // false' "$OUT/pr.json")
  branch="agent/$LANE/$today-$GITHUB_RUN_ID"
  git_ push -q "$remote" "HEAD:refs/heads/$branch"
  gh label create "agent:$LANE" --repo "$repo" --color 5319e7 --description "Weekly $LANE agent" --force >/dev/null
  labels=(--label "agent:$LANE")
  if [ "$gate" = "true" ]; then
    gh label create needs-gate --repo "$repo" --color d93f0b --description "Needs the local release gate" --force >/dev/null
    labels+=(--label needs-gate)
  fi
  footer=$'\n\n---\nOpened by the weekly '"$LANE"$' agent (`.github/workflows/agents.yml`). Review findings from the review bots are answered automatically; merging is left to a maintainer.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'
  url=$(gh pr create --repo "$repo" --base main --head "$branch" --title "$title" --body "$body$footer" "${labels[@]}")
  pr_number="${url##*/}"
  echo "opened $url"
elif [ "$MODE" = "round" ]; then
  pr_number="$PR"
  if [ "$changed" = "true" ]; then
    git_ commit -q --amend --no-edit --trailer "Agent-Round: $ROUND"
    git_ push -q "$remote" "HEAD:refs/heads/$HEAD_REF"
    echo "pushed round $ROUND to $HEAD_REF"
  fi
  if [ -f "$OUT/replies.json" ]; then
    jq -c '.[]' "$OUT/replies.json" | while read -r reply; do
      id=$(jq -r '.id' <<<"$reply")
      kind=$(jq -r --argjson id "$id" '.[] | select(.id == $id) | .kind' "$REVIEW_FILE" 2>/dev/null || true)
      text="$(jq -r '.body // "" | .[0:20000]' <<<"$reply")"$'\n\n'"$marker"
      case "$kind" in
        inline) gh api -X POST "repos/$repo/pulls/$PR/comments/$id/replies" -f body="$text" >/dev/null ;;
        issue) gh api -X POST "repos/$repo/issues/$PR/comments" -f body="Re: comment $id"$'\n\n'"$text" >/dev/null ;;
        *) echo "skipped a reply to $id: not a comment of this round" ;;
      esac
    done
  fi
fi
if [ -n "$pr_number" ] && [ -f "$OUT/comment.md" ]; then
  gh api -X POST "repos/$repo/issues/$pr_number/comments" -f body="$(head -c 20000 "$OUT/comment.md")"$'\n\n'"$marker" >/dev/null
fi

# The lane's log, retried on a concurrent push to the memory branch.
log="$OUT/memory/$LANE.md"
for attempt in 1 2 3; do
  mem=$(mktemp -d)
  if git_ clone -q --depth 1 -b agent-memory "$remote" "$mem" 2>/dev/null; then :; else
    git_ -C "$mem" init -q -b agent-memory && git_ -C "$mem" remote add origin "$remote"
  fi
  cd "$mem"
  [ -f state.json ] || echo '{}' > state.json
  if [ -f "$log" ]; then
    head -c 65536 "$log" > "$LANE.md"
    [ -n "$pr_number" ] && sed -i "s/{{PR}}/#$pr_number/g" "$LANE.md"
    node "$TRUSTED/prune.mjs" "$LANE.md" "$today"
  fi
  if [ "$MODE" = "new" ]; then
    jq --arg l "$LANE" --arg sha "$HEAD_SHA" --arg at "$today" --arg pr "$pr_number" \
      '.[$l] = {sha: $sha, at: $at, pr: (if $pr == "" then null else ($pr | tonumber) end)}' state.json > state.tmp && mv state.tmp state.json
  fi
  git_ add -A
  git_ diff --cached --quiet && { echo "memory unchanged"; break; }
  git_ commit -q -m "$LANE: $MODE run $today"
  if git_ push -q origin HEAD:refs/heads/agent-memory; then echo "memory saved"; break; fi
  cd /; rm -rf "$mem"
  [ "$attempt" = 3 ] && { echo "memory push failed 3 times" >&2; exit 1; }
done
