# Slice 15 results: step E constants under Jev 1.14

22 October 2026, under `PREREG.md` (committed and pushed before the fit and the decision run).

## Decision

**Don't ship. The pre-registered refit holds the false-merge floor only by losing significant recall.** Production
stays at SAME_P_SHORT / CROSS_SAME_P_SHORT 0.87 and QUOTE_GUARD_BELOW 0.95. The open trade-off is below, for the user.

- **The drift is confirmed on unseen answers.** Fresh Jev 1.14 run `j2-Q8-heldout-r3` at production's constants: 2.4
  guarded false merges per 100 (3 D, 3 U) at 91.4% recall. The first 1.14 run gave 2.7. With 1.13 it was 0.8.
- **The fit.** The slice 5 objective on the 1.14 dev run, with the quote guard held at 0.95, cannot reach ≤ 1.0 on dev.
  Its best is 1.2 at 0.97 / 0.97.
- **On r3 (the one look), at 0.97 / 0.97:** 0.9 false per 100 (1 D, 1 U), recall **83.8%** (165/197) against 88.8%:
  10 items lost, 0 gained. **McNemar p 0.002**, Δ CI −7.6 to −2.0 pts. That fails the recall condition.

## Trade-off on r3 (descriptive except the first row)

| Constants same / cross / quote | Dev false per 100 | HO merges | **HO guarded false per 100** | **HO recall** |
|---|---|---|---|---|
| 0.97 / 0.97 / 0.95 (pre-registered fit) | 1.2 | 167 | 0.9 (1 D, 1 U) | 83.8% (p 0.002 vs 88.8%) |
| **0.87 / 0.87 / 0.95 (production)** | 3.3 | 186 | **2.4** (3 D, 3 U) | 91.4% |
| 0.90 / 0.90 / 0.95 | 1.9 | 183 | 1.4 | 90.9% |
| 0.93 / 0.93 / 0.95 | 2.0 | 176 | 1.1 | 87.8% |
| 0.87 / 0.87 / 0.99 | 2.4 | 179 | 2.0 | 88.3% |
| 0.82 / 0.91 / 0.99 (slice 14's free-quote dev fit) | 1.0 | 176 | **0.9** (0 D, 3 U) | **87.8%** |

- **The only setting that holds the floor without the recall loss raises QUOTE_GUARD_BELOW to 0.99.** That constant is
  shared with advisories, docs and lineage requests, which no set here measures, and it was seen on r1 before this
  pre-registration. Shipping it needs a set covering those request kinds, or a short-rules-only quote constant with
  its own held-out look.
- **Rows other than the first are descriptive.** They are post-hoc on these items; at most one look was pre-registered.
- **Jev 1.14 repeats itself across r1 and r3.** Every decision above is the same on both runs.

## Step D under Jev 1.14 (report only, production 0.5)

| | Jev 1.13 | Jev 1.14 | Paired Δ (95% CI) |
|---|---|---|---|
| H1 breaking R / P | 82.8 / 75.0 | 89.7 / 76.5 | R +6.9 [0, +17.2] |
| H1 benefit-vs-none R | 85.1 | 85.1 | 0 |
| H1 actionable R | 84.9 | 86.3 | +1.4 [−5.5, +6.8] |
| H2 breaking R / P | 90.0 / 94.5 | 96.1 / 92.9 | R **+6.1 [+3.2, +8.7]**; P −1.7 [−3.1, −0.4] |

No floor metric got worse. Step D thresholds stay as they are.

## Spend

Jev $0.047: E r3 $0.016, D H2 $0.031. No other provider.
