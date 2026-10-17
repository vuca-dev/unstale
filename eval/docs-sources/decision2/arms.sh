#!/bin/zsh
# Runs decision 2 arms in sequence, each on a fresh clone of a store with a fixed Next.js baseline.
#   eval/docs-sources/decision2/arms.sh <store> <baseline-records.json> <replay.json> <out-dir> <name>:"<arm flags>" ...
# <store> holds central/ and catalog/ (a copy of .store); <baseline-records.json> is records/next.json before any arm.
# Each arm writes <out-dir>/<name>/{central,catalog,t0,log}; arms_report.py and lineage-pairs.mts read them.
set -u
STORE=$1 BASE=$2 REPLAY=$3 OUT=$4; shift 4
HERE=${0:A:h}
mkdir -p $OUT
for spec in "$@"; do
  name=${spec%%:*}; flags=${spec#*:}
  C=$OUT/$name; rm -rf $C; mkdir -p $C
  cp -cR $STORE/central $STORE/catalog $C/
  cp $BASE $C/central/records/next.json
  date -u +%Y-%m-%dT%H:%M:%S > $C/t0
  (cd $HERE/../../../central && UNSTALE_CENTRAL_DIR=$C/central UNSTALE_CATALOG_DIR=$C/catalog npx tsx $HERE/arm.mts $REPLAY ${=flags} --run > $C/log 2>&1)
  echo "$(date -u +%TZ) $name exit=$?" >> $OUT/summary.txt
done
