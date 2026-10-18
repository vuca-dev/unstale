# Slice 3d results: reasoning effort by chunk size (arm E)

17 October 2026. Pre-registration: `PREREG.md`, "Slice 3d", arm E, unchanged. Runner `run3d.mts` (`run`, then `score`).
Setup under test: `vercel:openai/gpt-6-luna`, two calls, flex tier, reasoning `none` for both calls on chunks under
1,000 characters, against the production store's cached `low` answers.

## Decision

**Rejected. Keep `low` on every chunk.** Reasoning `none` fails two of the five pre-registered conditions: record
agreement and label terms. It saves 40% of A+B dollars on short chunks, or about 16% of all A+B (the replay estimate),
but it changes which records and terms come out by more than a second `low` run does. Arm P (packing short notes) was
gated on E being decided. It is now unblocked, but it was not run here.

| Condition (rule) | `none` vs cached | `low` replicate vs cached | Pass |
|---|---|---|---|
| Record F1 no more than 3 points below the replicate's | 93.4 (CI 91.3…95.3), n = 400 | 97.6 (CI 95.6…99.1), n = 150 | **No** (−4.2) |
| F1 CI not wholly below the replicate's F1 | upper bound 95.3 | 97.6 | **No** |
| Records per chunk within ±10% | 588 vs 590 (−0.3%) | 242 vs 241 (+0.4%) | Yes |
| Terms Jaccard (matched records) no more than 5 points below the replicate's | 35.7 (556 matched) | 46.0 (235 matched) | **No** (−10.3) |
| Parse failures ≤ 2% | 0 of 400 | 0 of 150 | Yes |

**Paired check:** on the replicate's 150 chunks, F1 for `none` minus the replicate is −3.3 (CI −6.5…−0.2). The paired
CI also lies wholly below 0.

## Other measurements

- **`[]` agreement with cached:** `none` 96.0%, replicate 99.3%. On short notes, `none` more often disagrees with `low`
  about whether a note has any change at all.
- **Label fields, share of records non-empty (arm / its cached answers):**

  | Field | `none` | `low` replicate |
  |---|---|---|
  | `requires` | 2.6 / 5.1 | 3.3 / 7.5 |
  | `replaces` | 4.4 / 5.3 | 5.0 / 5.4 |
  | `conditions` | 6.5 / 5.4 | 7.4 / 5.0 |

  A fresh `low` run also drops `requires`, so that difference is mostly noise.
- **Cost on the same 150 chunks** (provider-reported, flex): `none` $0.0221, `low` $0.0369, −40%. The saving is
  −32% on extract and −46% on label. `none` returns no reasoning tokens. `low` spent 21.6k reasoning tokens on extract
  and 36.4k on label.

## Set and method

- **Population:** 3,542 eligible chunks. A chunk is eligible when it is the only chunk of its note, has under 1,000
  characters, is not content-free (the pipeline skips those since #30), and has a cached extract answer under the
  pipeline's cache key (prompt byte-identical to production's), plus a label answer when the extract answer is non-empty.
- **Sample:** seed 20261017, at most 5 chunks per technology, so 400 chunks from 175 technologies, mean 404 characters.
  The replicate is the first 150 in sample order.
- **Agreement:** records are matched one to one: first by grounded quotes whose spans overlap in the folded notes,
  then by the same subject after case folding. F1 is taken per chunk; two empty answers count as 1. The bootstrap uses
  2,000 resamples over chunks (one note each).
- **Labels:** `none`'s label call runs on its own records, as the pipeline would. Terms are compared after `toIncoming`.

## Spend

- **Run:** $0.0919 provider-reported, from `out/slice3d/usage.jsonl` (cap $0.20). The `none` arm cost $0.055 and the
  replicate $0.037; the pre-registered estimate was $0.12.
- **Gateway credit:** $3.40 before the run, $3.27 after. The balance fell $0.137, more than the run's log. The
  difference is presumably other gateway traffic in the same window; it cannot be separated here.
