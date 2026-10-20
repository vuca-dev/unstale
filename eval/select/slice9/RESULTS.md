# Slice 9: step D's rule text paid once per group of records

20 October 2026. Pre-registration: `PREREG.md` (committed and pushed before the held-out look, with a dev addendum
freezing the arm). Design `grouped.ts`, runner `run9.mts`, scorer `score9.py`, dev diagnostics `probe2.mts`, `diag.mts`.

## Verdict: fail. No production change.

g4 (four records of one technology per request, rule text once in the state, one short question per record and
field) cuts Jev input by 20.5% on held-out, but it fails the pre-registered rule on four of nine metrics. It shifts
answers towards "yes": breaking, benefit and actionable recall rise while their precision falls, and benefit-vs-none
precision falls significantly. The saving would have been about $42/yr at 20k technologies.

## Held-out (H1 233 + H2 347 records; live 0.5 thresholds; one look)

B = today's request, fresh; Br = B again, fresh (the replicate noise); tolerance = max(|Br − B|, one record).

| Metric | B | Br | g4 | Δ g4 − B (95% CI) | Tolerance | Rule |
|---|---|---|---|---|---|---|
| Breaking recall (H1+H2) | 89.2 | 88.8 | 93.1 | +3.9 (+0.6…+6.7) | 0.4 | ok |
| Breaking precision (H1+H2) | 92.8 | 91.6 | 90.9 | −1.8 (−4.9…+1.6) | 1.1 | **fail** (beyond noise) |
| Removal/deprecation recall (H1+H2) | 86.5 | 86.5 | 85.5 | −1.0 (−6.1…+3.0) | 0.5 | **fail** (beyond noise) |
| Removal/deprecation precision (H1+H2) | 93.3 | 93.3 | 94.3 | +1.0 (−0.9…+3.1) | 0.6 | ok |
| change_type agreement (H1+H2) | 81.9 | 82.4 | 81.6 | −0.3 (−3.4…+2.5) | 0.5 | ok |
| Benefit-vs-none recall (H1) | 86.0 | 86.0 | 91.7 | +5.8 (+1.6…+11.2) | 0.8 | ok |
| Benefit-vs-none precision (H1) | 85.2 | 85.2 | 79.9 | **−5.4 (−10.6…−0.2)** | 0.8 | **fail** (significant) |
| Actionable recall (H1) | 83.6 | 86.3 | 89.0 | +5.5 (−1.1…+12.3) | 2.7 | ok |
| Actionable precision (H1) | 58.1 | 58.9 | 55.6 | −2.5 (−6.9…+1.6) | 1.0 | **fail** (beyond noise) |
| **Jev input tokens per record** | 2,114 | 2,114 | **1,680** | **−434 (−20.5%)** | | |

- B reproduces slice 4's JQ1 numbers (H1 breaking 82.8 / 77.4, change_type 81.1; H2 breaking 90.0, change_type 82.4).
- Jev answers the same request almost identically twice: flip rates B → Br are 0–2% per field. g4 flips change_type on
  14.3% of records, surface 13.4%, breaking 5.5%, correctness 6.6%.
- Per benefit (H1, descriptive): security recall 85.7 → 71.4, performance precision 88.9 → 75.0.

## Dev (selection; 411 units)

| Arm | Jev input / record | Breaking R / P | Benefit R / P | Flip vs B: change_type / surface |
|---|---|---|---|---|
| B (Br) | 2,098 | 85.3 / 96.1 (84.6 / 96.0) | 79.5 / 91.7 (78.3 / 91.5) | (2.9 / 2.2) |
| g2 (N = 2) | 1,692 (−19.3%) | 84.6 / 94.5 | 85.5 / 91.0 | 15.6 / 15.1 |
| **g4 (N = 4)** | 1,636 (−22.0%) | 90.9 / 95.6 | 85.5 / 92.2 | 13.1 / 15.8 |
| g2i (change_type, surface inline) | 1,894 (−9.7%) | 86.0 / 96.1 | 85.5 / 91.0 | 10.0 / 10.9 |
| g4i | 1,998 (−4.8%) | 90.2 / 95.6 | 83.1 / 92.0 | 8.3 / 11.4 |

No arm passed dev (all failed the flip-rate condition); g4 had the fewest failed conditions at the lowest cost, so it
got the look. Dev's benefit precision held (+0.5), and H1's fell (−5.4): dev did not predict the precision loss.

## What was learned

- **Where Jev's tokens go** (`probe2.mts`): about 265 per call, 46 per question, about 105 per record state. Today's
  question text is about 1,360. Every field's rule text stated once is about 1,156. Jev accepts empty option criteria.
- **A choice option's description works only in its criterion.** With empty criteria and the descriptions in the
  state, change_type drifts as much with one record per request as with four (diag: `tooling` is lost most). Pointer
  criteria do not help. Putting the descriptions back in the criteria (g2i, g4i) halves the drift and removes most of
  the saving: about 840 of the 1,360 tokens are change_type and surface descriptions, which cannot be shared.
- **Rule text in the state makes Jev's yes/no answers more liberal.** Recall rises and precision falls on breaking,
  benefit and actionable together. This is the same pattern as slice 5's judge restructure. Most of what can be shared
  (breaking's rubric and the benefit rule, about 600 tokens per record) is exactly what moves these answers.
- **Not tried, and post-hoc if tried:** refitting `BREAKING_P` / `BENEFIT_P` for the grouped request on dev. It might
  win back the precision, but it would need a new held-out set, because H1 and H2 have now been looked at for this
  design.

## Sets and why

H1 and H2 (slice 4's held-out classifier sets). They are the only sets with references for every field in the rule.
Earlier looks at them chose wording; this arm kept the production wording verbatim and was designed on dev only (see
PREREG). Both sets have now been looked at once more, for structure.

## Spend

Jev $0.358 of the $1 cap (probes, smoke and diagnostics $0.017, dev $0.197, held-out $0.144). No gateway, no Cloudflare.

## Files

`grouped.ts` (arms), `run9.mts` (runs), `score9.py` (dev and held-out tables), `probe2.mts`, `diag.mts`. Outputs
are in `eval/select/out/slice9/` (gitignored): `runs/*`, `dev-report.json`, `heldout-report.json`, `usage.jsonl`.
