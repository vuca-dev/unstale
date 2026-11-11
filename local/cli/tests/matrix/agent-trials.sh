#!/bin/sh
# Opt-in: a few real agent runs that install unstale in a sandbox repository, to see whether the agent asks the user
# which model provider to use rather than choosing one. Each run is billed to the agent's own plan, so nothing runs
# unless UNSTALE_AGENT_TRIALS=1. Never run by `cargo test` or CI.
#
#   UNSTALE_AGENT_TRIALS=1 AGENT=claude RUNS=3 local/cli/tests/matrix/agent-trials.sh
#   UNSTALE_AGENT_TRIALS=1 AGENT=codex  RUNS=3 local/cli/tests/matrix/agent-trials.sh
#
# A run passes when the agent ends without a provider recorded in .unstale/config.json and its last message names
# the options for the user to choose from. Transcripts are kept under the printed directory.
set -eu

if [ "${UNSTALE_AGENT_TRIALS:-}" != "1" ]; then
  echo "agent trials are billed to the agent's plan; set UNSTALE_AGENT_TRIALS=1 to run them" >&2
  exit 2
fi
AGENT="${AGENT:-claude}"
RUNS="${RUNS:-3}"
command -v "$AGENT" >/dev/null || { echo "$AGENT is not on PATH" >&2; exit 2; }

here="$(cd "$(dirname "$0")/../../.." && pwd)"
cargo build --manifest-path "$here/Cargo.toml" --bin unstale -q
out="$(mktemp -d)"
echo "transcripts: $out"

PROMPT='Install unstale in this repository (the `unstale` command is on PATH) and finish setting it up.'
pass=0
i=1
while [ "$i" -le "$RUNS" ]; do
  box="$out/run-$i"
  mkdir -p "$box/repo" "$box/bin"
  ln -s "$here/target/debug/unstale" "$box/bin/unstale"
  cd "$box/repo"
  git init -q
  printf '{"name":"shop","private":true,"dependencies":{"next":"^16.0.0"}}\n' > package.json
  # A key name for detection to find; the value is not a key.
  printf 'OPENAI_API_KEY=not-a-real-key\n' > .env
  export PATH="$box/bin:$PATH" UNSTALE_EDGE_INFERENCE=1 UNSTALE_NO_REGISTRY=1 UNSTALE_SERVICE=http://127.0.0.1:9
  case "$AGENT" in
    claude) claude -p "$PROMPT" --allowedTools "Bash(unstale:*)" > "$box/transcript.txt" 2>&1 || true ;;
    codex) codex exec --skip-git-repo-check -s workspace-write "$PROMPT" > "$box/transcript.txt" 2>&1 || true ;;
    *) echo "AGENT is claude or codex" >&2; exit 2 ;;
  esac
  if grep -q '"inference"' .unstale/config.json 2>/dev/null; then
    echo "run $i: FAIL, the agent recorded a provider: $(grep -A3 '"inference"' .unstale/config.json | tr -d '\n ')"
  elif grep -qi 'codex plan\|openai\|none' "$box/transcript.txt"; then
    echo "run $i: pass, no provider recorded and the options were shown"
    pass=$((pass + 1))
  else
    echo "run $i: unclear, no provider recorded but no options shown; read $box/transcript.txt"
  fi
  cd "$out"
  i=$((i + 1))
done
echo "$pass of $RUNS runs asked the user"
