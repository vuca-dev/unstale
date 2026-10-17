# Replay, expanded set: deterministic queue metrics (15 October 2026)

15 upgrade events (the original 3 plus the 12 in `events/EVENTS.md`), DEV 9 / HELD-OUT 6 (split fixed before scoring).
Only the deterministic queue metric was run: the harness queue (condition `orig`, as in `RESULTS.md`) and the Codex
match step (two runs; a key change is **covered** when both runs give it an entry). **No review agent was run.** Counts
are key changes, not entries; "req" is the rule-based required subset (`events/EVENTS.md`, not a classifier).

- **First 16** = covered key changes whose entry is in the queue's first batch of 16, for the type-tier, usage and
  random orders. **Tier-0 size** = queue entries marked breaking (summed over events).
- **Catalogs** (copied with `cp -cR`; `.store` untouched). sha256 prefixes of `v1/tech/{nestjs,next,prisma}.json`:
  - **v1** `~/unstale/.store/catalog`: e6f1abd01cf3b295, 3bfef217d009fe3c, 2787c4159b995e36. Usage weights from the
    harness corpus, as in `RESULTS.md`.
  - **v1-fallback**: v1 with the edge's own weights (v1's indexes have `sample_n: 0`, so the edge uses rarity among the
    catalog's terms). Same match as v1.
  - **v2** `~/unstale/.store/catalog-v2` (upgrade guides with cross-source matching; term-rarity sample n = 5):
    55308c161aca8e56, 5e7c62b317ddd843, 682be93dc64bfefd. Usage weights from the published sample
    (`eval/rarity-sample/rarity_queue.py --weights sample`). Its own Codex match (its record set differs from v1).
  - **v2-no-sample**: a copy of v2 with `sample_n: 0` and `sample` removed in each tech index; queue with
    `rarity_queue.py --weights fallback` (the edge at `sample_n = 0`, as the rarity-sample measurement did). v2's match
    reused (same records).

## Per split

| Split | Catalog | Key (req) | Covered: all / req | In queue: all / req | First 16, tier: all / req | First 16, usage: all / req | First 16, random: all / req | Tier-0 size (sum) | Queue size (sum) |
|---|---|---|---|---|---|---|---|---|---|
| DEV (9) | v1 | 115 (72) | 63 / 43 | 62 / 42 | 44 / 30 | 34 / 21 | 22 / 11 | 307 | 709 |
| DEV (9) | v1-fallback | 115 (72) | 63 / 43 | 62 / 42 | 46 / 33 | 31 / 19 | 22 / 11 | 307 | 709 |
| DEV (9) | v2 | 115 (72) | 74 / 49 | 72 / 47 | 45 / 28 | 44 / 28 | 18 / 12 | 476 | 969 |
| DEV (9) | v2-no-sample | 115 (72) | 74 / 49 | 72 / 47 | 49 / 32 | 36 / 24 | 18 / 12 | 476 | 969 |
| HELD-OUT (6) | v1 | 43 (22) | 21 / 10 | 16 / 9 | 7 / 6 | 6 / 3 | 2 / 1 | 198 | 450 |
| HELD-OUT (6) | v1-fallback | 43 (22) | 21 / 10 | 16 / 9 | 9 / 6 | 6 / 3 | 2 / 1 | 198 | 450 |
| HELD-OUT (6) | v2 | 43 (22) | 21 / 11 | 17 / 10 | 8 / 7 | 7 / 4 | 2 / 1 | 310 | 622 |
| HELD-OUT (6) | v2-no-sample | 43 (22) | 21 / 11 | 17 / 10 | 9 / 8 | 7 / 5 | 2 / 1 | 310 | 622 |
| ALL (15) | v1 | 158 (94) | 84 / 53 | 78 / 51 | 51 / 36 | 40 / 24 | 24 / 12 | 505 | 1159 |
| ALL (15) | v1-fallback | 158 (94) | 84 / 53 | 78 / 51 | 55 / 39 | 37 / 22 | 24 / 12 | 505 | 1159 |
| ALL (15) | v2 | 158 (94) | 95 / 60 | 89 / 57 | 53 / 35 | 51 / 32 | 20 / 13 | 786 | 1591 |
| ALL (15) | v2-no-sample | 158 (94) | 95 / 60 | 89 / 57 | 58 / 40 | 43 / 29 | 20 / 13 | 786 | 1591 |


## What the numbers say

- **Coverage is the main loss, on both splits.** v1 covers 84 of 158 key changes (53 of 94 required); v2 covers 95
  (60 required). The gain from guides is all in DEV (63 → 74); held-out stays at 21 (required 10 → 11). Held-out
  coverage with v1 is 49% of all and 45% of required changes (v2: 49% and 50%), against 55% and 60% in DEV.
- **Type tier puts more required changes in the first 16 than usage, on both splits and every catalog.** v1: 36 vs 24
  of 51 queued required changes; held-out 6 vs 3 of 9. Random: 12.
- **The term-rarity sample costs the type-tier order and helps the usage order overall.** v2 vs v2-no-sample, required
  changes in the first 16: tier 35 vs 40, usage 32 vs 29. On held-out the sample is slightly worse on both (tier 7 vs 8,
  usage 4 vs 5). v1 vs v1-fallback goes the same way (tier 36 vs 39, usage 24 vs 22).
- **Guides grow tier 0 by 56%** (505 → 786 entries across the 15 queues; queues 1,159 → 1,591). Covered and queued
  required changes rise from 51 to 57, but the type-tier first batch holds about the same number (v1 36, v2 35,
  v2-no-sample 40).
- **Held-out is small:** 6 events, 22 required changes, 9 (v1) or 10 (v2) of them queued. A difference of one or two there is noise.

## Caveats

- **Match variance.** The original three events were re-matched here (new Codex runs): v1 covers 21 of their 40 changes
  (4 / 11 / 6), against 19 (3 / 10 / 6) in `RESULTS.md`, with the same queue sizes (128 / 81 / 47). The either-run
  column below shows the spread; satisfactory-nest12 under v2 got 2 and 0 in its two runs.
- **Keys:** one Codex draft per event, reviewed by me (13 items dropped, 2 added, 1 rewritten); no second reviewer.
  Some events are small (sigle, coros and satisfactory have 4 key changes each), and coh2stats has no required change.
- **Libraries vs apps:** five of the twelve are libraries (prisma-json-types-generator, prisma-zod-generator,
  nestjs-temporal-core, payload-plugins, cedar). Their required changes are often adaptations to the framework's
  internals (generated type names, DMMF shapes), which release notes rarely carry.

## Model calls

Codex only (`codex exec`, `gpt-5.6-luna`): 72 calls (12 key drafts, 30 v1 matches, 30 v2 matches); 6.34M input tokens
(4.86M cached), 117k output (66k reasoning). No review calls. No OpenAI API calls and no Jev or Decisions classifier
calls: `label_keys.mts` was not run, and required/optional is rule-based.

## Commands

```sh
S=<scratch>; cp -cR ~/unstale/.store/catalog $S/cat-v1; cp -cR ~/unstale/.store/catalog-v2 $S/cat-v2
cp -cR $S/cat-v2 $S/cat-v2-nosample      # then set sample_n 0 and drop sample in v1/tech/*.json
cd ~/unstale/eval/replay
python3 run_replay.py --catalog $S/cat-v1 --work $S/w1 --set all --events-src $S/events setup   # clones at the pins
python3 run_replay.py --catalog $S/cat-v1 --work $S/w1 --set all queue
python3 run_replay.py --catalog $S/cat-v1 --work $S/w1 --set all match          # 2 Codex calls per event
python3 run_replay.py --catalog $S/cat-v1 --work $S/w1 --set all metrics --out events/scores/metrics_w1.json
cd ../rarity-sample                                                             # v2, v2-no-sample, v1-fallback queues
python3 rarity_queue.py --catalog $S/cat-v2 --work $S/w2 --weights sample <events>            # then match as above
python3 rarity_queue.py --catalog $S/cat-v2-nosample --work $S/w2n --weights fallback <events> # match copied from w2
python3 rarity_queue.py --catalog $S/cat-v1 --work $S/w1f --weights fallback <events>          # match copied from w1
python3 ../replay/events/aggregate.py v1=.../metrics_w1.json v1-fallback=... v2=... v2-no-sample=...
```

Score files: `events/scores/metrics_{w1,w1f,w2,w2n}.json`. Match maps: `events/match/{v1,v2}/<event>.json`.

## Per event

| Event | Split | Catalog | Key (req) | Covered (req) | Either run | In queue (req) | Tier 16 (req) | Usage 16 (req) | Random 16 (req) | Tier 0 | Queue |
|---|---|---|---|---|---|---|---|---|---|---|---|
| workout-next16 | DEV | v1 | 10 (3) | 4 (1) | 4 | 4 (1) | 1 (1) | 3 (1) | 1 (0) | 42 | 128 |
| workout-next16 | DEV | v1-fallback | 10 (3) | 4 (1) | 4 | 4 (1) | 1 (1) | 2 (1) | 1 (0) | 42 | 128 |
| workout-next16 | DEV | v2 | 10 (3) | 6 (3) | 7 | 6 (3) | 1 (1) | 2 (1) | 2 (1) | 72 | 176 |
| workout-next16 | DEV | v2-no-sample | 10 (3) | 6 (3) | 7 | 6 (3) | 2 (2) | 3 (1) | 2 (1) | 72 | 176 |
| invoicerr-prisma7 | DEV | v1 | 16 (16) | 11 (11) | 12 | 11 (11) | 11 (11) | 6 (6) | 5 (5) | 54 | 81 |
| invoicerr-prisma7 | DEV | v1-fallback | 16 (16) | 11 (11) | 12 | 11 (11) | 11 (11) | 6 (6) | 5 (5) | 54 | 81 |
| invoicerr-prisma7 | DEV | v2 | 16 (16) | 10 (10) | 12 | 10 (10) | 6 (6) | 5 (5) | 0 (0) | 75 | 106 |
| invoicerr-prisma7 | DEV | v2-no-sample | 16 (16) | 10 (10) | 12 | 10 (10) | 6 (6) | 5 (5) | 0 (0) | 75 | 106 |
| invoicerr-nest12 | DEV | v1 | 14 (13) | 6 (5) | 7 | 6 (5) | 3 (2) | 6 (5) | 0 (0) | 12 | 47 |
| invoicerr-nest12 | DEV | v1-fallback | 14 (13) | 6 (5) | 7 | 6 (5) | 3 (2) | 6 (5) | 0 (0) | 12 | 47 |
| invoicerr-nest12 | DEV | v2 | 14 (13) | 6 (5) | 12 | 6 (5) | 3 (2) | 6 (5) | 0 (0) | 18 | 61 |
| invoicerr-nest12 | DEV | v2-no-sample | 14 (13) | 6 (5) | 12 | 6 (5) | 3 (2) | 6 (5) | 0 (0) | 18 | 61 |
| chmonitor-next16 | HELD-OUT | v1 | 13 (8) | 6 (4) | 8 | 6 (4) | 1 (1) | 2 (1) | 0 (0) | 31 | 69 |
| chmonitor-next16 | HELD-OUT | v1-fallback | 13 (8) | 6 (4) | 8 | 6 (4) | 1 (1) | 2 (1) | 0 (0) | 31 | 69 |
| chmonitor-next16 | HELD-OUT | v2 | 13 (8) | 7 (5) | 7 | 7 (5) | 2 (2) | 2 (1) | 0 (0) | 61 | 117 |
| chmonitor-next16 | HELD-OUT | v2-no-sample | 13 (8) | 7 (5) | 7 | 7 (5) | 3 (3) | 3 (2) | 0 (0) | 61 | 117 |
| aksel-next16 | DEV | v1 | 9 (3) | 6 (2) | 6 | 6 (2) | 1 (0) | 2 (1) | 1 (0) | 31 | 81 |
| aksel-next16 | DEV | v1-fallback | 9 (3) | 6 (2) | 6 | 6 (2) | 1 (1) | 1 (0) | 1 (0) | 31 | 81 |
| aksel-next16 | DEV | v2 | 9 (3) | 7 (2) | 7 | 7 (2) | 1 (1) | 2 (1) | 2 (0) | 61 | 130 |
| aksel-next16 | DEV | v2-no-sample | 9 (3) | 7 (2) | 7 | 7 (2) | 1 (1) | 1 (0) | 2 (0) | 61 | 130 |
| payloadplugins-next16 | DEV | v1 | 8 (4) | 3 (3) | 3 | 3 (3) | 1 (1) | 1 (1) | 0 (0) | 42 | 137 |
| payloadplugins-next16 | DEV | v1-fallback | 8 (4) | 3 (3) | 3 | 3 (3) | 2 (2) | 1 (1) | 0 (0) | 42 | 137 |
| payloadplugins-next16 | DEV | v2 | 8 (4) | 3 (3) | 4 | 3 (3) | 2 (2) | 1 (1) | 1 (1) | 72 | 186 |
| payloadplugins-next16 | DEV | v2-no-sample | 8 (4) | 3 (3) | 4 | 3 (3) | 1 (1) | 1 (1) | 1 (1) | 72 | 186 |
| coh2stats-next16 | HELD-OUT | v1 | 5 (0) | 3 (0) | 3 | 3 (0) | 0 (0) | 1 (0) | 0 (0) | 41 | 136 |
| coh2stats-next16 | HELD-OUT | v1-fallback | 5 (0) | 3 (0) | 3 | 3 (0) | 1 (0) | 0 (0) | 0 (0) | 41 | 136 |
| coh2stats-next16 | HELD-OUT | v2 | 5 (0) | 3 (0) | 3 | 3 (0) | 0 (0) | 1 (0) | 0 (0) | 71 | 185 |
| coh2stats-next16 | HELD-OUT | v2-no-sample | 5 (0) | 3 (0) | 3 | 3 (0) | 0 (0) | 0 (0) | 0 (0) | 71 | 185 |
| sigle-prisma7 | HELD-OUT | v1 | 4 (4) | 4 (4) | 4 | 3 (3) | 3 (3) | 1 (1) | 0 (0) | 53 | 90 |
| sigle-prisma7 | HELD-OUT | v1-fallback | 4 (4) | 4 (4) | 4 | 3 (3) | 3 (3) | 1 (1) | 0 (0) | 53 | 90 |
| sigle-prisma7 | HELD-OUT | v2 | 4 (4) | 4 (4) | 4 | 3 (3) | 3 (3) | 2 (2) | 0 (0) | 73 | 113 |
| sigle-prisma7 | HELD-OUT | v2-no-sample | 4 (4) | 4 (4) | 4 | 3 (3) | 3 (3) | 2 (2) | 0 (0) | 73 | 113 |
| cedar-prisma7 | DEV | v1 | 23 (16) | 18 (15) | 19 | 17 (14) | 14 (11) | 1 (1) | 1 (1) | 52 | 80 |
| cedar-prisma7 | DEV | v1-fallback | 23 (16) | 18 (15) | 19 | 17 (14) | 14 (11) | 0 (0) | 1 (1) | 52 | 80 |
| cedar-prisma7 | DEV | v2 | 23 (16) | 18 (15) | 20 | 17 (14) | 12 (9) | 11 (8) | 10 (8) | 72 | 103 |
| cedar-prisma7 | DEV | v2-no-sample | 23 (16) | 18 (15) | 20 | 17 (14) | 15 (12) | 4 (4) | 10 (8) | 72 | 103 |
| jsontypes-prisma7 | HELD-OUT | v1 | 12 (6) | 4 (1) | 5 | 1 (1) | 1 (1) | 0 (0) | 0 (0) | 54 | 72 |
| jsontypes-prisma7 | HELD-OUT | v1-fallback | 12 (6) | 4 (1) | 5 | 1 (1) | 1 (1) | 0 (0) | 0 (0) | 54 | 72 |
| jsontypes-prisma7 | HELD-OUT | v2 | 12 (6) | 5 (1) | 5 | 2 (1) | 1 (1) | 0 (0) | 1 (0) | 74 | 96 |
| jsontypes-prisma7 | HELD-OUT | v2-no-sample | 12 (6) | 5 (1) | 5 | 2 (1) | 1 (1) | 0 (0) | 1 (0) | 74 | 96 |
| zodgen-prisma7 | DEV | v1 | 15 (11) | 4 (4) | 5 | 4 (4) | 3 (3) | 4 (4) | 3 (3) | 53 | 60 |
| zodgen-prisma7 | DEV | v1-fallback | 15 (11) | 4 (4) | 5 | 4 (4) | 3 (3) | 4 (4) | 3 (3) | 53 | 60 |
| zodgen-prisma7 | DEV | v2 | 15 (11) | 7 (6) | 8 | 6 (5) | 3 (2) | 2 (2) | 2 (2) | 73 | 84 |
| zodgen-prisma7 | DEV | v2-no-sample | 15 (11) | 7 (6) | 8 | 6 (5) | 4 (3) | 6 (5) | 2 (2) | 73 | 84 |
| temporal-nest12 | DEV | v1 | 16 (5) | 8 (2) | 8 | 8 (2) | 7 (1) | 8 (2) | 8 (2) | 13 | 54 |
| temporal-nest12 | DEV | v1-fallback | 16 (5) | 8 (2) | 8 | 8 (2) | 8 (2) | 8 (2) | 8 (2) | 13 | 54 |
| temporal-nest12 | DEV | v2 | 16 (5) | 14 (5) | 14 | 14 (5) | 14 (5) | 14 (5) | 0 (0) | 19 | 68 |
| temporal-nest12 | DEV | v2-no-sample | 16 (5) | 14 (5) | 14 | 14 (5) | 14 (5) | 9 (3) | 0 (0) | 19 | 68 |
| coros-nest12 | DEV | v1 | 4 (1) | 3 (0) | 3 | 3 (0) | 3 (0) | 3 (0) | 3 (0) | 8 | 41 |
| coros-nest12 | DEV | v1-fallback | 4 (1) | 3 (0) | 3 | 3 (0) | 3 (0) | 3 (0) | 3 (0) | 8 | 41 |
| coros-nest12 | DEV | v2 | 4 (1) | 3 (0) | 3 | 3 (0) | 3 (0) | 1 (0) | 1 (0) | 14 | 55 |
| coros-nest12 | DEV | v2-no-sample | 4 (1) | 3 (0) | 3 | 3 (0) | 3 (0) | 1 (0) | 1 (0) | 14 | 55 |
| satisfactory-nest12 | HELD-OUT | v1 | 4 (1) | 2 (0) | 4 | 1 (0) | 0 (0) | 0 (0) | 1 (0) | 11 | 45 |
| satisfactory-nest12 | HELD-OUT | v1-fallback | 4 (1) | 2 (0) | 4 | 1 (0) | 1 (0) | 1 (0) | 1 (0) | 11 | 45 |
| satisfactory-nest12 | HELD-OUT | v2 | 4 (1) | 0 (0) | 2 | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 17 | 59 |
| satisfactory-nest12 | HELD-OUT | v2-no-sample | 4 (1) | 0 (0) | 2 | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 17 | 59 |
| eudiplo-nest12 | HELD-OUT | v1 | 5 (3) | 2 (1) | 2 | 2 (1) | 2 (1) | 2 (1) | 1 (1) | 8 | 38 |
| eudiplo-nest12 | HELD-OUT | v1-fallback | 5 (3) | 2 (1) | 2 | 2 (1) | 2 (1) | 2 (1) | 1 (1) | 8 | 38 |
| eudiplo-nest12 | HELD-OUT | v2 | 5 (3) | 2 (1) | 2 | 2 (1) | 2 (1) | 2 (1) | 1 (1) | 14 | 52 |
| eudiplo-nest12 | HELD-OUT | v2-no-sample | 5 (3) | 2 (1) | 2 | 2 (1) | 2 (1) | 2 (1) | 1 (1) | 14 | 52 |

