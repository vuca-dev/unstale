# Choice-only re-score: text generators' stated probabilities (16 October 2026)

**The question (user):** text-generating models were asked to state a probability per option (the Codex fallback
prompt, and every chat arm of slices 4 and 5). Thresholds were then fitted on those numbers. A text generator's
stated number is not a score.

**Finding.** Re-scored from cached answers, with no new calls (`choice4.py`; slice 5 via `score5.mts --fixed`):
- **The stated probabilities carry no information beyond the choice.** For every chat arm, "p ≥ 0.5" equals the
  choice exactly.
- **Thresholds fitted on them (BREAKING_P around 0.05) only meant "yes unless the model wrote 0".** That bought
  recall with collapsed precision. The slice 4 verdicts at fitted thresholds overstate those arms' recall.
- **Jev is a classification model.** Its probabilities are output distributions, and the floor comparisons that
  matter use the live 0.5 threshold.

## Classifier, H1 held-out (233 records, 29 breaking)

| Arm | Mode | Breaking R | Breaking P | Benefit R | Benefit P | Actionable R | change_type |
|---|---|---|---|---|---|---|---|
| Jev (J1) | p ≥ 0.5 (live) | 82.8 | 77.4 | 86.8 | 84.0 | 83.6 | 81.1 |
| Luna 5.6 (Codex) | choice | 86.2 | 61.0 | 94.2 | 78.1 | 83.6 | 82.0 |
| Luna 5.6 | fitted on stated p | 96.6 | 40.0 | 96.7 | 70.9 | 83.6 | 82.0 |
| qwen3.8-flash | choice | 82.8 | 80.0 | 97.5 | 81.9 | 87.7 | 80.3 |
| qwen3.8-flash | fitted on stated p | 89.7 | 23.6 | 99.2 | 63.5 | 87.7 | 80.3 |
| deepseek-v4-flash | choice | 69.0 | 90.9 | 81.0 | 78.4 | 83.6 | 67.8 |
| gpt-oss-120b | choice | 86.2 | 69.4 | 84.3 | 69.9 | 72.6 | 59.2 |
| gpt-oss-20b | choice | 86.2 | 51.0 | 83.5 | 66.9 | 64.4 | 57.1 |

- **On choices, Qwen 3.8 is at least level with Jev at the live threshold:** benefit +10.7, actionable +4.1, breaking
  precision +2.6, breaking recall equal. With 29 breaking records none of these is significant.
- **Luna trades breaking precision for recall.**
- **Jev stays on cost:** it is 4–10× cheaper, and a classification model's probabilities give the borderline flags.
  The accuracy case for Jev over Qwen is not made by this set.

## Judge, slice 5 held-out (197 true matches)

- **Choice alone (judge-only false merges per 100, held-out):** Luna 4.8, DeepSeek 7.3, gpt-oss-20b 8.4, Qwen 10.6,
  Jev 12.3 at 0.5. Jev's floor (0.8 per 100 at 88.8% recall) comes from its calibrated probabilities under a strict
  threshold plus the guards. A text generator's stated number cannot support that.
- **The production fallback rule** is that an uncalibrated "yes" merges only on a near-identical same-kind quote,
  never across kinds or by lineage (`score5.mts --fixed 0.5,1.01,1.01`). It gives 0 false merges for every arm, at
  72–74% recall.

## Change made

- **The Codex fallback asks for one option per question and no probabilities** (`classify/adapter.ts`). Its answer
  is given as probability 1 for the choice, and the classification is marked `calibrated: false`.
- **The judge's `pick` applies every probability-gated guard as if p were 0** for an uncalibrated "yes"
  (`match.ts`).
- **The live catalog had 0 records labelled by the fallback.** The flaw was latent: it would have taken over if Jev
  failed or ran out of credit.
