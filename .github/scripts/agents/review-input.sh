#!/usr/bin/env bash
# The findings a review round answers (agents.yml, gate job, review event), from trusted authors only:
#   - the review bots' top-level inline comments on the PR that have no reply carrying the handled marker (every reply
#     the publish job posts carries it, so a comment is answered once);
#   - the owner's comments (inline or on the PR) without the marker, newer than the branch's last commit.
# Anyone else's comments never reach the agent. Also counts the rounds already pushed (commits with an `Agent-Round:`
# trailer) so the loop stops at ROUND_MAX.
#
#   review-input.sh <pr number> <out file>      writes count, round to $GITHUB_OUTPUT
# Environment: GH_TOKEN (read), GITHUB_REPOSITORY, AGENT_OWNER, REVIEW_BOTS (space separated logins).
set -euo pipefail
pr="$1" file="$2"
repo="$GITHUB_REPOSITORY"
marker='<!-- agent:handled -->'
bots=$(jq -cn --arg b "$REVIEW_BOTS" '$b | split(" ") | map(select(. != ""))')

inline=$(gh api --paginate "repos/$repo/pulls/$pr/comments" | jq -s 'add // []')
issue=$(gh api --paginate "repos/$repo/issues/$pr/comments" | jq -s 'add // []')
last_commit=$(gh api "repos/$repo/pulls/$pr/commits" --paginate --jq '.[-1].commit.committer.date' | tail -1)

jq -n --argjson inline "$inline" --argjson issue "$issue" --argjson bots "$bots" \
  --arg owner "$AGENT_OWNER" --arg marker "$marker" --arg since "$last_commit" '
  ($inline | map(select(.in_reply_to_id != null and (.body | contains($marker))) | .in_reply_to_id)) as $handled
  | [ ($inline[] | select(.in_reply_to_id == null and (.user.login as $u | $bots | index($u)) and ((.id as $i | $handled | index($i)) | not))
        | {id, kind: "inline", author: .user.login, path, line: (.line // .original_line), body}),
      ($inline[] | select(.user.login == $owner and (.body | contains($marker) | not) and .created_at > $since)
        | {id, kind: "inline", author: .user.login, path, line: (.line // .original_line), body}),
      ($issue[] | select(.user.login == $owner and (.body | contains($marker) | not) and .created_at > $since)
        | {id, kind: "issue", author: .user.login, body}) ]' > "$file"

count=$(jq length "$file")
round=$(gh api "repos/$repo/pulls/$pr/commits" --paginate --jq '.[].commit.message' | grep -c '^Agent-Round:' || true)
echo "count=$count" >> "$GITHUB_OUTPUT"
echo "round=$((round + 1))" >> "$GITHUB_OUTPUT"
echo "PR #$pr: $count findings to answer, round $((round + 1))"
