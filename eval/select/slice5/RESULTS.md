# Slice 5 results: the same-or-new judge (step E), 16 October 2026

Pre-registration: `PREREG.md` (written before any held-out run). Runner `run5.mts`, scorer `score5.mts`; raw output in
`eval/select/out/slice5/` (gitignored: `summary.json`, `runs/*/answers.json` and `meta.json`, `usage.jsonl`).

## Decision

**Jev stays the judge.** No candidate meets both conditions of the rule (false-merge floor with guards on held-out, and
merge recall not significantly worse than Jev's):

- gpt-oss-20b, qwen3.8-flash and the embedding baseline meet the floor only at the strict thresholds fitted on dev, and
  there their recall is significantly below Jev's (McNemar p ≤ 3e-8; 26–78 items lost and none gained).
- deepseek-v4-flash (5.8 per 100) and Luna (2.4 per 100) miss the floor.
- gemini-3.1-flash-lite was aborted after the smoke: projected $1.29 against the $0.40 cap, with 862 reasoning tokens
  per request even at `reasoning_effort: none`. Its list price is also above Luna's.

Cost would not change the answer. Jev costs $0.0141 per technology-year (worst case, K = 8). gpt-oss-20b, the cheapest
chat model, costs $0.0131, so even at equal accuracy the saving would be about 7%. Never merging costs nothing and
leaves 22.7 duplicates per 100 records, a lower bound.

## Results (held-out: Nuxt, 204 items, plus the Next.js guide, 32 items; 197 items with an audited SAME pair)

Constants were fitted on dev (within-source plus the Prisma/NestJS guide pairs), then held-out was scored once. False
merges per 100 merges count DIFFERENT plus 0.5 × UNSURE. The interval is Clopper–Pearson 95% on the merges that were
DIFFERENT or UNSURE. Recall is capped (see "Evalism").

| Cand | Fitted SAME / CROSS / quote-skip | Judge-only false/100 | **Guarded false/100** [95% CI] | Merges | **Merge recall** | Dup/100 rec | Parse | $ this run (dev + HO) | Worst-case $/tech-year (mean R / max R) | 10k / 50k / 200k techs |
|---|---|---|---|---|---|---|---|---|---|---|
| **J1** Jev | 0.73 / 0.89 / 0.99 | 6.6 | **0.8** [0.3–4.8] (0 D, 3 U) | 178 | **175/197 = 88.8%** | 2.5 | 100% | $0.016 + $0.027 | $0.0141 / $0.135 | $141 / $707 / $2,827 |
| J2 Jev, repeat | same | 6.1 | 0.6 [0.1–4.1] (0 D, 2 U) | 173 | 171/197 = 86.8% | 3.0 | 100% | + $0.027 | same | same |
| J0 Jev, audit answers | 0.74 / 0.84 / 0.99 | 6.2 | 2.0 [0.9–6.4] (2 D, 3 U) | 179 | 174/197 = 88.3% | 2.7 | 100% | $0 (cache) | — | — |
| G20 gpt-oss-20b (low) | 0.85 / 0.99 / never | 8.4 (+6 unaudited) | 0.7 [0.0–3.7] (1 D) | 148 | 147/197 = 74.6% | 5.8 | 100% (1.01 calls) | $0.015 + $0.025 | $0.0131 / $0.125 (53 reasoning tok/req) | $131 / $655 / $2,622 |
| Q qwen3.8-flash (none) | 0.85 / 0.98 / never | 10.6 (+5) | 0.0 [0.0–2.4] | 149 | 149/197 = 75.6% | 5.5 | 100% | $0.070 + $0.122 | $0.0630 / $0.600 | $630 / $3,150 / $12,601 |
| DS deepseek-v4-flash (none) | 0.70 / 0.90 / never | 7.3 (+5) | **5.8** [4.1–12.6] (4 D, 6 U, 3 unaudited) | 171 | 158/197 = 80.2% | 4.5 | 100% | $0.052 + $0.090 | $0.0465 / $0.444 | $465 / $2,327 / $9,310 |
| L Luna (codex) | 0.92 / 0.97 / never | 3.6 | **2.4** [1.3–7.7] (2 D, 4 U) | 166 | 160/197 = 81.2% | 4.3 | 100% | plan (list price, prompt only: $0.108 + $0.186) | $0.0962 / $0.917 | $962 / $4,809 / $19,238 |
| EMB qwen3-embedding-0.6b cosine | 0.965 / 0.965 / 0.95 | 0.0 | 0.0 [0.0–3.7] | 99 | 99/197 = 50.3% | 11.3 | 100% | $0.0003 + $0.0004 | $0.0002 (R·(1+K) embeddings) | $2 / $11 / $45 |
| NM never merge | — | — | — | 0 | 0/197 | **22.7** (lower bound) | — | $0 | $0 | $0 |
| GF gemini-3.1-flash-lite | aborted after the smoke | | | | | | 5/5 | $0.012 | above Luna's list price | |

Notes on the cost columns:

- Cost is O(R·K·S). R is 114.6 per technology-year for the mean technology and 1,092 for the largest (`cost.mts`).
- $/request is measured on the held-out run (input, output, reasoning, and calls per request, so retries are included)
  and scaled to K = 8 by 8 / 7.52, the mean number of candidates per request.
- Jev's output is free.
- Luna is costed at the gateway list price for the prompt alone. Through `codex exec` the harness takes about 14k input
  tokens per request: $0.49 at list price for this slice.

**Paired comparison with J1 (held-out items)**

| Cand | Recall: items only J1 got / only the candidate got | McNemar p | Bootstrap 95% CI of the difference | False merges, McNemar p |
|---|---|---|---|---|
| J2 | 5 / 1 | 0.22 | −4.1 to 0 pts | 1.0 |
| J0 | 3 / 2 | 1.0 | −2.5 to +1.5 | 0.5 |
| G20 | 28 / 0 | 7e-9 | −19.3 to −9.6 | 0.63 |
| Q | 26 / 0 | 3e-8 | −18.3 to −9.1 | 0.25 |
| DS | 19 / 2 | 2e-4 | −12.2 to −4.1 | 0.002 (DS worse) |
| L | 18 / 3 | 0.0015 | −11.7 to −4.6 | 0.25 |
| EMB | 78 / 2 | 5e-21 | −44.7 to −31.0 | 0.25 |

**Per set, guarded at the fitted constants (false/100, recall)**

| Set | J1 | J2 | G20 | Q | DS | L | EMB |
|---|---|---|---|---|---|---|---|
| Nuxt (clean holdout) | 0.6, 160/177 | 0.3, 155/177 | 0.0, 146/177 | 0.0, 146/177 | 3.6, 144/177 | 1.0, 146/177 | 0.0, 99/177 |
| Next.js guide | 3.1, 15/20 | 2.9, 16/20 | 50 (1 of 2), 1/20 | 0.0, 3/20 | 23.7, 14/20 | 14.7, 14/20 | —, 0/20 |

**The pipeline's own constants (0.7 / 0.85 / 0.95), for reference.** Jev's pooled rate is 0.8 for J1 and 1.3 for the
audit answers; the Next.js guide set holds all of the latter's DIFFERENT merges. For the chat models, on Nuxt alone, it is 4.3 (G20), 5.4 (Q),
4.5 (DS) and 3.4 (L). Their probabilities are not calibrated like Jev's. At 0.7 they merge as
much as Jev does (recall about 165–171 of 177 on Nuxt) but with 2–4 DIFFERENT merges. The dev set has too few
DIFFERENT pairs (about 13 non-SAME merges) to find a threshold between the two regimes, so the fit jumps to 0.85+ and
recall collapses.

## Jev repeatability (two fresh held-out runs, empty caches)

- **Answers:** 109 of 236 requests got identical answers. Mean |Δp| per pair was 0.003 (95th percentile 0.02), and 7
  of 1,774 pairs crossed 0.7 between runs.
- **Decisions:** recall was 175 against 171 (McNemar p 0.22) and false merges per 100 were 0.8 against 0.6.
- **Run-to-run noise is as large as the floor.** The audit's Jev answers (J0), refitted on their own dev answers, give
  2.0 per 100 and miss the floor. Two fresh runs give 0.8 and 0.6. The fitted CROSS threshold moves too (0.84 from the
  audit answers, 0.89 from the fresh ones).

## Spend (this slice's own logs)

| Provider | Calls | $ |
|---|---|---|
| Vercel AI Gateway | 1,489 | **$0.392** (cap $1.50): qwen $0.195, deepseek $0.144, gpt-oss-20b $0.040, gemini smoke $0.012, embedding $0.0007 |
| Jev | 606 | $0.071 (cap $0.30) |
| Codex (plan) | 370 | $0 billed. List-price equivalent: $0.30 prompt only, $0.49 with the harness |

## Evalism concerns

- **Recall is capped by Jev.** Guide pairs exist only where Jev's p ≥ 0.5. Nuxt adds the guard-blocked and
  near-threshold pairs. Within-source holds only Jev's 83 merges. A candidate gets no credit for a SAME pair Jev scored
  low, so these numbers are recall within Jev's pair set, not judge recall. The cap biases the comparison toward Jev,
  and the never-merge rate of 22.7 per 100 is a lower bound.
- **Unaudited merges.**
  - Guarded, only DS made any (3). DS misses the floor on audited merges alone (4.2), so they were not adjudicated, and
    the table counts them as DIFFERENT.
  - Judge-only, G20, Q and DS also merge into candidates no audit read (6, 5 and 5). The judge-only column counts them
    as DIFFERENT.
- **Requests are fixed to Jev's path.** Every candidate is asked the request Jev's ingest built, over the store that
  Jev's own earlier merges shaped. A different judge would see different candidate sets downstream. Decisions are
  scored per item.
- **The guide set's snapshot exclusion.** Ingest stops a record that already took an item of a guide from taking a
  second one. The guide requests were built without that state, so `score5.mts` applies it in key order, as
  `eval/guides/rule_eval.py` does. **Deviation:** I added this after the first held-out scoring, because the scorer
  failed to reproduce the published guide numbers. With it, the scorer reproduces both published results exactly: Nuxt
  168 merges at 0.6 per 100, and the Next.js guide's 18 merges with 1 D and 1 U, both on the cache answers at the
  pipeline's constants. The re-implemented `pick` also matches `match.ts pick` on every item outside the guide set (0
  differences). Without the fix every candidate's Next.js guide rate was higher, and Jev J1 sat at 1.9 per 100. The
  ranking did not change.
- **Holdout contamination.** Next.js is 62 of the 72 within-source dev pairs, so the Next.js guide holdout is
  technology-contaminated. Nuxt alone is clean, and the verdict is the same on Nuxt alone.
- **Power.** The floor of 1.0 per 100 cannot be certified for any candidate: with about 150–180 merges, the 95% upper
  bound is 2.4–4.8 even with zero or one false merge. One false merge moves the rate by about 0.6. Jev, G20 and Q
  cannot be separated on false merges (McNemar p ≥ 0.25). The recall differences are large and significant.
- **Fitting.** Dev is small (109 SAME items and few DIFFERENT ones), and the 3-parameter grid prefers strict constants
  on ties. The chat models' recall loss is partly calibration that dev cannot resolve, not only judgement. A larger
  dev set with more near-threshold negatives is what would let a cheap model be fitted fairly.
- **No PyPI technology** in any set.
- **Exclusions** (not faithfully reconstructable): 11 within-source pairs (the cached p differs from the audit's) and
  10 guide pairs (3 NestJS, 3 Next.js, 4 Prisma: the rebuilt request is in no cache). Nuxt 0.

## Code state

- HEAD is `b042f5f`. `match.ts`, `thresholds.ts` and `classify/` are unmodified in the working tree.
- Another session's uncommitted changes are in `cli.ts`, `extract.ts` and `DECISIONS.md`. Matching uses none of them.
- Nothing in `central/src` was edited, and nothing was committed.
