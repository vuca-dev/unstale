#!/bin/bash
# The slice's runs in pre-registered order, one chain per provider (PREREG.md). Usage: run.sh decisions|gateway|openai
# Logs: eval/select/out/provider-matrix/logs/<chain>.log. The gateway chain stops when the live balance falls below $2.
# Second-stage runs (A+B held-out, D H2) are started by hand only for arms that pass the first stage.
set -u
cd "$(dirname "$0")/../../central"
L=../eval/select/out/provider-matrix/logs
mkdir -p "$L"
log="$L/$1.log"
run() { echo "== $*" >>"$log"; npx tsx "$@" >>"$log" 2>&1 || echo "!! exit $? for $*" >>"$log"; }
bal() { npx tsx ../eval/provider-matrix/balance.mts --min 2.0 >>"$log" 2>&1 || { echo "!! gateway balance below the stop" >>"$log"; exit 1; }; }
case "$1" in
  decisions)
    run ../eval/select/slice4/run4.mts --cand decisions --split dev
    run ../eval/select/slice4/run4.mts --cand decisions --split heldout
    run ../eval/select/slice5/judge2.mts --arm Q8 --floor 0.60 --cand jev --split dev
    run ../eval/select/slice5/judge2.mts --arm Q8 --floor 0.60 --cand jev --split heldout
    run ../eval/select/slice5/judge2.mts --arm Q8 --floor 0.60 --cand decisions --split dev
    run ../eval/select/slice5/judge2.mts --arm Q8 --floor 0.60 --cand decisions --split heldout ;;
  gateway)
    bal; run ../eval/select/slice3/run3.mts --cand vercel:anthropic/claude-haiku-5.5 --split dev --out provider-matrix --cap 1.5
    for c in vercel:anthropic/claude-haiku-5.5 vercel:openai/gpt-6-luna; do
      for s in dev heldout; do bal; run ../eval/select/slice4/run4.mts --cand "$c" --split "$s"; done
      for s in dev heldout; do bal; run ../eval/select/slice5/run5.mts --cand "$c" --split "$s"; done
    done ;;
  openai)
    run ../eval/select/slice3/run3.mts --cand openai:gpt-6-luna --split heldout --out provider-matrix --cap 0.2 ;;
esac
echo "== done" >>"$log"
