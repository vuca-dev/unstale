# Slice 19 results: SubQ Snap 1.2 for steps D and E

11 November 2026, under `PREREG.md` (pushed before any 1.2 call; the revision pushed before it was scored).
Model: `subq-snap-1.2` (`/v1/models`), $0.04 per M input, output free (subq.ai/pricing; `prices.json`).

## Decision

**Keep Jev for both steps. No production change.** 1.2 is clearly better than 1.1 on both steps, but it still fails both floors.

- **Step D fails in every arm.** Round 0 fails H1 actionable recall (−9.6 pts) and H2 breaking precision. X3, the R1
  mapping, closes the actionable gap and fails only on H2 breaking precision at the fitted threshold. That is the same
  pattern as 1.1. The revision caps precision, which fixes H2 precision but costs 31 points of H1 breaking recall.
- **Step E holds the false-merge floor but loses recall.** At the dev-fitted constants (0.95 / 0.96 / 0.95), held-out
  guarded false merges are 0.4 per 100. Merge recall is 57.9% against Jev's 91.9% (McNemar p 2e-19). 1.1 reached 26.9%.
- **Cost and repeatability are unchanged from 1.1.** 1.2 is 27% cheaper per tech-year on both steps, and two fresh
  held-out runs gave identical answers on both steps (233/233 and 236/236).

## Step D (H1 233 records; H2 347 records; Jev v1 stored runs, 1.13)

| Held-out | Jev v1 | Snap 1.1, round 0 (slice 14) | **Snap 1.2, D0 (0.10 / 0.10)** | **D-X3** (0.10 / 0.10) | **D-X3-D1** (0.65 / 0.10, τ 0.5) |
|---|---|---|---|---|---|
| H1 breaking R (Jev fitted 0.05 / 0.10) | 93.1 | 100.0 | 96.6 (+3.4 [0, +10.3]) | 96.6 | **62.1 (−31.0 [−48.3, −13.8])** |
| H1 benefit-vs-none R | 99.2 | 99.2 | 99.2 (0) | 99.2 | 99.2 |
| H1 actionable R (Jev, same mapping) | 84.9 (X3: 97.3) | 74.0 | **75.3 (−9.6 [−16.4, −4.1])** | 95.9 (−1.4 [−4.1, 0]) | **87.7 (−9.6 [−16.4, −2.7])** |
| H1 actionable P / breaking P / change_type acc | 59.0 / 38.6 / 82.0 | 60.0 / 43.3 / 81.5 | 67.1 / 58.3 / 85.4 | 64.2 / 58.3 / 85.4 | 66.0 / 94.7 / 85.4 |
| H2 breaking R (Jev at 0.5) | 90.0 | 100.0 | 99.6 (+9.6 [+5.6, +14.2]) | as D0 | **81.3 (−8.7 [−14.1, −3.2])** |
| H2 breaking P (Jev at 0.5) | 94.5 | 85.5 | **88.8 (−5.8 [−9.7, −2.4])** | as D0 | 95.9 (+1.4 [−1.1, +4.7]) |
| Floor | — | fail | **fail** | **fail** (H2 P) | **fail** (H1 bR, aR; H2 R) |
| Input tokens / record; $ / tech-year (mean; largest) | 2,074; $0.0100; $0.095 | 1,580; $0.0072; $0.069 | 1,580; **$0.0072; $0.069 (−27%)** | same | same |

- **At 0.5 (descriptive):** H2 passes (R 88.7, P 94.9, both CIs spanning 0), but H1 breaking recall drops to 72.4.
  No single `BREAKING_P` passes both H1 and H2.
- **What 1.2 changed compared with 1.1:** H1 breaking accuracy is +10.3 pts over Jev (CI wholly above 0), and the
  benefit set and change_type are both better. The actionable miss persists, and Snap's breaking probabilities still
  trade H1 recall against H2 precision at every dev-fittable threshold.

## Step E (Q8: production wording and floor 0.60; held-out 236 requests, 197 SAME items)

| | Jev Q8 (stored run) | Snap 1.1 Q8 (slice 14) | **Snap 1.2 Q8** |
|---|---|---|---|
| Fitted same / cross / quote | 0.87 / 0.87 / 0.95 | 0.97 / 0.99 / 0.95 | 0.95 / 0.96 / 0.95 |
| Dev recall, false per 100 | 105/109, 0.5 | 50/109, 2.0 | 63/109, 0.0 |
| HO guarded false per 100 [95% CI] | 2.1 (2 D, 4 U) [1.2–6.9] | 0.9 | **0.4 (0 D, 1 U) [0.0–4.7]** |
| **HO recall** | **91.9%** | 26.9% | **57.9%** (68 lost, 1 gained; p 2e-19) |
| At production 0.87 / 0.87 / 0.95, dev (descriptive) | 105/109, 1.9 | — | 95/109, 3.1 |
| Input tokens / request; $ / tech-year (mean) | 1,591; $0.0081 | 1,208; $0.0059 | 1,208; **$0.0059 (−27%)** |
| Repeatability (second HO run) | — | 100% identical | 100% identical |

- **The failure is under-confident SAME pairs.** Keeping dev false merges at or below 1.0 per 100 needs constants of 0.95 or more.
  At those constants 1.2 keeps only 63 of 109 dev merges.

## Evalisms

- **Jev baselines are the stored runs** (the user's call): D v1 is Jev 1.13 (16 October); E is `j2-Q8-heldout` (10
  November). The stored Jev E run itself makes 2.1 guarded false merges per 100 at its fit, above the 1.0 floor. That
  does not change the verdict, because 1.2's recall gap (−34 pts) is far outside Jev's drift between versions.
- The X3 arm has Jev under the same mapping (97.3 actionable recall), as in slice 14 round 2.
- Step D held-out looks for 1.2: 2 on H1 and 2 on H2 (D0 and D-X3 share one look; the revision is the second).

## Spend

SubQ **$0.107**: step D $0.078 (smoke, dev, H1, H1 repeat, H2), step E $0.029 (dev, held-out, repeat). No Jev calls.
Usage: `out/slice4/usage.jsonl`, `out/slice5/judge2-usage.jsonl`.

## Reproduce

```
cd central
npx tsx ../eval/select/slice4/run4.mts --cand subq --subq-model subq-snap-1.2 --split dev|heldout|heldout2 [--tag r2]
npx tsx ../eval/select/slice5/judge2.mts --arm Q8 --floor 0.6 --cand subq --subq-model subq-snap-1.2 --split dev|heldout [--tag r2]
npx tsx ../eval/select/slice5/score5.mts --floor 0.6 --base Q8 --subq Q8 --subq-tag 1.2
../eval/select/out/venv/bin/python ../eval/select/slice14/analyze_d.py --arm subq-1.2 --price 0.04 [--act x3] [--d1 --act x3]
```

`out/slice4/h2-units.json` is built by `slice4/build_h2_units.py`.
