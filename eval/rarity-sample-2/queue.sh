#!/bin/sh
# Queue and score one variant's catalog with the harness queue (rarity_queue.py) and the v2 match results.
#   queue.sh <scratch> <variant> dev|heldout
# Needs <scratch>/cat-<variant> (variants.mts publish) and BASE_WORK, a run_replay work dir holding the v2 match
# results for every event (the expanded replay's w2n). The work dir is an APFS clone of it.
set -eu
S=$1 V=$2 SPLIT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
DEV="workout-next16 invoicerr-prisma7 invoicerr-nest12 aksel-next16 payloadplugins-next16 cedar-prisma7 zodgen-prisma7 temporal-nest12 coros-nest12"
HELD="chmonitor-next16 coh2stats-next16 sigle-prisma7 jsontypes-prisma7 satisfactory-nest12 eudiplo-nest12"
if [ "$SPLIT" = dev ]; then EVS=$DEV; else EVS=$HELD; fi
W=$S/w-$V; [ -d "$W" ] || cp -cR "$BASE_WORK" "$W"
MODE=sample; [ "$V" = fallback ] && MODE=fallback
python3 "$HERE/../rarity-sample/rarity_queue.py" --catalog "$S/cat-$V" --work "$W" --weights $MODE $EVS >"$S/queue-$V-$SPLIT.log"
python3 "$HERE/../replay/run_replay.py" --catalog "$S/cat-$V" --work "$W" --out "$S/metrics-$V-$SPLIT.json" metrics $EVS
python3 - "$S/metrics-$V-$SPLIT.json" "$V" "$SPLIT" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
t = lambda c, o: sum(r["classes"][c]["first16"][o] for r in rows.values())
print("%s %s: tier req %d all %d | usage req %d all %d | covered req %d" % (sys.argv[2], sys.argv[3], t("required", "tier"), t("all", "tier"),
      t("required", "usage"), t("all", "usage"), sum(r["classes"]["required"]["covered"] for r in rows.values())))
PY
