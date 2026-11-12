# Slice 19 results: SubQ Snap 1.2 for steps D and E

11 November 2026, under `PREREG.md` (each part and revision pushed before it ran or was scored).
Model: `subq-snap-1.2` (`/v1/models`), $0.04 per M input, output free (subq.ai/pricing; `prices.json`).

## Decision

- **Snap 1.2 is the no-Jev matcher (step E).**
  - It is offered as "Snap + <key>", ahead of the key alone.
  - Asked with the longer rules and 4 candidates, it beats gpt-6-luna on two sets it had not seen: 86.3% and 89.1% of
    merges against 80.2% and 85.1%, both significant. False merges stay under the floor: 0.3 and 0.4 per 100.
  - It costs $0.0059 per tech-year, against gpt-6-luna's $0.020 or more.
- **Labels (step D) stay on gpt-6-luna without Jev.** Snap leads on every H1 recall. It fails only H2 breaking precision
  at its fitted threshold (−3.4, CI wholly below 0).
- **Jev stays first** for both steps (part 1: Snap fails both against Jev).

Part 1 is against Jev. Part 2 is Snap as the fallback, against gpt-6-luna (the user's bar).

## Part 2: Snap 1.2 against gpt-6-luna (no-Jev fallback)

### Step D (H1 233, H2 347; gpt-6-luna read on its choices with the v1 mapping, `choice_openai_gpt-6-luna-*`)

| | gpt-6-luna | **D-X3** (v1, 0.10 / 0.10) | **D-W** (`h`, 0.10 / 0.10; dev winner 0.956 against `v3` 0.936) |
|---|---|---|---|
| H1 breaking R | 86.2 | 96.6 (+10.3 [0, +24.1]) | 96.6 (+10.3 [0, +24.1]) |
| H1 benefit-vs-none R | 96.7 | 99.2 (+2.5 [0, +5.8]) | 99.2 (+2.5 [0, +5.8]) |
| H1 actionable R | 89.0 | 95.9 (+6.8 [−1.4, +15.1]) | 95.9 (+6.8 [−1.4, +15.1]) |
| H1 change_type acc | 85.0 | 85.4 (+0.4 [−4.3, +5.2]) | 83.3 (−1.7 [−6.4, +3.4]) |
| H2 breaking R | 92.6 | 99.6 (+7.0 [+4.3, +11.5]) | 99.6 (+7.0 [+4.3, +11.5]) |
| H2 breaking P | 92.2 | **88.8 (−3.4 [−6.2, −1.1])** | **88.4 (−3.8 [−6.6, −1.4])** |
| Verdict | — | **fail** (H2 P) | **fail** (H2 P) |
| $ / tech-year | $0.0261 | $0.0072 | $0.0072 |

- **At 0.5 (descriptive):** H2 precision passes (94.9, +2.7), but H1 breaking recall falls to 72.4, against gpt-6-luna's 86.2.
- No arm passed stage 1, so the fresh label set (stage 2) was not run.

### Step E (slice 5 held-out: 236 requests, 197 SAME items; gpt-6-luna chat F8 at its fit 0.82 / 0.97 / 1.01)

| | gpt-6-luna F8 | Snap Q8 (part 1) | **Snap F8** | **Snap F4** |
|---|---|---|---|---|
| Fitted same / cross / quote | 0.82 / 0.97 / 1.01 | 0.95 / 0.96 / 0.95 | 0.94 / 0.97 / 0.95 | **0.61 / 0.93 / 0.95** |
| Dev recall, false per 100 | 103/109, 1.0 | 63/109, 0.0 | 61/109, 0.0 | 99/109, 1.0 |
| HO guarded false per 100 [95% CI] | 0.9 [0.4–5.3] | 0.4 | 0.0 [0.0–2.4] | **0.3 [0.0–3.2]** |
| **HO recall** | **80.2%** | 57.9% | 76.6% (23 lost / 16 gained, p 0.34) | **86.3%** (5 lost / 17 gained, **p 0.017**) |
| Duplicates per 100 records (Jev J1: 2.5) | 4.5 | — | 5.3 | **3.1** |
| Input tokens / request; $ / tech-year | 2,432 + 259 out; $0.0455 list | 1,208; $0.0059 | 2,329; $0.0109 | 1,263; **$0.0059** |
| Verdict | — | — | pass | **pass, best** |

- **Why the wording mattered:** the shorter rules (M8 / Q8) were chosen on Jev. On Snap they lose about a third of the merges.
  The longer rules at K = 4 recover them, and Snap's fitted SAME_P falls from 0.95 to 0.61. Its probabilities
  separate SAME from DIFFERENT once the full rules are stated.

### Step E fresh confirmation (slice 16's four technologies, 1,599 short-rules requests, 248 SAME items)

| | gpt-6-luna F8 | **Snap F4** |
|---|---|---|
| Answered | 1,594 | 1,599 |
| Merges | 229 | 240 |
| Guarded false per 100 [95% CI] (D, U) | 0.22 [0.0–2.4] (0, 1) | **0.42 [0.1–3.0] (0, 2)** |
| **Recall** | 85.1% (211) | **89.1% (221)**: 4 lost, 14 gained, **p 0.031** |

- **The set:** rebuilt by replaying `slice16/build.mts` against its recorded Jev answers, in a copy of the side store.
  It reproduced 746/749, 246/246, 285/291 and 836/866 decisions, with 110 live Jev calls. Short-rules requests were
  rewritten to each arm's form (`fresh16.mts`).
- **Reference:** `slice16/verdicts.json`, plus the 24 merges onto pairs it does not label, which I read blind to the
  arm (`adjudicated.json`): 23 SAME and 1 UNSURE. Nearly all restate one release-note bullet.
- **Passes:** false merges ≤ 1.0 per 100, and recall significantly above gpt-6-luna's, not just "not below".

### What ships (this PR)

- **Client (`local/cli`):**
  - A `SUBQ_API_KEY` route and a picker option "Snap + <key>". It is listed after the Jev options and before the key
    alone, and its flag is `--inference subq+env:OPENAI_API_KEY`.
  - The key writes and labels the records, and Snap judges same-or-new in the form it passed:
    `match_request_snap` (longer rules, first 4 candidates, no question floor) at `snap_bars` (0.61 / 0.93 / 0.95).
- **Picker row:** "Snap + OpenAI ≈ $1.90 … ≈ 11 in 100 breaking flags wrong, not 8", against $2.43 for OpenAI
  alone on 38 technologies. Labels are the key's, so the quality figure is the same; the details add about 1 more
  duplicate per tech-year, against 4.
- **Not measured, so kept as central's:**
  - Snap's lineage bar is central's 0.80.
  - Advisory, docs and lineage requests are asked in the same longer-rules form; the evaluation sets held release
    notes and upgrade guides only.
  - Snap + Codex is not offered: Codex labels and matching are not measured.

### Spend (part 2)

- SubQ $0.189: D dev ×2 $0.030, D-W held-out $0.026, E F8 and F4 $0.053, fresh F4 $0.081.
- Gateway gpt-6-luna $0.365 (fresh F8, flex).
- Jev about $0.01 (the replay's 110 calls).
- **Total about $0.56.**

```
cd central
npx tsx ../eval/select/slice4/run4.mts --cand subq --subq-model subq-snap-1.2 --split dev|heldout|heldout2 --qv h
../eval/select/out/venv/bin/python ../eval/select/slice14/analyze_d.py --arm subq-1.2 --price 0.04 --act x3 --base choice_openai_gpt-6-luna [--suffix=-qh]
npx tsx ../eval/select/slice5/judge2.mts --arm F8|F4 --cand subq --subq-model subq-snap-1.2 --split dev|heldout
npx tsx ../eval/select/slice5/score5.mts --judge2 --subq F8|F4 --subq-tag 1.2 --base GL --add "GL=vercel_openai_gpt-6-luna-dev,vercel_openai_gpt-6-luna-heldout"
UNSTALE_STORE=<side-store copy> npx tsx ../eval/select/slice16/build.mts --tech <id> [--allow-uncached]
npx tsx ../eval/select/slice19/fresh16.mts --cand subq --arm F4; npx tsx ../eval/select/slice19/fresh16.mts --cand luna --arm F8
npx tsx ../eval/select/slice19/fresh16-score.mts
```

## Part 1: Snap 1.2 against Jev

**Keep Jev first for both steps.** 1.2 is clearly better than 1.1 on both steps, but it still fails both floors against Jev.

- **Step D fails in every arm.** Round 0 fails H1 actionable recall (−9.6 pts) and H2 breaking precision. X3, the R1
  mapping, closes the actionable gap and fails only on H2 breaking precision at the fitted threshold. That is the same
  pattern as 1.1. The revision caps precision, which fixes H2 precision but costs 31 points of H1 breaking recall.
- **Step E holds the false-merge floor but loses recall.** At the dev-fitted constants (0.95 / 0.96 / 0.95), held-out
  guarded false merges are 0.4 per 100. Merge recall is 57.9% against Jev's 91.9% (McNemar p 2e-19). 1.1 reached 26.9%.
- **Cost and repeatability are unchanged from 1.1.** 1.2 is 27% cheaper per tech-year on both steps, and two fresh
  held-out runs gave identical answers on both steps (233/233 and 236/236).

### Step D (H1 233 records; H2 347 records; Jev v1 stored runs, 1.13)

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

### Step E (Q8: production wording and floor 0.60; held-out 236 requests, 197 SAME items)

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

### Evalisms

- **Jev baselines are the stored runs** (the user's call): D v1 is Jev 1.13 (16 October); E is `j2-Q8-heldout` (10
  November). The stored Jev E run itself makes 2.1 guarded false merges per 100 at its fit, above the 1.0 floor. That
  does not change the verdict, because 1.2's recall gap (−34 pts) is far outside Jev's drift between versions.
- The X3 arm has Jev under the same mapping (97.3 actionable recall), as in slice 14 round 2.
- Step D held-out looks for 1.2: 2 on H1 and 2 on H2 (D0 and D-X3 share one look; the revision is the second).

### Spend (part 1)

SubQ **$0.107**: step D $0.078 (smoke, dev, H1, H1 repeat, H2), step E $0.029 (dev, held-out, repeat). No Jev calls.
Usage: `out/slice4/usage.jsonl`, `out/slice5/judge2-usage.jsonl`.

### Reproduce (part 1)

```
cd central
npx tsx ../eval/select/slice4/run4.mts --cand subq --subq-model subq-snap-1.2 --split dev|heldout|heldout2 [--tag r2]
npx tsx ../eval/select/slice5/judge2.mts --arm Q8 --floor 0.6 --cand subq --subq-model subq-snap-1.2 --split dev|heldout [--tag r2]
npx tsx ../eval/select/slice5/score5.mts --floor 0.6 --base Q8 --subq Q8 --subq-tag 1.2
../eval/select/out/venv/bin/python ../eval/select/slice14/analyze_d.py --arm subq-1.2 --price 0.04 [--act x3] [--d1 --act x3]
```

`out/slice4/h2-units.json` is built by `slice4/build_h2_units.py`.
