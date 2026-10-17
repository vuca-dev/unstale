#!/usr/bin/env bash
# Dogfood loop (brief step 4): drive the installed `unstale` CLI and the central catalog commands on fresh copies of
# two end-to-end repositories and check, by machine, that user decisions hold:
#   1. init + run;
#   2. decline / defer / do-now on the current batch, re-run, and check withheld ids are gone and the rest stay;
#   3. decline everything, batch by batch, until both review queues are empty, and check the empty text says why;
#   4. decisions survive real catalog changes made on a COPY of the central store and catalog: a label-only
#      correction (still withheld), a merge (line rewritten to the target, target withheld), a revision-bumping
#      correction (re-opens), a retraction (line deleted).
# Everything runs in a fresh scratch directory; ~/unstale/.store and the source repositories are never written.
#
#   scripts/dogfood.sh                 # both repositories
#   KEEP=1 scripts/dogfood.sh          # keep the scratch directory
#   DOGFOOD_REPOS="next-prisma-app" scripts/dogfood.sh
# Exit status: 0 when every check passes, 1 otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE_SRC="${DOGFOOD_STORE:-$ROOT/.store}"
E2E="${DOGFOOD_E2E:-$HOME/ati-slice0/e2e}"
REPOS="${DOGFOOD_REPOS:-next-prisma-app nest-prisma-api}"
MAX_ROUNDS="${DOGFOOD_MAX_ROUNDS:-20}"
UNSTALE="${UNSTALE_BIN:-unstale}"
export PATH="$HOME/.cargo/bin:$PATH"

command -v "$UNSTALE" >/dev/null || { echo "unstale not found (cargo install --path local/cli)"; exit 1; }
command -v jq >/dev/null || { echo "jq is required"; exit 1; }
[ -f "$STORE_SRC/catalog/v1/root.json" ] || { echo "no catalog at $STORE_SRC/catalog"; exit 1; }
[ -d "$STORE_SRC/central" ] || { echo "no central store at $STORE_SRC/central"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/unstale-dogfood.XXXXXX")"
cleanup() { if [ "${KEEP:-0}" = 1 ]; then echo "scratch kept: $WORK"; else rm -rf "$WORK"; fi; }
trap cleanup EXIT

RESULTS=()
FAILS=0
pass() { RESULTS+=("PASS  $1"); echo "  ✓ PASS $1"; }
fail() { RESULTS+=("FAIL  $1"); FAILS=$((FAILS + 1)); echo "  ✗ FAIL $1"; shift; for d in "$@"; do echo "         $d"; done; }
# check NAME DETAIL... : pass when the (already computed) list of problems is empty.
check() { local name="$1"; shift; if [ "$#" -eq 0 ]; then pass "$name"; else fail "$name" "$@"; fi; }

section() { printf '\n==== %s ====\n' "$*"; }
# Run a command in the repository copy, echo it and its output (indented); OUT holds the output, RC the status.
OUT=""
RC=0
run() {
  echo "\$ $*"
  set +e
  OUT="$( (cd "$REPO" && "$@") 2>&1)"
  RC=$?
  set -e
  [ -n "$OUT" ] && printf '%s\n' "$OUT" | sed 's/^/    /'
  [ "$RC" -eq 0 ] || echo "    (exit $RC)"
  return 0
}
# Same, but without printing the output (long digests); prints the line count instead.
run_quiet() {
  echo "\$ $*"
  set +e
  OUT="$( (cd "$REPO" && "$@") 2>&1)"
  RC=$?
  set -e
  echo "    ($(printf '%s\n' "$OUT" | wc -l | tr -d ' ') lines of output, exit $RC)"
}
catalog() {
  echo "\$ UNSTALE_STORE=\$STORE npm run catalog -- $*"
  set +e
  OUT="$(cd "$ROOT/central" && UNSTALE_STORE="$STORE" npm run --silent catalog -- "$@" 2>&1)"
  RC=$?
  set -e
  [ -n "$OUT" ] && printf '%s\n' "$OUT" | sed 's/^/    /'
  [ "$RC" -eq 0 ] || echo "    (exit $RC)"
  return 0
}

# revision_of ID: `catalog show`, printing only the counters; REV holds the revision.
REV=""
revision_of() {
  echo "\$ UNSTALE_STORE=\$STORE npm run catalog -- show $1   # counters only"
  local j
  j="$(cd "$ROOT/central" && UNSTALE_STORE="$STORE" npm run --silent catalog -- show "$1" 2>&1)"
  REV="$(jq -r .revision <<<"$j")"
  echo "    $(jq -c '{id, status, revision, label_version}' <<<"$j")"
}

UP=".unstale/skills/upgrade-review/SKILL.md"
IM=".unstale/skills/improvements-pass/SKILL.md"
LEDGER=".unstale/ledger.jsonl"
skill() { cat "$REPO/$1" 2>/dev/null || true; }
# Ids in a skill file's current batch (`### [id] rev n`) and its "Marked do now" list (`- [id] …`).
batch_ids() { skill "$1" | sed -n 's/^### \[\([^]]*\)\] rev .*/\1/p'; }
donow_ids() { skill "$1" | sed -n '/^## Marked do now/,/^## /s/^- \[\([^]]*\)\] .*/\1/p'; }
open_ids() { { batch_ids "$UP"; batch_ids "$IM"; } | sort -u; }
ledger_status() { jq -r --arg id "$1" 'select(.id == $id) | .status' "$REPO/$LEDGER" 2>/dev/null | sed -n 1p; }
ledger_ids() { jq -r 'select(.id) | select(.status == "'"$1"'") | .id' "$REPO/$LEDGER"; }
# Does id appear as an id (bracketed in skill files: `[id]`, `[id, version]`) in the given text?
has_id() { grep -qF -- "[$1]" <<<"$2" || grep -qF -- "[$1," <<<"$2"; }
# The text a user and the agent see: both skill files, the digest, and every package's `bump` listing.
visible_text() {
  local t pkgs
  t="$(skill "$UP")"$'\n'"$(skill "$IM")"$'\n'"$(cd "$REPO" && "$UNSTALE" digest 2>&1)"
  pkgs="$(cd "$REPO" && "$UNSTALE" digest 2>&1 | sed -n 's/.*(`unstale bump \([^`]*\)`).*/\1/p')"
  for p in $pkgs; do t+=$'\n'"$(cd "$REPO" && "$UNSTALE" bump "$p" 2>&1)"; done
  printf '%s' "$t"
}
# Problems for: none of the ids may be visible.
absent() { local text="$1"; shift; for id in "$@"; do has_id "$id" "$text" && echo "$id is still shown"; done; return 0; }
present() { local text="$1"; shift; for id in "$@"; do has_id "$id" "$text" || echo "$id is missing"; done; return 0; }
# readarr NAME: read non-empty stdin lines into array NAME (bash 3.2 has no mapfile).
readarr() { local __n="$1" __l; eval "$__n=()"; while IFS= read -r __l; do [ -n "$__l" ] && eval "$__n+=(\"\$__l\")"; done; return 0; }
problems() { readarr P; }

echo "unstale dogfood loop"
echo "unstale: $("$UNSTALE" --version)  ($(command -v "$UNSTALE"))"
echo "central: $ROOT/central (node $(node --version))"
echo "store copied from: $STORE_SRC (never written)"
echo "scratch: $WORK"
echo "repositories: $REPOS"

for NAME in $REPOS; do
  BASE="$WORK/$NAME"
  REPO="$BASE/repo"
  STORE="$BASE/store"
  mkdir -p "$BASE"
  export UNSTALE_CACHE_DIR="$BASE/cache"

  section "$NAME: setup"
  echo "\$ cp -cR $E2E/$NAME/repo \$REPO"
  cp -cR "$E2E/$NAME/repo" "$REPO"
  echo "\$ cp -cR $STORE_SRC/{central,catalog} \$STORE/"
  mkdir -p "$STORE"
  cp -cR "$STORE_SRC/central" "$STORE/central"
  cp -cR "$STORE_SRC/catalog" "$STORE/catalog"
  rm -f "$STORE/central/usage.jsonl"
  echo "UNSTALE_CACHE_DIR=\$WORK/$NAME/cache, catalog=\$STORE/catalog (a copy)"
  # Publish the copied central store once, so later publishes change only what each step changes.
  catalog publish
  check "$NAME: baseline publish of the copied store" $( [ "$RC" -eq 0 ] || echo x)
  if diff -rq "$STORE_SRC/catalog" "$STORE/catalog" >/dev/null; then
    echo "  (baseline publish is byte-identical to $STORE_SRC/catalog)"
  else
    echo "  (note: baseline publish differs from $STORE_SRC/catalog; the copy is used throughout)"
  fi

  section "$NAME: 1. init and run"
  run "$UNSTALE" init --catalog "$STORE/catalog" --yes
  problems < <([ "$RC" -eq 0 ] || echo "init exited $RC")
  check "$NAME: init" "${P[@]+"${P[@]}"}"
  run_quiet "$UNSTALE" run
  printf '%s\n' "$OUT" | grep -v '^  security:' | sed 's/^/    /'
  problems < <([ "$RC" -eq 0 ] || echo "run exited $RC"; [ -f "$REPO/$UP" ] || echo "no $UP"; [ -f "$REPO/$IM" ] || echo "no $IM")
  check "$NAME: run writes both skill files and exits 0" "${P[@]+"${P[@]}"}"

  section "$NAME: 2. decline, defer, do-now on the current batch"
  readarr B < <(batch_ids "$UP")
  readarr IMP < <(batch_ids "$IM")
  echo "upgrade-review batch: ${#B[@]} records; improvements-pass batch: ${#IMP[@]} records"
  # The upgrade-review batch is the one worked on; a repository already at the newest versions has none, and then
  # the improvements-pass batch takes its place.
  PRIMARY="$UP"
  OTHER=("${IMP[@]+"${IMP[@]}"}")
  if [ "${#B[@]}" -lt 6 ]; then
    PRIMARY="$IM"
    readarr OTHER < <(batch_ids "$UP")
    readarr B < <(batch_ids "$IM")
  fi
  echo "working batch: $PRIMARY (${#B[@]} records); declined from the other pass: ${#OTHER[@]}"
  if [ "${#B[@]}" -lt 6 ]; then
    fail "$NAME: a batch with at least 6 records" "upgrade-review and improvements-pass batches are smaller"
    continue
  fi
  DECLINED=("${B[0]}" "${B[1]}" "${B[2]}" "${OTHER[@]+"${OTHER[@]}"}")
  DEFERRED=("${B[3]}")
  DONOW="${B[4]}"
  REMAIN=("${B[@]:5}")
  for id in "${DECLINED[@]}"; do run "$UNSTALE" decide "$id" decline; done
  run "$UNSTALE" decide "${DEFERRED[0]}" later
  run "$UNSTALE" decide "$DONOW" do-now
  run_quiet "$UNSTALE" run
  printf '%s\n' "$OUT" | grep -v '^  security:' | sed 's/^/    /'
  RUN_OUT="$OUT"
  V="$(visible_text)"$'\n'"$RUN_OUT"
  problems < <(absent "$V" "${DECLINED[@]}" "${DEFERRED[@]}")
  check "$NAME: declined (${#DECLINED[@]}) and deferred (1) ids absent from skill files, run/digest and bump output" "${P[@]+"${P[@]}"}"
  problems < <(present "$(skill "$PRIMARY")" "${REMAIN[@]}" "$DONOW")
  check "$NAME: the other ${#REMAIN[@]} records of the batch and the do-now record are still in $PRIMARY" "${P[@]+"${P[@]}"}"
  problems < <(donow_ids "$PRIMARY" | grep -qxF -- "$DONOW" || echo "$DONOW not under 'Marked do now'")
  check "$NAME: do-now record listed under 'Marked do now'" "${P[@]+"${P[@]}"}"
  problems < <(for id in "${DECLINED[@]}"; do [ "$(ledger_status "$id")" = declined ] || echo "$id: ledger says '$(ledger_status "$id")'"; done
               [ "$(ledger_status "${DEFERRED[0]}")" = deferred ] || echo "${DEFERRED[0]}: ledger says '$(ledger_status "${DEFERRED[0]}")'")
  check "$NAME: ledger lines for the declined and deferred records" "${P[@]+"${P[@]}"}"

  section "$NAME: 3. decline everything, batch by batch"
  # The do-now record is not in the queue (it waits under "Marked do now"); it stays, and is the merge target in 4b.
  ALL_DECLINED=("${DECLINED[@]}")
  round=0
  empty=0
  while [ "$round" -lt "$MAX_ROUNDS" ]; do
    round=$((round + 1))
    readarr O < <(open_ids)
    echo "-- round $round: ${#O[@]} open records in the current batches"
    if [ "${#O[@]}" -eq 0 ] && grep -q '^## Nothing to review' "$REPO/$UP" && grep -q '^## Nothing to review' "$REPO/$IM"; then
      empty=1
      break
    fi
    for id in "${O[@]+"${O[@]}"}"; do
      echo "\$ $UNSTALE decide $id decline"
      (cd "$REPO" && "$UNSTALE" decide "$id" decline >/dev/null 2>&1) || fail "$NAME: decide $id decline" "exit $?"
      ALL_DECLINED+=("$id")
    done
    run "$UNSTALE" review --next
    problems < <([ "$RC" -eq 0 ] || echo "review --next exited $RC")
    check "$NAME: round $round: review --next hands out the next batch" "${P[@]+"${P[@]}"}"
    run_quiet "$UNSTALE" run
    printf '%s\n' "$OUT" | grep -v '^  security:' | sed 's/^/    /'
    V="$(visible_text)"$'\n'"$OUT"
    problems < <(absent "$V" "${ALL_DECLINED[@]}" "${DEFERRED[@]}")
    check "$NAME: round $round: ${#ALL_DECLINED[@]} declined + 1 deferred ids absent everywhere" "${P[@]+"${P[@]}"}"
  done
  problems < <([ "$empty" = 1 ] || echo "queues not empty after $MAX_ROUNDS rounds")
  check "$NAME: both review queues empty within $MAX_ROUNDS rounds (took $round)" "${P[@]+"${P[@]}"}"
  run "$UNSTALE" run
  FINAL_RC=$RC
  ND="$(ledger_ids declined | wc -l | tr -d ' ')"
  NF="$(ledger_ids deferred | wc -l | tr -d ' ')"
  echo "ledger: $ND declined, $NF deferred"
  echo "upgrade-review empty text:    $(grep -A2 '^## Nothing to review' "$REPO/$UP" | tail -1)"
  echo "improvements-pass empty text: $(grep -A2 '^## Nothing to review' "$REPO/$IM" | tail -1)"
  WANT="$((ND + NF)) withheld by the ledger ($ND declined, $NF deferred)"
  problems < <([ "$FINAL_RC" -eq 0 ] || echo "run exited $FINAL_RC"
               for f in "$UP" "$IM"; do grep -qF -- "$WANT" "$REPO/$f" || echo "$f does not say '$WANT'"; done
               grep -qF -- "$WANT" <<<"$OUT" || echo "run output does not say '$WANT'")
  check "$NAME: empty result exits 0 and names the withheld counts ('$WANT')" "${P[@]+"${P[@]}"}"

  section "$NAME: 4. decisions through catalog changes (copied store)"
  # Merge target: the do-now record (shown, no ledger line); merged from a declined record of its technology.
  # Three more declined records for the other changes.
  TARGET="$DONOW"
  TECH="${TARGET%%:*}"
  readarr DEC < <(ledger_ids declined)
  A_MERGE="$(printf '%s\n' "${DEC[@]}" | grep "^$TECH:" | sed -n 1p)"
  readarr PICK < <(printf '%s\n' "${DEC[@]}" | grep -vxF -- "$A_MERGE" | sed -n 1,3p)
  A_LABEL="${PICK[0]-}"; A_REV="${PICK[1]-}"; A_RETRACT="${PICK[2]-}"
  echo "label-only=$A_LABEL; merge=$A_MERGE into $TARGET; revision=$A_REV; retract=$A_RETRACT"
  if [ -z "$A_MERGE" ] || [ -z "$A_RETRACT" ]; then
    fail "$NAME: four declined records to change (one of technology $TECH)" "declined: ${#DEC[@]}"
    continue
  fi

  # (a) label-only correction: label_version moves, revision does not, the decline holds.
  revision_of "$A_LABEL"
  REV_BEFORE="$REV"
  catalog correct "$A_LABEL" "summary=Dogfood label-only correction of $A_LABEL." "terms=dogfood-term" --note "dogfood: label only"
  run "$UNSTALE" sync
  run_quiet "$UNSTALE" run
  V="$(visible_text)"$'\n'"$OUT"
  revision_of "$A_LABEL"
  REV_AFTER="$REV"
  problems < <([ "$REV_BEFORE" = "$REV_AFTER" ] || echo "revision moved $REV_BEFORE -> $REV_AFTER"
               [ "$(ledger_status "$A_LABEL")" = declined ] || echo "ledger says '$(ledger_status "$A_LABEL")'"
               absent "$V" "$A_LABEL"
               grep -qF "Dogfood label-only correction" <<<"$V" && echo "corrected summary is shown")
  check "$NAME: 4a label-only correction of $A_LABEL: same revision, still declined and withheld" "${P[@]+"${P[@]}"}"

  # (b) merge A into B: the line is rewritten to B at B's current revision. B is marked do now, so the
  # mark wins: B stays under "Marked do now" with a note naming the ledger line, never silently withheld.
  if [ -n "$TARGET" ]; then
    V="$(visible_text)"
    problems < <(present "$V" "$TARGET"; [ -z "$(ledger_status "$TARGET")" ] || echo "$TARGET already has a ledger line")
    check "$NAME: 4b precondition: merge target $TARGET (marked do now, no ledger line) is shown before the merge" "${P[@]+"${P[@]}"}"
    catalog merge "$A_MERGE" "$TARGET" --note "dogfood: merge"
    revision_of "$TARGET"
    TREV="$REV"
    run "$UNSTALE" sync
    SYNC_OUT="$OUT"
    run_quiet "$UNSTALE" run
    V="$(visible_text)"$'\n'"$OUT"
    echo "\$ jq -c 'select(.id == \"$A_MERGE\" or .id == \"$TARGET\")' $LEDGER"
    jq -c --arg a "$A_MERGE" --arg b "$TARGET" 'select(.id == $a or .id == $b)' "$REPO/$LEDGER" | sed 's/^/    /' 
    problems < <(grep -qF "ledger: $A_MERGE was merged into $TARGET" <<<"$SYNC_OUT" || echo "sync did not report the rewrite"
                 [ -z "$(ledger_status "$A_MERGE")" ] || echo "$A_MERGE still has a ledger line"
                 [ "$(ledger_status "$TARGET")" = declined ] || echo "$TARGET: ledger says '$(ledger_status "$TARGET")'"
                 r="$(jq -r --arg id "$TARGET" 'select(.id == $id) | .rev' "$REPO/$LEDGER")"; [ "$r" = "$TREV" ] || echo "$TARGET line has rev $r, record has $TREV"
                 absent "$V" "$A_MERGE"
                 donow_ids "$PRIMARY" | grep -qxF -- "$TARGET" || echo "$TARGET is not under 'Marked do now' in $PRIMARY"
                 grep -qF "The ledger also has a \`declined\` line for this record" "$REPO/$PRIMARY" || echo "no ledger-line note on $TARGET")
    check "$NAME: 4b merge $A_MERGE into $TARGET: line rewritten to $TARGET (rev $TREV); $A_MERGE withheld; do-now $TARGET still shown with a note" "${P[@]+"${P[@]}"}"
  fi

  # (c) revision-bumping correction (--claim): the decline no longer holds and the record re-opens.
  catalog correct "$A_REV" --claim --note "dogfood: meaningful correction of the claim"
  revision_of "$A_REV"
  RREV="$REV"
  run "$UNSTALE" sync
  run_quiet "$UNSTALE" run
  printf '%s\n' "$OUT" | grep -v '^  security:' | sed 's/^/    /'
  V="$(visible_text)"
  echo "\$ jq -c 'select(.id == \"$A_REV\")' $LEDGER"
  jq -c --arg a "$A_REV" 'select(.id == $a)' "$REPO/$LEDGER" | sed 's/^/    /'
  problems < <(present "$V" "$A_REV"
               r="$(jq -r --arg id "$A_REV" 'select(.id == $id) | .rev' "$REPO/$LEDGER")"; [ "$r" -lt "$RREV" ] || echo "ledger line has rev $r, not below $RREV"
               has_id "$A_REV" "$(skill "$UP")$(skill "$IM")" || echo "$A_REV not in a skill file"
               grep -qF "### [$A_REV] rev $RREV" <<<"$V" || echo "skill file does not show $A_REV at rev $RREV")
  check "$NAME: 4c revision bump of $A_REV (rev $RREV): re-opened, back in the review" "${P[@]+"${P[@]}"}"

  # (d) retraction: the stub deletes the ledger line.
  catalog retract "$A_RETRACT" --note "dogfood: retraction"
  run "$UNSTALE" sync
  SYNC_OUT="$OUT"
  run_quiet "$UNSTALE" run
  V="$(visible_text)"$'\n'"$OUT"
  run "$UNSTALE" ledger check
  problems < <(grep -qF "ledger: $A_RETRACT was retracted upstream" <<<"$SYNC_OUT" || echo "sync did not report the deletion"
               [ -z "$(ledger_status "$A_RETRACT")" ] || echo "$A_RETRACT still has a ledger line"
               absent "$V" "$A_RETRACT"
               [ "$RC" -eq 0 ] || echo "ledger check exited $RC")
  check "$NAME: 4d retraction of $A_RETRACT: ledger line deleted, record gone, ledger valid" "${P[@]+"${P[@]}"}"
  # The earlier decisions still hold after all four changes.
  problems < <([ "$(ledger_status "$A_LABEL")" = declined ] || echo "$A_LABEL lost its line"
               absent "$V" "$A_LABEL"
               donow_ids "$PRIMARY" | grep -qxF -- "$TARGET" || echo "$TARGET left 'Marked do now'")
  check "$NAME: 4 earlier decisions still hold after every change (decline withheld, do-now shown)" "${P[@]+"${P[@]}"}"
done

section "summary"
printf '%s\n' "${RESULTS[@]}"
echo "$(( ${#RESULTS[@]} - FAILS )) passed, $FAILS failed"
[ "$FAILS" -eq 0 ] && echo "PASS" || { echo "FAIL"; exit 1; }
