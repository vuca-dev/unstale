#!/usr/bin/env bash
# Release gate: the expanded replay (15 events) scored on the shipped CLI's upgrade-review order.
#
#   eval/gate/run_gate.sh <catalog-dir> <label>
#
# Writes eval/gate/results/<label>.json (raw per-event scores) and <label>.md (tables; deltas against
# results/baseline.json when it exists). Rerunning is cheap: CLI queues are redone only for a new binary, Codex calls
# are cached by request hash ($GATE_CACHE, default ~/.cache/unstale-gate).
#
# Environment:
#   UNSTALE_BIN        CLI binary to measure (default: build local/cli from this working tree into the work dir)
#   GATE_WORK          work dir (default ${TMPDIR:-/tmp}/unstale-gate/<label>)
#   REPLAY_EVENTS_SRC  dir with full clones of the 12 new events (<owner>__<repo>); missing ones are cloned from GitHub
#   GATE_K=3 GATE_JOBS=5 GATE_ARMS=tier,all
#   GATE_K=0           order only: the CLI's queue scored for key changes in it and in the first batch, with no
#                      review calls and no model calls when the match maps are reused (minutes; for ranking changes)
#   GATE_REUSE_MATCH   match maps to reuse when the event's window catalog is identical (default eval/gate/match)
#
# Model calls: per event 2 match calls (only when the catalog's window differs from the reused match) and
# K x arms review calls (30 x 3 = 90 for the default). Codex only (gpt-5.6-luna through `codex exec`).
set -euo pipefail
# No background `git gc` in the event snapshots: an auto-gc repacking objects while they are copied fails the copy.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=gc.auto GIT_CONFIG_VALUE_0=0
[ $# -eq 2 ] || { echo "usage: $0 <catalog-dir> <label>" >&2; exit 2; }
CATALOG=$(cd "$1" && pwd)
LABEL=$2
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=${GATE_WORK:-${TMPDIR:-/tmp}/unstale-gate/$LABEL}
K=${GATE_K:-3}
JOBS=${GATE_JOBS:-5}
ARMS=${GATE_ARMS:-tier,all}
REUSE=${GATE_REUSE_MATCH:-$HERE/match}
mkdir -p "$WORK" "$HERE/results"

# 1. A frozen copy of the catalog, so a rebuild cannot change the run midway.
if [ ! -d "$WORK/catalog" ]; then cp -cR "$CATALOG" "$WORK/catalog" 2>/dev/null || cp -R "$CATALOG" "$WORK/catalog"; fi

# 2. The CLI under test.
if [ -z "${UNSTALE_BIN:-}" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
  (cd "$ROOT/local" && CARGO_TARGET_DIR="$WORK/target" cargo build --release -q -p unstale)
  UNSTALE_BIN="$WORK/target/release/unstale"
fi
echo "gate: $LABEL  catalog $CATALOG  cli $UNSTALE_BIN ($("$UNSTALE_BIN" --version))  work $WORK"

# 3. Event clones and the replay's work dir (answer keys, snapshots at P, usage corpus).
SRC=${REPLAY_EVENTS_SRC:-$WORK/clones}
mkdir -p "$SRC"
python3 - "$ROOT/eval/replay/events/events.json" "$SRC" <<'EOF'
import json, os, subprocess, sys
events, src = json.load(open(sys.argv[1])), sys.argv[2]
for ev, x in events.items():
    d = os.path.join(src, x["slot"])
    if not os.path.exists(d):
        subprocess.run(["git", "clone", "-q", "https://github.com/%s" % x["repo"], d], check=True)
EOF
EVENTS=$(python3 -c "import json,sys; print(' '.join(['workout-next16','invoicerr-prisma7','invoicerr-nest12']+list(json.load(open(sys.argv[1])))))" "$ROOT/eval/replay/events/events.json")
(cd "$ROOT/eval/replay" && python3 run_replay.py --catalog "$WORK/catalog" --work "$WORK" --set all --events-src "$SRC" setup)

# 4. The harness queue (for the agreement report only) and the CLI's queue.
G="python3 $HERE/gate.py --catalog $WORK/catalog --work $WORK --bin $UNSTALE_BIN --k $K --arms $ARMS --jobs $JOBS"
$G cliqueue
if [ "$K" != 0 ]; then
  (cd "$ROOT/eval/rarity-sample" && python3 rarity_queue.py --catalog "$WORK/catalog" --work "$WORK" --weights fallback $EVENTS) > "$WORK/harness-queue.log"
  $G agree --out "$WORK/gate_agree.json"
  cp "$WORK/gate_agree.json" "$HERE/results/$LABEL.agree.json"
fi

# 5. Match (reused when identical), reviews, score.
$G --reuse-match "$REUSE" match
[ "$K" = 0 ] || $G review
$G score --out "$HERE/results/$LABEL.json"
BASE=()
if [ -f "$HERE/results/baseline.json" ] && [ "$LABEL" != baseline ]; then BASE=(--baseline "$HERE/results/baseline.json"); fi
python3 "$HERE/score.py" "$HERE/results/$LABEL.json" ${BASE[@]+"${BASE[@]}"} --json "$HERE/results/$LABEL.summary.json" | tee "$HERE/results/$LABEL.md"
python3 - "$WORK/gate-usage.jsonl" <<'EOF'
import json, sys, os
p = sys.argv[1]
rows = [json.loads(l) for l in open(p)] if os.path.exists(p) else []
new = [r for r in rows if not r.get("cached")]
print("codex calls: %d new (%d failed), %d cache hits; new input tokens %s" % (
    len(new), sum(1 for r in new if r.get("failed")), len(rows) - len(new), "{:,}".format(sum((r.get("usage") or {}).get("input_tokens", 0) for r in new))))
EOF
