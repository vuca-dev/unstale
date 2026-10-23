# Slice 14 results: SubQ Snap 1.1 for steps D and E

22 October 2026, under `PREREG.md` (written before any 1.1 call; rounds pre-registered before they ran).
Model: `subq-snap-1.1` (`/v1/models`), $0.04 per M input, output free (subq.ai/pricing; `prices.json`).

## Decision

**Keep Jev for both steps. No production change.**

- **Step D fails the floor.** Actionable recall on H1 is 74.0 against Jev's 84.9 (−11.0 pts, CI [−19.2, −2.7]).
  Against Jev 1.14 it is −12.3 pts (CI [−20.5, −4.1]). Snap would otherwise be 27% cheaper and fully deterministic.
- **Step E fails the floor by a wide margin.** To hold false merges ≤ 1.0 per 100 on dev, the fit needs SAME_P 0.97, and
  the floor is still not reached. Held-out recall is then 26.9% against Jev's 88.3% (McNemar p 4e-34). It is 27% cheaper.
- **What 1.1 changed compared with the preview:** within-source DIFFERENT pairs now sit low (dev median p 0.48,
  preview: high). The failure has moved to guide-vs-notes DIFFERENT pairs (median 0.985) and to under-confident
  within-source SAME pairs (median 0.91 against Jev's 0.99).
- **Hill-climb:** 2 rounds allowed, 1 run, 0 adopted. D1 (precision-capped BREAKING_P plus a runtime_internal
  threshold matched to Jev's dev rate) fails H1 breaking recall. E1 (without the cross-kind sentence) does not help.

## Step D (H1 233 records; H2 347 records; Snap at its dev-fitted thresholds)

| Held-out | Jev v1 | **Snap 1.1, round 0 (0.05 / 0.10)** | D1 (0.75 / 0.10, τ 0.55) |
|---|---|---|---|
| H1 breaking R (Jev fitted 0.05 / 0.10) | 93.1 | 100.0 (+6.9 [0, +17.2]) | 75.9 (**−17.2 [−31.0, −3.4]**) |
| H1 benefit-vs-none R | 99.2 | 99.2 (0) | 99.2 |
| H1 actionable R | 84.9 | **74.0 (−11.0 [−19.2, −2.7])** | 76.7 (−8.2 [−16.4, 0]) |
| H1 breaking P / change_type acc | 38.6 / 82.0 | 43.3 / 81.5 | 95.7 / 81.5 |
| H2 breaking R / P (Jev at 0.5) | 90.0 / 94.5 | 100.0 / **85.5 (−9.0 [−13.9, −5.2])** | 88.3 / 95.8 (both CIs span 0) |
| Floor | — | **fail** (H1 actionable, H2 precision) | **fail** (H1 breaking, actionable > 5 pts) |
| Input tokens / record, $ / tech-year (mean; largest) | 2,074, $0.0100; $0.095 | 1,580, **$0.0072; $0.069 (−27%)** | same |

- **At 0.5 (descriptive):** Snap's H2 passes (R 94.3, P 93.1). Its H1 benefit recall is 84.3 (Jev at 0.5: 85.1).
  Actionable stays at 74.0 at every breaking or benefit threshold, so no threshold choice passes.
- **Repeatability (second fresh H1 run):** Snap returns identical probabilities on 233/233 records. Jev's two runs
  (16 October, 1.13; today, 1.14) change 40 records' mapped labels at 0.5. That is a model update, not run-to-run noise.

## Step E (Q8: production wording and floor 0.60; held-out 236 requests, 197 SAME items)

| | Jev 1.14 Q8 (fresh) | **Snap 1.1 Q8** | E1: no cross sentence |
|---|---|---|---|
| Fitted same / cross / quote | 0.82 / 0.91 / 0.99 | 0.97 / 0.99 / 0.95 | 0.97 / 0.98 / 0.95 |
| Dev recall, false per 100 | 102/109, 1.0 | 50/109, **2.0** (floor not reachable) | 48/109, 0.0 |
| HO guarded false per 100 | 0.8 (0 D, 3 U) | 0.9 (0 D, 1 U) | 0.9 |
| **HO recall** | **88.3%** | **26.9%** (123 lost, 2 gained; p 4e-34) | 26.4% (p 2e-34) |
| At production 0.87 / 0.87 / 0.95 (descriptive) | 91.9%, **2.7 per 100** (3 D, 4 U) | 80.2%, 4.2 per 100 | — |
| Input tokens / request; $ / tech-year (mean; largest) | 1,591; $0.0081; $0.078 | 1,208; **$0.0059; $0.056 (−27%)** | 1,183; $0.0058 |
| Repeatability (second HO run, 1,033 questions) | 83% identical, mean \|Δp\| 0.0048, max 0.23 | 100% identical | — |

## Found on the way (not this slice's decision)

- **Jev moved to 1.14** (`jev-latest` serves `jev-1.14.0`; every stored baseline was 1.13). At production's step-E
  constants (SAME_P_SHORT 0.87), Jev 1.14's held-out guarded false merges are **2.7 per 100**, above the 1.0 floor.
  On 17 October, with 1.13, the figure was 0.8. Refitted on dev, the constants are 0.82 / 0.91 / 0.99, which gives
  0.8 per 100 at 88.3% recall. **This is worth a follow-up refit with a held-out confirmation.**
- **The `score5.mts` sanity check** (its re-implemented `pick` against match.ts at the pipeline's constants) now differs
  on 4 of 365 items, because the guards have changed since slice 5. It applies to every candidate in the same way.

## Evalisms

- Step D's Jev v1 baselines are 1.13 (16 October). H1 was re-checked against 1.14, with the same verdict. Dev and H2
  were not re-run on 1.14.
- Step E recall is within Jev's pair set (slice 5), which favours Jev. The gap (−61 pts) is far beyond that bias.
- H2 has 347 records after the exclusions of slice 4's "Confirm H on H2", not the 441 written in the pre-registration.

## Spend

SubQ $0.126 (all 1.1 runs, with retries after HTTP 429). Jev $0.061: Q8 dev and two held-out runs $0.041, D H1 repeat
$0.021. Total **$0.19**. Usage: `out/slice4/usage.jsonl`, `out/slice5/judge2-usage.jsonl`, `out/slice5/floor-usage.jsonl`.

## Reproduce

```
cd central
npx tsx ../eval/select/slice4/run4.mts --cand subq --subq-model subq-snap-1.1 --split dev|heldout|heldout2 [--tag r2]
npx tsx ../eval/select/slice5/floor.mts --scores
npx tsx ../eval/select/slice5/judge2.mts --arm Q8 --floor 0.6 --cand subq --subq-model subq-snap-1.1 --split dev|heldout [--no-cross] [--tag r2]
npx tsx ../eval/select/slice5/score5.mts --floor 0.6 --base Q8 --subq Q8 --subq-tag 1.1[-nocross] [--fixed 0.87,0.87,0.95]
../eval/select/out/venv/bin/python ../eval/select/slice14/analyze_d.py [--d1]
```
