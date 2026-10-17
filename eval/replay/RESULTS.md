# Replay against the unstale catalog (15 October 2026)

`~/ati-slice0/harness/replay.py` is run unchanged against the published unstale catalog through
`run_replay.py`, and compared with the first replay (14 October 2026). Condition `orig`, the four original arms, K=2, and the original answer keys
(58 changes, reused, not regenerated).

- **Catalog:** the final catalog promoted at `~/unstale/.store/catalog` (1,005 active records), snapshotted with
  `cp -cR` before the run. sha256 prefixes of `v1/tech/{nestjs,next,prisma}.json`: `e6f1abd01cf3b295`,
  `3bfef217d009fe3c`, `2787c4159b995e36`.
- **Laravel 12 (krayin-laravel12):** not covered (no Laravel in the catalog), so it was not run. Its 18 key changes are
  left out of every table here, as in the first replay's tables.
- **No apply or check step exists in replay.py, and none was added.** Reviews propose changes; nothing is applied, built
  or tested. So the rule about running pending DB migrations did not trigger.

## Coverage of what the maintainers did

| Event | Key changes | With a catalog entry: baseline / unstale | Entry in the queue | Queue size: baseline / unstale |
|---|---|---|---|---|
| Next.js 16 | 10 | 5 / **3** | 3 | 110 / 128 |
| Prisma 7 | 16 | 10 / **10** | 10 | 45 / 81 |
| NestJS 12 | 14 | 6 / **6** | 6 | 38 / 47 |
| **Total** | **40** | **21 / 19** | **19** | |

"With an entry" is the intersection of two Codex match runs (either-run: 4 / 11 / 6).

## Key changes whose entry is in the first batch of 16 (no agent)

| Order | Next.js 16 | Prisma 7 | NestJS 12 | Total: unstale (of 19) | Baseline (of 20) |
|---|---|---|---|---|---|
| Type tier | 0 of 3 | 10 of 10 | 3 of 6 | **13** | 18 |
| Usage | 2 of 3 | 6 of 10 | 6 of 6 | **14** | 8 |
| Random | 1 of 3 | 4 of 10 | 0 of 6 | 5 | 4 |

## Key changes the review found (mean of two reviews)

| Batch | Next.js 16 | Prisma 7 | NestJS 12 | Total: unstale (of 19) | Baseline (of 20) | Mean input tokens per review |
|---|---|---|---|---|---|---|
| Type tier, 16 | 0 | 9 | 1.5 | **10.5** | 17.5 | 277k |
| Usage, 16 | 1.5 | 5.5 | 1.5 | 8.5 | 7.5 | 193k |
| Random, 16 | 1 | 2 | 0 | 3 | 4 | 174k |
| Whole queue (47–128 entries) | 2 | 10 | 1.5 | **13.5** | 19.5 | 317k |

## Required vs optional (classifier label, not ground truth)

Each of the 40 key changes was labelled by the central classifier adapter (Jev answered all 40; no OpenAI fallback),
with the strict breaking rubric reframed as "would the upgrade fail or behave noticeably differently without this
change" (`label_keys.mts`, labels in `key_labels.json`). **This is a classifier label, not ground truth.** 35 are
labelled required, 5 optional (Next K3, K5, K10; Prisma K3; NestJS K14). 5 are borderline (p in [0.35, 0.65)): Next K8,
Prisma K3, NestJS K8, K11, K14. The keys' own `responds_to` text often says "required", which pushes the label that way.

| | Key | Covered: baseline / unstale | Type-tier first 16 | Found, type tier 16 | Found, whole queue | Found, usage 16 | Found, random 16 |
|---|---|---|---|---|---|---|---|
| Required | 35 | 19 / **17** | 17 / **12** | 16.5 / **9.5** | 18 / **12.5** | 6.5 / 7.5 | 3 / 2.5 |
| Optional | 5 | 2 / **2** | 1 / **1** | 1 / **1** | 1.5 / **1** | 1 / 1 | 1 / 0.5 |

(Baseline / unstale in each cell; the baseline split applies the same labels to the first replay's match and reviews,
copied read-only, no model calls. It reproduces the first replay's totals: 21 covered, 18 in the type-tier first batch,
17.5 and 19.5 found.)

## Why type tier fell

The unstale catalog's `breaking` is set by the classifier with the strict rubric. The entries behind the required key changes are now labelled not breaking, so they leave tier 0:

- **Next.js 16:** `next-proxy-ts` (new_api, tier 3, rank 71), `next-images-domains-domains` (deprecation that still
  warns, tier 1, rank 44), `next-turbopack` (default_change, tier 2, rank 66), behind 42 breaking records. In the
  baseline all three were tier 0 (ranks 5, 6, 44).
- **NestJS 12:** `nestjs-esm-packages` is labelled not breaking (rank 15, inside the batch but in the middle). This is
  the case the first replay called out: the source says CommonJS apps keep working, but invoicerr's Jest setup could not load the
  packages. Of the four type-tier and whole-queue reviews, two proposed it (one only as "later") and two did not; three covered key changes hang off it.
- **Prisma 7** is unaffected: its entries are still breaking (54 of 81 queue entries are tier 0) and it matches or
  beats the baseline (10 covered, 10 of 10 in the first tier batch, 9 found by type tier and 10 by the whole queue).
- **Coverage loss is Next.js only:** no entry in the 15.2.6–16.2.1 window describes the `next lint` removal (K6) or the
  flat ESLint config switch (K7 matched in one run only); the baseline had `next-next-lint` and two flat-config entries.
  NestJS's Node 24 floor (K13) lost its entry and `nestjs-vitest` (a starter-like tooling entry) picked up three
  test-runner changes instead.

## Model calls

- **Codex** (`gpt-5.6-luna`, from its JSON `turn.completed` events): 30 calls. Match: 6, 137.5k input (59.9k
  cached), 5.3k output. Review: 24, 5.78M input (4.67M cached), 120.6k output (40.3k reasoning).
- **Classifier:** 40 Jev calls, 31.0k input / 1.2k output tokens, 0 OpenAI Decisions calls (logged in
  `~/unstale/.store/central/usage.jsonl`). A rerun hits the cache 40/40 with 0 uncached calls.

## Commands

```sh
S=<scratch>/replay-work; cp -cR ~/unstale/.store/catalog $S/catalog-final
cd ~/unstale/eval/replay
python3 run_replay.py --catalog $S/catalog-final --work $S/final setup     # cp -c keys, cp -cR full clones and corpus
python3 run_replay.py --catalog $S/catalog-final --work $S/final queue     # no model
for ev in workout-next16 invoicerr-prisma7 invoicerr-nest12; do
  ( python3 run_replay.py --catalog $S/catalog-final --work $S/final match $ev &&
    python3 run_replay.py --catalog $S/catalog-final --work $S/final --arms tier,all,usage,random review $ev ) &
done; wait
python3 run_replay.py --catalog $S/catalog-final --work $S/final score
cd ~/unstale/central && npx tsx ../eval/replay/label_keys.mts $S/final/replay ../eval/replay/key_labels.json
cd ~/unstale/eval/replay && python3 run_replay.py --catalog $S/catalog-final --work $S/final --labels key_labels.json split
python3 run_replay.py --catalog $S/catalog-final --work $S/final usage
```

Per-event score files (harness score row + required/optional split): `scores/score_<event>.json`; baseline split:
`scores/baseline_split_orig.json`.

## Caveats

- Three upgrades, two reviews per arm; one agent built the keys and another matched them, and the two match runs disagreed
  on up to one change per upgrade.
- The harness's `orig` funnel (substring "applied" check, no `package.json` scripts in usage text) is kept for
  comparability; `--cond notes` gives the corrected funnel.
- Catalog records merge several releases; the adapter dates each by its earliest release inside the event's window.
