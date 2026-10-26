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

## Round 2 and hill-climb (25 October 2026, step D only; PREREG.md addendum of the same date)

**Decision: keep Jev for step D. No arm passes the floor; no production change, no switch PR.**

### Evalism check (before any model change)

- **Not a scorer, mapping or input bias.** Both candidates get the same request (`labelQuestions()`, byte-equal to
  v1) and the same mapping (`actionable` = surface argmax ≠ `runtime_internal`); 233/233 answered by each, so no
  parsing default applies. The gold `actionable` uses the same `runtime_internal` definition. Scorer unchanged.
- **Round 0 reproduced exactly.** The Snap 1.1 runs were no longer on disk; re-run with the same command, every
  round 0 metric is identical (Snap is deterministic).
- **The gap is the gold rule R1.** On the 73 gold-actionable H1 records: both hit 53, both miss 10, Jev only 9, Snap
  only 1. All 9 Jev-only hits are gold-breaking records that are actionable through adjudication rule R1 ("breaking
  implies actionable"), which no candidate's question states. Breakdown:
  - 4 behaviour_change (zod record keys, E.164 regex, z.base64 whitespace; typer-slim now requires rich);
  - 3 removal (typer-cli and typer-slim dropped, Python 3.9 dropped);
  - 1 security (base64 whitespace), 1 default_change (`FORWARDED_ALLOW_IPS` now trusts ::1).
  - Snap's argmax was `runtime_internal` on all 9 (p 0.48 to 0.87), the runner-up being code_api 6 times,
    configuration once and other once. Jev chose code_api 5, configuration 2, command_line 1 and types_only 1.
- On the 160 gold-not-actionable records, Jev false positives 43 and Snap 36 (aP 59.0 and 60.0).

### Arms (Snap at its dev-fitted thresholds; Jev under the same request at its own; Jev X1/X2 are fresh 1.14 runs)

| Arm | Fit B/N (Jev; Snap) | H1 actionable R, Jev → Snap (diff, CI) | H1 actionable P, Jev / Snap | H2 breaking P, Jev @0.5 → Snap (diff, CI) | Floor |
|---|---|---|---|---|---|
| Round 0 (v1) | 0.05/0.10; 0.05/0.10 | 84.9 → 74.0 (−11.0 [−19.2, −2.7]) | 59.0 / 60.0 | 94.5 → 85.5 (−9.0 [−13.9, −5.2]) | fail |
| X1: runtime_internal reworded | 0.10/0.10; 0.15/0.10 | 89.0 → 72.6 (**−16.4 [−26.0, −6.8]**) | 59.1 / 63.1 | 92.5 → 90.1 (**−2.4 [−4.6, −0.6]**) | fail (H1 actionable, H2 P) |
| X2: actionable asked directly | 0.10/0.10; 0.05/0.10 | 93.2 → 53.4 (**−39.7 [−50.7, −28.8]**) | 46.3 / 97.5 | 92.5 → 85.5 (**−7.0 [−11.7, −3.5]**) | fail (H1 actionable, H2 P) |
| X3: R1 mapping (no calls) | 0.05/0.10; 0.05/0.10 | 97.3 → 100.0 (+2.7 [0, +6.8]) | 50.0 / 54.1 | 94.5 → 85.5 (**−9.0 [−13.9, −5.2]**) | fail (H2 P only) |

- **Other floor metrics passed in every arm.** H1 breaking recall: Snap ≥ Jev in every arm. H1 benefit-vs-none
  recall: within 1 point. change_type: within 1 point, CI spanning 0. H2 breaking recall: Snap ahead.
- **X1:** Snap's actionable R moves −1.4 (same model, wording only). Jev 1.14 under X1 is +4.1 against its 1.13 v1 baseline, with version and wording confounded. Snap's fitted `BREAKING_P` moves to 0.15
  and H2 precision almost passes (upper CI −0.6).
- **X2:** the direct question makes Snap conservative (aR 53.4, aP 97.5) and Jev liberal (aR 93.2, aP 46.3). The
  ninth question is a second request per record: Jev +21% input, Snap +15%.
- **X3:** this mapping closes the actionable gap. The remaining failure is H2 breaking precision at Snap's dev-fitted
  `BREAKING_P` 0.05. That is a threshold failure, not an actionable one. At 0.5 (descriptive, not a floor arm):
  - Snap H2 P 93.1 against 94.5, CI spanning 0;
  - H1 actionable R 95.9 against Jev's 97.3 at its fit.
  
  Round 1's precision-capped fit (D1) lost H1 breaking recall, so no dev-fitted `BREAKING_P` passes both H1 and H2.
- **Cost (input as billed, $/tech-year mean):**

  | | Jev | Snap | Snap vs Jev |
  |---|---|---|---|
  | X1 | 0.0103 | 0.0074 | −28% |
  | X2 | 0.0125 | 0.0083 | −33% |
  | X3 | as round 0 | as round 0 | −27% |

- **Held-out looks for Snap:** H1 3 (round 0, D1, round 2), and H2 the same. There are 3 arms in round 2, and the
  levers were chosen after the H1 miss inspection (PREREG addendum).
- **Found on the way:** Jev 1.14 under X1 has H2 breaking R 96.1 at 0.5, against 90.0 for its v1 1.13 baseline.

### Rejected

- **Changing the scorer:** R1 predates both runs and applies to both candidates. It is a definitional gap in the
  request, not a bias in the scorer.
- **Adopting X3 at 0.5:** not dev-fitted, and the floor is at fitted thresholds.
- **A third round:** the 2-round cap is reached.

### Spend (round 2)

| | Cost | Runs |
|---|---|---|
| SubQ | $0.199 | round 0 re-run $0.063, X1 $0.064, X2 $0.072 |
| Jev | $0.197 | X1 $0.089, X2 $0.108 |
| **Total** | **$0.40** | |

Usage: `out/slice4/usage.jsonl`.

```
cd central
npx tsx ../eval/select/slice4/run4.mts --cand subq --subq-model subq-snap-1.1 --split dev|heldout|heldout2 [--qv x1|x2]
npx tsx ../eval/select/slice4/run4.mts --cand jev --split dev|heldout|heldout2 --qv x1|x2
../eval/select/out/venv/bin/python ../eval/select/slice14/analyze_d.py [--suffix=-qx1 | --suffix=-qx2 --act x2 | --act x3]
```
