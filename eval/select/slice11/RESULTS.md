# Slice 11 results: MiniMax M3.1 Flash with a fitted extract prompt (steps A+B)

20 October 2026. Pre-registration: `PREREG.md` (39d57e7, pushed before any held-out call). The r3 freeze and the
central implementation were pushed in 5588d87, before the held-out runs.

## Decision

**Rejected. Keep `vercel:openai/gpt-6-luna`, `low`, two calls, flex.** `central/src` is unchanged. The implementation
(MiniMax primary with a gpt-6-luna fallback, per-model prompt, cache-compatible lookup, tests) is kept as
`design.patch`.

- DEV: r3 reaches 59/61 required and 88/96, level with gpt-6-luna `low`.
- H1 and H2 (secondary) pass slice 3b's rule.
- **P (primary) fails.** Read per package, MiniMax keeps far more of a shared AI SDK guide than gpt-6-luna does: 1,711
  records against 1,110 base and 1,126 for the Luna replicate. Precision against current is −22.4 points relative to the
  replicate, and F1 is −26.5.
- **Gold fails by about one group.** Required recall on H2's three guides is −5.8 against a 5-point margin. The Luna
  replicate itself scores −9.6 on that check.
- Load is not the obstacle: 200 calls ran at concurrency 40 with zero 429s, about 53 calls/minute.

## DEV (gate: required fetched ≥ 56/61, in fetched sources ≥ 83/96, ≤ 1/12 failed chunks)

| Arm | Extract prompt sha | Required fetched | In fetched sources | Failed chunks | Records | Ungrounded | Wall | 429s |
|---|---|---|---|---|---|---|---|---|
| gpt-6-luna `low` (3b gate rebuild, incumbent) | `68e134fe` | 59 | 87 | 0 | — | 2.2% | — | — |
| MiniMax, production prompt (slice 10) | `68e134fe` | 55 | 86 | 0 | 441 | 6.8% | 237 s | 0 |
| MiniMax r1: evidence = the stating line | — | 53 | 86 | 0 | 453 | 1.5% | 162 s | 0 |
| MiniMax r2: r1 + "copy a link as its text" in the field | `87e52604` | 55 | 89 | 0 | 432 | 0.7% | 178 s | 0 |
| **MiniMax r3**: r2 + the link rule after the task, with a neutral example | **`2f578d1b`** | **59** | **88** | 0 (1 unparseable, retried) | 418 | 2.9% | 217 s | 0 |

- r1 fixed slice 10's three MiniMax-only misses: Prisma's ES module line, the Node row of the minimum-versions table, and
  Next's custom-webpack failure. It then copied markdown link URLs into its new statement quotes
  ("All [parallel route](/docs/…) slots…"), which no longer read as the page reads, and lost four others.
- r2's field-level instruction was not followed. r3's restated rule was followed: 7 of 198 guide quotes carry a link,
  against 30 in r1.
- `locate` (`extract.ts`, in `design.patch`; the DEV and held-out runs used it) folds markdown links (`[text](url)` → `text`) on both sides, so a
  link-free quote still grounds. This changes no quote, only the `grounded` flag and section of quotes copied that way.
- **Frozen: r3** (it equals gpt-6-luna `low`'s 59/61 and has the most required hits). Its template sha `2f578d1b…` is
  pinned in `design.patch`'s `llm-fallback.test.ts` against `extractPromptFor`.

## Held-out (one look, r3)

| Set | Metric (baseline) | MiniMax r3 − baseline, 95% CI | Margin | Luna replicate − baseline | Pass |
|---|---|---|---|---|---|
| **P** (AI SDK 4–7 guides, 42 pairs; vs production `base`, relative to Luna `rep`) | F1 vs current (rep 84.1) | 57.6: **−26.5** (−38.6…−15.7) | ≥ −3 | — | **no** |
| | Recall vs current (rep 79.3) | 85.9: +6.7 (−3.3…+16.3) | ≥ −5 | — | yes |
| | Precision vs current (rep 78.2) | 55.8: **−22.4** (−28.6…−17.5) | ≥ −5 | — | **no** |
| | Records (base 1,110) | 1,711: **+54.1%** (rep +1.4%) | ±10% | — | **no** |
| | Terms Jaccard (rep 47.6) | 41.0: **−6.6** | ≥ −5 | — | **no** |
| | Failed pairs | 0 of 42, 0 fallbacks in 179 calls | ≤ 1 | — | yes |
| H1 | Pooled recall excl. unsure (66.3) | +7.0 (+1.7…+12.3) | ≥ −5 | +1.2 | yes |
| | Macro recall excl. unsure (91.9) | −0.8 (−7.0…+3.9) | ≥ −5 | −0.3 | yes |
| | Breaking recall (82.9, n 35) | +0.0 (−25.0…+10.9) | ≥ −5 | +2.9 | yes |
| | Precision (82.0) | −4.4 (−8.2…+0.5) | ≥ −10 | −0.8 | yes |
| H2 | Required recall excl. unsure (88.7) | +0.0 (−8.2…+6.7) | ≥ −5 | −3.6 | yes |
| | Breaking recall (86.4) | +1.4 (−7.5…+8.4) | ≥ −5 | −2.5 | yes |
| | Precision (84.8) | −6.1 (−12.5…+0.4) | ≥ −10 | −1.1 | yes |
| **Gold** (H2's 3 guides) | Required recall excl. unsure (91.3, n 104) | **−5.8** (−18.3…+6.4) | ≥ −5 | −9.6 | **no** |
| | Breaking recall (88.1) | −4.8 (−18.6…+8.5) | ≥ −5 | −7.1 | yes |
| | Precision (80.7) | +0.5 | ≥ −10 | −1.1 | yes |

Records: H1 259 (baseline 222), H2 493 (441). Ungrounded quotes: H1 9.3%, H2 1.0%. No chunk failed, nothing was
truncated, and there were no 429s.

**Why P fails.** Per unit (base / Luna rep / MiniMax): 4.0 23 / 25 / 17; 5.0 237 / 236 / 375; 6.0 83 / 92 / 196; 7.0
767 / 773 / 1,123. The extract prompt filters by "a developer using this technology". gpt-6-luna applies that filter
per package and reproduces it run to run (rep F1 84). MiniMax applies it weakly: provider packages keep the core `ai`
changes of a shared guide. The extra records are not wrong changes, but production would attach them to every sibling
package. This is the over-inclusion slice 6 measured for the shared design, from the other direction. Fixing it would
need a relevance revision fitted on this set, which is now looked at.

## Load (free tier, 200 calls, DEV prompts on r3, concurrency 40, no cache)

| Calls | Completed | 429s | Exhausted | Wall | Calls/min | Latency p50 / p95 / max | Output tok/s per stream |
|---|---|---|---|---|---|---|---|
| 200 | 200 | 0 | 0 | 227 s | **52.8** | 30 / 72 / 103 s | 147 |

**It sustains the load:** at least 40 calls/minute with at most 1% exhausted. Production's limit of 5 calls in flight
would give only about 6 a minute at these latencies, so `design.patch` adds `UNSTALE_EXTRACT_CONCURRENCY` for the
primary. The held-out runs, about 440 more calls with three runs concurrent, saw no 429s either. That is one afternoon
on an endpoint with unpublished limits.

## Cost

The slice's Vercel spend was **$0.00**: 350 logged calls, all MiniMax, with no fallback triggered. There were also two
one-word probes. Had MiniMax passed, extraction would have cost about $0/yr at 20k technologies, plus gpt-6-luna for the
fallback share (0 of 179 calls in P). As it is, gpt-6-luna flex stays at **$102/yr** on the production replay and
$192/yr in the worst case.

## Files

- `run3.mts` revisions: `slice3/addenda.ts` (`REVISIONS`, `mm-r1`…`mm-r3`).
- `run11.mts`: P through the production path; needs `design.patch`.
- `load11.mts`: the burst.
- `gold11.py`: the H2 guides-only check.
- `design.patch`: `llm.ts` (primary/fallback chain, per-model prompt, every model's cache read before a call, the model
  in the cache entry and the usage log, `UNSTALE_EXTRACT_FALLBACK`, `UNSTALE_EXTRACT_CONCURRENCY`, and the classifier
  pinned to gpt-6-luna), `extract.ts` (`extractPromptFor`, r3's text, and `locate` folding markdown links), and tests
  (`llm-fallback.test.ts`; central's suite passed 488/488 with it applied).
- Outputs (gitignored): `out/slice11/`, and `out/slice6/heldout/{base,rep,mm}` with `score-mm.md`.
