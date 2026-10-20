# Slice 7 pre-registration: shared guide extraction + a Jev relevance question per record and package

Written 20 October 2026, before any slice 7 model call (dev or held-out) and before any held-out output of the
candidate exists. Runner `run7.mts`, question and state `relevance.mts`, scorer `score7.mts`, splits `splits.json`
(this directory). Code: `origin/main` `93d17d6` with slice 6's `design.patch` applied to `central/src` (the shared
neutral extraction; used here only to prepare gold).

## Why

Slice 6 (`../slice6/RESULTS.md`) showed that extracting a shared upgrade guide once per guide URL and snapshot is
sound (held-out recall vs current 93.1 without any selection, about 74% cheaper) but that one model call per package
picking that package's records by id is not: recall vs current 15.5 against the replicate's 80.2. How much of a guide
a package keeps today depends on the family (AI SDK providers keep most of the 7.0 core guide; Next.js and Tiptap
plugins keep only their own section).

## Design under test

1. **A + B + D once per guide and snapshot**, exactly as slice 6's `shared-all` (neutral `%TECH%`/`%DATE%`, records
   labelled once). This slice reuses slice 6's `shared-all` outputs and usage logs for dev and held-out (same units,
   same state); gold's neutral extraction is answered from slice 6's gold cache (`run7.mts --arm shared-all`).
2. **One Jev question per (record, package)** replaces the selection call. State (`relevanceState`): the package
   name, its repository and monorepo directory when known, the guide URL and release, the record's heading path in
   the guide (`headingPath`: the headings above its quote, fenced code skipped), and the record's subject, facet,
   summary and evidence. One yes/no choice question whose text is the same for every package (it refers to the
   package named in the state). The record is kept for the package when p(yes) ≥ the revision's threshold.
   No per-technology lists; no package description (the pipeline's technology carries none).
3. **E unchanged**, per package.

Arm names: `jev-r0` (registered wording, `relevance.mts` at this commit), `jev-r1` … `jev-r3`.

## Fitting on dev (at most 3 revisions after r0)

Each revision may change the question text, the state fields and the threshold; each is a full dev run with an
empty classifier cache. Within a revision the threshold is chosen on dev from {0.3, 0.4, 0.5, 0.6, 0.7} as the
value with the highest dev F1 (from `probs.jsonl`, no new calls); `relevance.mts` then records it. The revision
frozen for held-out is the one that passes the dev rule (below) with the highest dev F1, else the one with the
highest dev F1. Its text, threshold and the `relevance.mts` sha are committed before the held-out run.

## Arms and baseline (slice 6's, reused)

| Arm | What | Source |
|---|---|---|
| `base` | Production's per-package answers replayed from the 20 October state's caches | `out/slice6/{dev,heldout}/base` |
| `rep` | A fresh per-package run: the noise reference | `out/slice6/{dev,heldout}/rep` |
| `jev-rN` | `shared-all` records filtered per package by the relevance question | `out/slice7/<split>/jev-rN` |

Model for A/B: `vercel:openai/gpt-6-luna`, low, flex, two calls (production's); Jev `jev-latest` through the
pipeline's classifier (chat fallback, as production).

## Sets (same 15 units and 82 pairs as slice 6, re-split so dev holds a provider family)

| Split | Families | Units | Pairs | Base records |
|---|---|---|---|---|
| DEV | AI SDK 6.0 and 7.0 (core `ai` + providers, `@ai-sdk/react`, `@ai-sdk/otel`, `provider-utils`), Tiptap v2, React Router v7 | 4 | 33 | 869 |
| HELD-OUT (family-disjoint) | Next.js (app/pages 15, 16), NestJS 12, AWS Amazon MQ (4 pages) | 9 | 35 | 93 |
| HELD-OUT-AISDK (same family, other units) | AI SDK 4.0 and 5.0 | 2 | 14 | 260 |
| GOLD | The held-out majors set's three upgrade guides (`@sveltejs/kit` 3, `msw` 3, `transformers` 5), each read by its own package | 3 | 3 | — |

HELD-OUT is family-disjoint from DEV as required. Because a provider family is the hard case and has only one
family in the state, HELD-OUT-AISDK is checked as well (unit-disjoint: different guides, guide sizes and chunk
counts); it is not family-disjoint and is reported as such.

## Metrics, margins (slice 6's, unchanged; `score7.mts` is `score6.mts` on these splits)

Per pair, records matched one to one to `base` (overlapping grounded quotes, else the same subject). F1 per pair
(mean), recall and precision vs current (pooled), records vs base, terms Jaccard, breaking and benefit agreement,
failed pairs; bootstrap 2,000 pair resamples, seed 20261020, paired CI for candidate − `rep`.

## Decision rule (one look at each held-out set, candidate against `rep`, both against `base`)

The frozen revision passes when ALL hold on HELD-OUT **and** on HELD-OUT-AISDK:

1. F1 no more than 3 points below `rep`'s, paired CI of the difference not entirely below 0.
2. Recall vs current and precision vs current each no more than 5 points below `rep`'s, paired CI not entirely below 0.
3. Records within ±10% of `base`, or within `rep`'s own deviation + 5 points if `rep` deviates more than 5%.
4. Terms Jaccard no more than 5 points below `rep`'s.
5. Breaking and benefit agreement each no more than 3 points below `rep`'s, paired CI not entirely below 0.
6. Failed pairs ≤ max(1, 2%).
7. **Gold** (slice 6 condition 7, unchanged): neutral extraction + the relevance question for the guide's own
   package against slice 3b's stored gpt-6-luna two-call run, `holdout/score.py compare` on the guides-only
   manifest: required-group recall excl. unsure and breaking-group recall each no more than 5 points below the
   baseline with the CI of the difference not entirely below 0; precision no more than 10 points below.
8. **Cost:** the design (shared A + B + D for the units, from slice 6's `shared-all` logs, plus the relevance calls)
   costs less than `rep` on each held-out set's pairs.

1–6 are mechanical (`score7.mts` `rule`, `verdict`); 7 from `score.py`; 8 from the usage logs (`cost7.py`).

If it passes: the design goes into `central/src` (guarded by `UNSTALE_GUIDE_SHARED`, `0` restores per-package
prompts) with tests, in a PR. If any condition fails: nothing in `central/src` changes; an eval-only PR records it.

## Cost reporting

Per split: `rep` (per package, as production) against the design: gateway $ (provider-reported) and Jev $ (input
tokens × $0.042/M) for A + B + D once per unit, plus Jev $ for the relevance calls, and the relevance calls' share.
If the relevance calls eat the saving, RESULTS says so. A steady-state estimate uses slice 6's production log mix
(guides $0.336 a day, $0.25 of it on shared guides).

## Budget

Gateway **$3.00**, Jev **$0.50** across this slice's own logs (`run7.mts` refuses a call whose worst case would pass
either). Projection: about 350 Jev input tokens per question; dev ≈ 1,700 questions per revision (≈ $0.025), held-out
≈ 2,000 (≈ $0.03), gold's missing labels ≈ $0.02. No gateway spend expected (gold's extraction is cached).

## Known limits and what was seen before registration

- The baseline is production's own output, not gold; the gold check covers only a guide's own package.
- Everything slice 6 published is known: per-pair record counts of `base`, `rep`, `shared-all` on all 15 units
  (slice 6's inventory and scores), and the AI SDK 6.0 per-package records (dumped while designing). Before writing
  this, per-chunk agreement of `shared-all` with `base` was tabulated for the AI SDK and NestJS units: today's
  per-package extraction often keeps or drops whole chunks of a multi-chunk guide for a package (7.0: `@ai-sdk/mistral`
  keeps 25/25 of chunk 1 and 2/25 of chunk 0), and on single-chunk guides (4.0, 6.0) most providers keep only their
  own section. A per-record question cannot see chunks; this is expected to limit agreement, and no chunk signal is
  given to Jev.
- Pairs within a unit share one extraction, so the pair bootstrap understates the spread. HELD-OUT's base has 93
  records (NestJS 73, Next.js 20; the 16 AWS pairs are empty in `base` and `rep`).
- `rep` and the shared extraction are one run each (slice 6's).
