#!/usr/bin/env bash
# The bump digest of both dogfood repositories against a catalog, on copies (the repositories are never written).
#   eval/advisories/digest.sh <catalog dir> <out dir> [unstale binary]
set -euo pipefail
CATALOG="$1"; OUT="$2"; BIN="${3:-unstale}"
E2E="${DOGFOOD_E2E:-$HOME/ati-slice0/e2e}"
export PATH="$HOME/.cargo/bin:$PATH" UNSTALE_TODAY="${UNSTALE_TODAY:-2026-10-15}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/unstale-adv.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
for NAME in next-prisma-app nest-prisma-api; do
  cp -cR "$E2E/$NAME/repo" "$WORK/$NAME"
  export UNSTALE_CACHE_DIR="$WORK/cache-$NAME"
  (cd "$WORK/$NAME" && "$BIN" init --catalog "$CATALOG" --yes >/dev/null && "$BIN" sync >/dev/null && "$BIN" digest) > "$OUT/$NAME.txt" 2>&1
  echo "$NAME: $(wc -l < "$OUT/$NAME.txt" | tr -d ' ') lines"
done
