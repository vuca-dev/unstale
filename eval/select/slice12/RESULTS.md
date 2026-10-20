# Slice 12 results: MiniMax M3.1 Flash for release notes only (steps A+B)

20 October 2026. Pre-registration: `PREREG.md` (c6e35a9). It was pushed, with the implementation, before any MiniMax
call on the set. There was one look. Scorer `score12.mts`, with output in `out/slice12/score-mm.md`.

## Decision

**Rejected. Keep `vercel:openai/gpt-6-luna`, `low`, two calls, flex, for every note.** `central/src` is back at
`origin/main`. The release-notes-only routing is kept as `design.patch`, which applies to `origin/main`; with it,
central's suite passed 491/491. The patch holds `UNSTALE_RELEASE_MODEL`, `UNSTALE_RELEASE_CONCURRENCY`, every model's
cache read before a call, the answering model and its role logged, and tests.

On fresh release notes, MiniMax finds what gpt-6-luna finds: recall, breaking recall and actionable recall all pass.
But it adds records. There are **+22.7% records** (rep −3.0%), precision is **−18.1** points, step B's terms Jaccard
is **−13.1**, and labels (D) and the judge (E) on its records agree less with production than a Luna replicate does,
with paired CIs below 0. So slice 11's guide failure was not specific to guides: MiniMax's weaker relevance filter
shows on long release notes too (LARGE stratum: 401 records against base 256, precision 53.6 against 88.7).

## Held-out (126 releases, 116 technologies, 938 base records; rep = fresh gpt-6-luna, mm = MiniMax r3 + fallback)

| Metric | rep vs base | mm vs base | mm − rep (paired 95% CI) | Margin | Pass |
|---|---|---|---|---|---|
| Recall | 87.3 | 88.3 | +1.0 (−3.2…+4.8) | ≥ −5, CI | yes |
| Breaking recall (197 base) | 90.4 | 86.3 | −4.1 (−11.2…+3.8) | ≥ −5, CI | yes |
| Actionable recall (643 base) | 88.0 | 88.5 | +0.5 (−4.0…+4.6) | ≥ −5, CI | yes |
| **Precision** | 90.0 | 71.9 | **−18.1 (−25.5…−9.6)** | ≥ −5, CI | **no** |
| **Records** (base 938) | 910 (−3.0%) | 1,151 (**+22.7%**) | | ±10% | **no** |
| **Terms Jaccard** | 47.2 | 34.1 | **−13.1** | ≥ −5 | **no** |
| **D breaking agreement** | 97.3 | 95.0 | −2.3 (**−3.8…−0.7**) | ≥ −3, CI | **no** |
| **D actionable agreement** | 96.3 | 94.0 | −2.4 (**−4.6…−0.0**) | ≥ −3, CI | **no** |
| **E outcome agreement** | 99.1 | 97.9 | −1.2 (**−2.8…−0.1**) | ≥ −3, CI | **no** |
| Failed releases | 0 | 0 | | ≤ 2 | yes |
| F1 (reported) | 93.2 | 87.1 | −6.1 (−10.7…−1.8) | | |
| D benefit / change_type (reported) | 95.4 / 91.3 | 90.0 / 88.2 | −5.4 / −3.2 | | |

| Stratum | Releases | Records base / rep / mm | Recall rep / mm | Precision rep / mm |
|---|---|---|---|---|
| MAJOR | 24 | 316 / 327 / 358 | 89.6 / 88.6 | 86.5 / 78.2 |
| LARGE | 12 | 256 / 221 / 401 | 76.6 / 84.0 | 88.7 / 53.6 |
| PYPI | 36 | 233 / 230 / 247 | 91.8 / 90.1 | 93.0 / 85.0 |
| NPM | 54 | 133 / 132 / 145 | 94.7 / 92.5 | 95.5 / 84.8 |

MiniMax answered all 254 of its calls, with no fallback, no 429, no truncation and no unparseable answer. D and E are
dragged down partly by the extra records' labels and partly by B: MiniMax also writes the label answer, and its terms
differ from production's.

## Spend share (step 1, `share12.py`)

Of the matched A+B gateway spend in October's production log, **release notes are 94.8%** (guides 4.9%, docs 0.3%).
Across 19 and 20 October they are 90.5%, and in the monitoring phase alone 53%. 21% of all gateway dollars could not be
matched to a chunk. At 20k technologies, A+B costs **$102/yr** (slice 3d replay, $192 worst case). Release notes on a
free model would have left about **$5–10/yr** at the overall mix, or **about $48/yr** at the monitoring mix. Rejected,
it stays at $102/yr.

## Spend

Vercel **$0.097** (the rep arm; MiniMax $0). Jev **$0.310** (base E $0.041; rep and mm D+E $0.268). Both are under
the $2.00 and $0.50 caps.

## Files

`inventory.mts` (chunks and their cached A and B usage), `share12.py`, `select12.py` and `set.json` (the frozen set),
`run12.mts`, `score12.mts`, `design.patch`. Outputs are gitignored, in `out/slice12/`. The state was restored
read-only from `catalog-state` (`state-20261020T173335Z-39461062144-1`).
