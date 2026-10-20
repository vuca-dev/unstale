# Slice 6 pre-registration: one extraction per shared upgrade guide

Written 20 October 2026, before any `rep` or `shared` run on any split and before any held-out or gold output exists.
Only the free inventory (`inventory.mts`) and the `base` arm on dev (cached answers, no calls) have been run.
Runner `run6.mts`, scorer `score6.mts`, splits `splits.json` (this directory). Code: HEAD `b0880fa` plus this branch's
changes to `central/src/pipeline/extract.ts`, `classify/labels.ts`, `classify/adapter.ts`, `llm.ts`.

## Why

A family of packages released together shares one upgrade guide page, and every package ingests it on its own. The
production usage log of 19–20 October 2026 shows the AI SDK 7.0 guide processed by 12 packages ($0.145: A $0.032,
B $0.026, Jev labels $0.056, Jev judge $0.032), the 4.0/5.0/6.0 guides by 3–9 each; all guides cost $0.336 of the
log's $0.772. The extract and label prompts differ between packages only in `%TECH%` and `%DATE%` (the date
`fetchGuides` assigns per package), so no cache hit is possible today.

**Per-package context changes the answer a lot** (inventory, cached production answers): on the AI SDK 7.0 guide the
packages got between 9 (`@ai-sdk/otel`) and 84 (`@ai-sdk/gateway`) records; on the Next.js 16 app guide
`eslint-config-next` 7, `@next/bundle-analyzer` 8, `@next/third-parties` 0. The extract prompt's "a developer using
this technology" filters by package. So reusing one package's records for its siblings (option b) would change every
sibling's catalog, and sharing labels between per-package records (option c) has nothing identical to share.

## Design under test (`UNSTALE_GUIDE_SHARED=1`)

1. **A + B once per guide page and snapshot.** For an upgrade guide, `%TECH%` becomes `the technology covered by the
   upgrade guide at <url>` and `%DATE%` becomes `upgrade guide`, in both the extract and the label prompt. The prompts
   are then byte-identical for every package reading the same page at the same snapshot, so the existing model cache
   answers every package after the first (and `llm.ts` now joins a request already in flight).
2. **Per-package selection (new, one call per package and guide).** `GUIDE_SELECT_PROMPT` (sha `d0a51dbf` at
   registration) receives the package name and purls, the guide URL and version, and the guide's records as briefs
   (id, section, subject, facet, summary, requires), and returns the ids that concern the package. Answered by id, not
   rewritten. A failed selection keeps no record and counts as a failed call (retried on the next run).
3. **D once per record.** `recordState` names the guide the same way for upgrade-guide records, so the classifier
   request is identical across packages and its cache (and in-flight join) answers all but the first.
4. **E unchanged**, per package, against that package's own records.

This is option (a) with a model selection instead of a deterministic filter: no deterministic signal reproduces
the per-package relevance the model applies today (it keeps core `ai` changes for providers, drops them for
`@ai-sdk/otel`), and a filter written per family would not generalise.

The selection prompt may be revised on DEV (at most 3 revisions, each a full dev rerun of `shared` with a new cache
directory); the version used on held-out is frozen before the held-out run and its sha recorded in RESULTS.

## Arms

| Arm | What | Cost |
|---|---|---|
| `base` | Production's per-package answers (A, B and Jev labels) replayed from the 20 October state's caches, `UNSTALE_GUIDE_SHARED=0`, network refused | free |
| `rep` | A fresh per-package run (`UNSTALE_GUIDE_SHARED=0`, empty caches): the noise reference, what production would answer if asked again | gateway + Jev |
| `shared` | The design, empty caches; a unit's packages run one after another, so the first pays for the guide | gateway + Jev |

Model `vercel:openai/gpt-6-luna`, reasoning `low`, flex tier, two calls (production's setting); Jev `jev-latest` with
the pipeline's chat fallback, as production.

## Sets

A **unit** is one guide URL + snapshot that two or more packages ingested; a **pair** is a unit × one of its packages.
From the 20 October production state (`guides/`, 171 packages with guides): 15 units, 82 pairs, all cached.
Split by family (technology-disjoint):

| Split | Families | Units | Pairs | Base records |
|---|---|---|---|---|
| DEV | Next.js (app/pages 15 and 16), AWS Amazon MQ (4 pages attached to `@aws-sdk/*`), Tiptap v2, React Router v7 | 10 | 37 | 39 |
| HELD-OUT | AI SDK 4.0, 5.0, 6.0, 7.0; NestJS 12 | 5 | 45 | 1,183 (49 with no cached label: compared on extraction only) |
| GOLD | The held-out majors set's three upgrade guides (`@sveltejs/kit` 3, `msw` 3, `transformers` 5), each read by its own package: does the neutral prompt plus selection lose labelled changes for a guide's own package? | 3 | 3 | — |

## Metrics (held-out decides; dev is for fitting and a sanity look)

Per pair, records of an arm are matched one to one to `base` as slice 3d did (grounded quotes whose spans overlap in
the folded guide, else the same subject after case folding).

- **F1** per pair (two empty answers count as 1), mean over pairs.
- **Recall vs current** = matched / base records, pooled. **Precision vs current** = matched / arm records, pooled.
- **Records** = arm records / base records − 1.
- **Terms Jaccard** on matched records (after `toIncoming`).
- **Labels (D)** on matched records whose both sides were labelled: breaking agreement, benefit-set exact
  agreement; change_type and surface agreement reported.
- **Failures**: pairs with a failed call.
- Bootstrap: 2,000 resamples of pairs, seed 20261020, percentile 95% CIs; the `shared − rep` CI is paired (same
  resampled pairs).
- **Cost**: provider-reported gateway $ and Jev $ (input tokens × $0.042/M) per arm on the same pairs, from the arms'
  usage logs; the saving is `rep` − `shared` (A + B + selection, D). E is not run (unchanged by the design).

## Decision rule (held-out, one look; `shared` against `rep`, both against `base`)

`shared` passes when ALL hold:

1. F1 no more than **3 points** below `rep`'s, and the paired CI of `shared − rep` not entirely below 0 (slice 3d).
2. Recall vs current and precision vs current, each no more than **5 points** below `rep`'s, paired CI not entirely
   below 0.
3. Records within ±10% of `base`, or within `rep`'s own deviation + 5 points if `rep` deviates more than 5%.
4. Terms Jaccard no more than 5 points below `rep`'s (slice 3d).
5. Breaking agreement and benefit agreement each no more than **3 points** below `rep`'s, paired CI not entirely below 0.
6. Failed pairs ≤ max(1, 2%).
7. **Gold:** on the three labelled guides, `shared` (neutral prompts + selection for the guide's own package) against
   slice 3b's stored gpt-6-luna two-call run (`out/slice3b/runs/vercel_openai_gpt-6-luna-two-call-heldout2`, the same
   prompts: extract `68e134fe`, label `e654eae8`), records of the three guides only, `holdout/score.py compare` on a
   guides-only manifest (section bootstrap): required-group recall excluding unsure and breaking-group recall each no
   more than 5 points below the baseline with the CI of the difference not entirely below 0; precision no more than
   10 points below (slice 3b rule). The 3b replicate (`…-heldout2-rep2`) against the baseline is reported as noise.
8. `shared` costs less than `rep` on the held-out pairs.

`score6.mts` evaluates 1–6 mechanically (`rule`, `verdict`); 7 and 8 are read from `score.py` and the usage logs.

If it passes: the design ships as the default (`UNSTALE_GUIDE_SHARED=0` restores the per-package prompts). If any
condition fails: nothing in `central/src` changes; the eval is recorded.

## Budget

Gateway cap **$3.00** across every slice 6 log (provider-reported cost; `run6.mts` refuses a call whose worst case
would pass it), Jev **$0.50**. Projection from the production log: held-out `rep` ≈ $0.14 gateway + $0.12 Jev,
`shared` ≈ $0.04 + $0.02, dev and gold ≈ $0.10 together.

## Known limits

- The baseline is production's own output, not gold: agreement measures "no worse than asking again", and the gold
  check covers only a guide's own package (no labelled shared guide with sibling packages exists).
- Pairs within a unit share one guide (and, for `shared`, one extraction), so the pair bootstrap understates the
  spread; held-out has 5 units, too few to resample units. Per-unit numbers are reported.
- The AI SDK units dominate held-out records; NestJS adds a framework + CLI family.
- `rep` and `shared` are one run each; `rep` vs `base` is the only noise pair.
