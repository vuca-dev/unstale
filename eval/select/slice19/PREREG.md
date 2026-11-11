# Slice 19 pre-registration: SubQ Snap 1.2 for steps D and E

Written 11 November 2026, before any `subq-snap-1.2` call. Question: should production move step D (record labels)
and/or step E (same-or-new judge) from Jev to SubQ Snap 1.2? Snap 1.1 failed both floors (slice 14).

**Model and price.** `subq-snap-1.2` (`GET https://api.subq.ai/v1/models`, 11 November), $0.04 per M input, output
free, 384k context (subq.ai/pricing; `prices.json`). Same price as 1.1. Same request and answer shape as Jev, through
`subq.ts` (`--subq-model subq-snap-1.2`).

## Design: slice 14 unchanged, model swapped

Sets, wording, fitting, floors, cost formula, repeatability count and merge rule are slice 14's (`slice14/PREREG.md`),
with "Snap 1.1" read as "Snap 1.2". In short:
- **D:** dev fit of `BREAKING_P` / `BENEFIT_P`; floor on H1 (breaking, benefit-vs-none and actionable recall each ≤ 5
  points below Jev, paired CI not wholly below 0) and H2 (breaking recall and precision, CI not wholly below 0).
- **E:** Q8 at floor 0.60; dev fit of same / cross / quote by the slice 5 objective; floor on held-out: guarded false
  merges ≤ 1.0 per 100 and merge recall not significantly below Jev Q8 (McNemar p < 0.05).
- **Merge rule:** a step switches if it passes its floor and is > 10% cheaper per tech-year, or within ±10% and
  significantly better on a floor metric or in repeatability.

**Jev baselines are the stored runs, not refreshed** (the user's call for this slice): D `jev-{dev,heldout,heldout2}-qv1`
(Jev 1.13, 16 October); E `j2-Q8-{dev,heldout}`. Jev has drifted between versions before (slice 14, slice 15); a pass
that rests on a margin smaller than that drift is reported as such.

## Arms (both pre-registered now)

| Arm | Step | New calls | What |
|---|---|---|---|
| **D0** | D | dev, H1, H2, H1 repeat | v1 wording, slice 14 round 0 mapping |
| **D-X3** | D | none (D0's answers) | slice 14's R1 mapping: actionable = surface argmax ≠ `runtime_internal` **or** breaking at the fitted `BREAKING_P`; Jev under the same mapping |
| **E0** | E | dev, held-out, held-out repeat | Q8, floor 0.60 |

Two D arms, so a single D pass is reported with that multiplicity. Each held-out set is scored once per arm.

## Stopping rule

At most one revision per step, written into this file after round 0's held-out look and before any revision call;
then a final run. If nothing passes, Jev stays and the slice is recorded.

## If a step passes

The production switch for that step goes into this slice's PR. It includes Snap's dev-fitted constants, and `subq.ts`
is promoted into the pipeline as a `Classifier`.

## Budget

SubQ ≤ $0.50 in all (estimate $0.12). No Jev calls.

## Revision (written 11 November 2026, after round 0's held-out look and before the revision is scored)

Round 0: D0 fails (H1 actionable recall, H2 breaking precision); D-X3 fails only on H2 breaking precision at Snap's
dev-fitted `BREAKING_P` 0.10; E0 holds the false-merge floor but loses recall (57.9% against 91.9%, p 2e-19).

- **D-X3-D1 (no new calls, D0's answers):** D-X3's mapping with slice 14's D1 fit: `BREAKING_P` by dev F2 subject to
  dev breaking precision ≥ Jev v1's dev precision at 0.5, and τ matched to Jev's dev actionable share
  (`analyze_d.py --d1 --act x3`). It targets the one failing metric. For 1.1, D1 lost H1 breaking recall. Same floor
  and merge rule. This is the second H1 and H2 look for 1.2 on step D.
- **E: no revision.** The gap is about 34 recall points. The one lever slice 14 tried (no cross sentence) did not
  move 1.1. The levers left (longer rules, larger K) cost more than Jev Q8.

This is the final run. If it fails, Jev stays for both steps.

## Part 2: Snap 1.2 as the no-Jev fallback (written 11 November 2026, before any part 2 call or score)

The user moved the bar. Snap is judged as a fallback against **gpt-6-luna chat**, the provider matrix's current no-Jev
choice, and not against Jev. Jev is reported for reference only. Snap's part 1 numbers above were seen against Jev; part 2
adds prompt arms that were never run on Snap, plus fresh sets.

### Baselines (gpt-6-luna chat as production's fallback reads it)

- **D:** `choice_openai_gpt-6-luna-{dev,heldout,heldout2}` (provider matrix addendum 1: choices only, v1 mapping,
  $0.0261 per tech-year list).
- **E:** `vercel_openai_gpt-6-luna-{dev,heldout}`: F8 at its dev fit 0.82 / 0.97 / 1.01, held-out 0.9 false merges per 100
  and 80.2% recall, $0.0455 per tech-year list.

### Arms (Snap 1.2; each held-out set once per arm)

| Arm | Step | Request | Mapping / fit | New calls |
|---|---|---|---|---|
| D-X3 | D | v1 (part 1 answers) | X3, dev-fitted | none |
| D-W | D | the better of `v3` and `h` (`slice4/questions.ts`) on dev: higher mean of dev F2 breaking and F2 benefit at the fitted thresholds | X3, dev-fitted | dev ×2, then H1 and H2 for the winner |
| E-F8 | E | slice 5's pipeline questions at K = 8 (the full rules; J1) | slice 5 dev objective | dev, held-out |
| E-F4 | E | the same at K = 4 | slice 5 dev objective | dev, held-out |

### Pass rule (non-inferiority against gpt-6-luna)

- **D, stage 1 (H1, H2):**
  - H1 breaking, benefit-vs-none and actionable recall each ≤ 5 points below gpt-6-luna, with the paired CI not wholly
    below 0, and change_type accuracy CI not wholly below 0.
  - H2 breaking recall and precision CI not wholly below 0.
  - gpt-6-luna is read at its choices with the v1 mapping, the way production reads it.
- **D, stage 2 (fresh confirmation), for the best stage 1 passer only** (the one with the most H1 actionable recall):
  - The set is the encoder's stage 5 labels (`eval/edge-encoder/s5-adjudicated.json`, PR #212) on the records still in
    the production store: 219 of 500, across 69 technologies (33 breaking, 89 benefit, 104 actionable).
  - Snap 1.2 and gpt-6-luna (`choice:openai/gpt-6-luna`) get fresh runs. Snap uses the stage 1 thresholds.
  - Breaking recall and precision, benefit-vs-none recall and accuracy, and actionable recall: none may have a paired CI
    wholly below 0 against gpt-6-luna.
- **E:** held-out guarded false merges ≤ 1.0 per 100, and merge recall not significantly below gpt-6-luna F8 (exact
  McNemar p < 0.05 with fewer recalled = fail).
- **E, fresh confirmation, for the best passer only (highest held-out recall):**
  - The set is slice 16's (nx, langchain-core, openvino, astro), rebuilt by replaying `slice16/build.mts` against its
    recorded Jev answers in a copy of the side store. It reproduced 746/749, 246/246, 285/291 and 836/866 decisions,
    with 110 live Jev calls.
  - Short-rules requests are rewritten to the arm's form: `RULES_V3` questions for every candidate, K as the arm.
  - Snap 1.2 and gpt-6-luna chat (F8) each run fresh, at their slice 5 dev fits.
  - Reference: `slice16/verdicts.json`. Merges onto pairs it does not label are read by me, blind to the arm. If there are
    more than 40, they count as DIFFERENT.
  - Same rule as E on held-out.
- **Snap enters the fallback chain** for a step only if it passes that step's stage 1 and its fresh confirmation. Its
  place is decided by cost: it goes ahead of gpt-6-luna when it passes, since it is cheaper per tech-year in every arm
  measured so far.

### Stopping rule

These four arms are the hill climb. No revision. If nothing passes on a step, gpt-6-luna stays that step's fallback,
and Snap is recorded as not offered.

### Budget

SubQ ≤ $0.60, gateway or OpenAI ≤ $1.20 (gpt-6-luna fresh runs), Jev $0 (beyond the replay's $0.01).
