#!/bin/bash
# One cell of the port parity run (PREREGISTRATION.md): the client's `run-step` over one input file, on a real route.
#
#   run_cell.sh NAME STEP INPUT.jsonl SHARDS PROVIDER [extra run-step flags]
#
# Each shard runs in its own temporary home, config and cache directory under out/cells/NAME/, so nothing touches the
# user's own cache or config, and a rerun resumes from the cached answers without paying twice. The monthly token
# limit is set high in the temporary config. Keys: one variable from each key file central's code names, passed to
# the client process only and never printed. Output: out/cells/NAME.out.jsonl (input order) and NAME.usage.jsonl.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=$1 STEP=$2 INPUT=$3 SHARDS=$4 PROVIDER=$5
shift 5
BIN="${UNSTALE_BIN:-$HERE/../../local/target/release/unstale}"
KEYS="${EDGE_PORT_KEY_DIR:-$HOME/.config/ati}"
CELL="$HERE/out/cells/$NAME"
mkdir -p "$CELL"
key() { { grep -E "^(export )?$2=" "$KEYS/$1" 2>/dev/null || true; } | tail -1 | sed -E "s/^(export )?$2=//; s/^[\"']//; s/[\"']\$//"; }
GATEWAY_KEY=""; JEV_KEY=""
case "$PROVIDER" in
  vercel) GATEWAY_KEY="$(key vercel.env AI_GATEWAY_API_KEY)"; [ -n "$GATEWAY_KEY" ] || { echo "$NAME: no gateway key: cell not run"; exit 3; } ;;
  jev) JEV_KEY="$(key jev.env JEV_API_KEY)"; [ -n "$JEV_KEY" ] || { echo "$NAME: no labelling-service key: cell not run"; exit 3; } ;;
  codex) command -v codex >/dev/null && codex login status >/dev/null 2>&1 || { echo "$NAME: Codex is not logged in: cell not run"; exit 3; } ;;
esac
balance() { [ -n "$GATEWAY_KEY" ] && curl -s -m 20 -H "Authorization: Bearer $GATEWAY_KEY" https://ai-gateway.vercel.sh/v1/credits | python3 -c 'import sys,json; print(json.load(sys.stdin).get("balance"))' 2>/dev/null || echo null; }
BEFORE=$(balance)
# Shards: line i goes to shard i mod SHARDS; outputs are merged back in input order.
python3 - "$INPUT" "$CELL" "$SHARDS" <<'E'
import sys
src, cell, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
lines = [l for l in open(src) if l.strip()]
for s in range(n):
    open("%s/in.%d.jsonl" % (cell, s), "w").writelines(lines[s::n])
E
START=$(date +%s)
pids=()
for s in $(seq 0 $((SHARDS - 1))); do
  D="$CELL/shard$s"
  mkdir -p "$D/home" "$D/config" "$D/work"
  echo '{"monthly_token_limit": 2000000000}' > "$D/config/config.json"
  (
    cd "$D/work"
    if [ "$PROVIDER" = codex ]; then
      # Codex reads its own login from the user's home; everything of unstale's stays in the temporary directories.
      env UNSTALE_CACHE_DIR="$D/cache" UNSTALE_CONFIG_DIR="$D/config" UNSTALE_EDGE_INFERENCE=1 \
        "$BIN" internal run-step --step "$STEP" --in "$CELL/in.$s.jsonl" --provider codex "$@" > "$CELL/out.$s.jsonl" 2> "$CELL/err.$s.txt"
    else
      env -i PATH=/usr/bin:/bin HOME="$D/home" UNSTALE_CACHE_DIR="$D/cache" UNSTALE_CONFIG_DIR="$D/config" UNSTALE_EDGE_INFERENCE=1 \
        AI_GATEWAY_API_KEY="$GATEWAY_KEY" JEV_API_KEY="$JEV_KEY" \
        "$BIN" internal run-step --step "$STEP" --in "$CELL/in.$s.jsonl" --provider "$PROVIDER" "$@" > "$CELL/out.$s.jsonl" 2> "$CELL/err.$s.txt"
    fi
  ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
END=$(date +%s)
AFTER=$(balance)
python3 - "$CELL" "$SHARDS" "$HERE/out/cells/$NAME" "$BEFORE" "$AFTER" "$((END - START))" <<'E'
import glob, json, sys
cell, n, dest, before, after, wall = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], int(sys.argv[6])
outs = [[l for l in open("%s/out.%d.jsonl" % (cell, s)) if l.strip()] for s in range(n)]
ins = [sum(1 for l in open("%s/in.%d.jsonl" % (cell, s)) if l.strip()) for s in range(n)]
merged = []
for i in range(max(ins)):
    for s in range(n):
        if i < len(outs[s]):
            merged.append(outs[s][i])
open(dest + ".out.jsonl", "w").writelines(merged)
usage = [json.loads(l) for f in sorted(glob.glob(cell + "/shard*/cache/inference/usage-*.jsonl")) for l in open(f) if l.strip()]
open(dest + ".usage.jsonl", "w").writelines(json.dumps(u) + "\n" for u in usage)
num = lambda k: sum(int(u.get(k) or 0) for u in usage)
deferred = [json.loads(l).get("deferred") for l in merged if '"deferred"' in l and "deferred" in json.loads(l)]
summary = {"cell": dest.rsplit("/", 1)[1], "items_in": sum(ins), "lines_out": len(merged), "complete": [len(o) for o in outs] == ins and not deferred, "deferred": deferred[:3],
           "calls": len(usage), "input": num("input"), "cached": num("cached"), "output": num("output"), "reasoning": num("reasoning"), "wall_s": wall,
           "gateway_balance_before": None if before == "null" else float(before), "gateway_balance_after": None if after == "null" else float(after)}
json.dump(summary, open(dest + ".summary.json", "w"), indent=1)
print(json.dumps(summary))
E
