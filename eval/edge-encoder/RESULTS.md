# Edge encoder: results (10 November 2026)

**Verdict: Jev stays for step D, and the encoder is not admissible as the no-key fallback.** A ModernBERT-base
encoder trained on Jev's cached answers matches Jev on H1, but fails H2 at its dev-fitted breaking threshold
(precision). At the thresholds fixed for stage 5 (0.4 / 0.05) it fails fresh held-out records on breaking precision
and benefit-vs-none accuracy. Rules: `PREREG.md`. Stages 1–4 made no model calls; stage 5 cost $0.014 on the gateway.

## Stage 1: CPU and footprint (slice 4 checkpoint, M1 Pro)

`footprint.py`, 800 record states, batch 16, length-sorted. Records are short: mean 74 tokens, p95 about 102–126.

| Variant | File | Records/s at 1 / 2 / 4 threads | p95 batch at 4 threads | Peak RSS | Agrees with fp32 |
|---|---|---|---|---|---|
| ONNX fp32 | 597 MB | 4.8 / 9.5 / 17.7 | 1.24 s | 0.79–1.15 GB | exact |
| ONNX fp16 | 299 MB | 12.3 (4 threads) | | | lossless |
| ONNX int8, dynamic | 150 MB | 13.6 / 24.8 / 43.7 | 0.50 s | 0.73–0.83 GB | **change type flips 23.3%**, surface 14.1%, breaking@0.5 4.8% |
| PyTorch fp32, CPU | (as fp32) | 33 / – / 50 | | | exact |

- Peak RSS includes about 0.4 GB of Python before the model loads. Cold start is 0.5–1.3 s.
- **Passes**: a lossless variant (PyTorch fp32) reaches 33 records/s on one thread, under 1.5 GB. The exported ONNX
  graph is slower than PyTorch on one thread, so the ONNX export is not yet the runtime to ship.
- A typical technology-week (about 90 records) is about 3 s of one core. The largest technology in the store
  (1,092 records, a full backfill) is about 33 s.
- **Flagged**: no lossless variant is under 150 MB. int8 is lossy under every quantisation setting tried (per-channel,
  uint8, reduced range), so the size remedy is a smaller encoder (stage 6).

## Stage 2: data

`build-data.mts`: 152,387 active records across 4,023 technologies; 68,357 rebuild to a state with a cached Jev answer
(2,242 technologies, release notes only; Jev 1.13 and 1.14 mixed). Dev and held-out technologies excluded.
**Passes** (≥ 300 technologies, ≥ 30k records). Training used 48,709 records from 2,007 technologies (cap 200 each);
validation 6,347 records from 235 technologies.

## Stage 3: learning curve (agreement with Jev, validation technologies)

| Training technologies | Records | Change type | Actionable | Breaking@0.5 | Benefit-any@0.5 | Train time |
|---|---|---|---|---|---|---|
| 25% | 12,984 | 82.6 | 84.6 | 94.3 | 90.0 | 40 min |
| 50% | 24,985 | 84.7 | 86.2 | 95.2 | 90.9 | 72 min |
| 100% | 48,709 | 86.5 | 88.0 | 95.8 | 91.7 | 140 min |

Still rising at 100%: more labels would help. (M1 Pro MPS, 3 epochs, best epoch by validation loss.)

## Stage 4: slice 4's held-out sets

`score.py`, slice 4's harness unchanged: thresholds fitted on dev, paired 95% CIs against Jev J1.

**H1** (233 records), at dev-fitted thresholds:

| | Breaking R | Benefit R | Actionable R | Breaking P | Benefit P | Change type | Fit (break / benefit) | Floors |
|---|---|---|---|---|---|---|---|---|
| Jev J1 | 93.1 | 99.2 | 83.6 | 36.0 | 70.2 | 81.1 | 0.05 / 0.10 | baseline |
| Encoder, slice 4 | 96.6 | 99.2 | 69.9 | 33.7 | 62.2 | 68.2 | 0.10 / 0.05 | fail: actionable, benefit accuracy |
| Edge 25% | 93.1 | 99.2 | 71.2 | 37.0 | 65.6 | 72.5 | 0.10 / 0.05 | fail: actionable (−23.3..−1.4), benefit accuracy |
| Edge 50% | 96.6 | 99.2 | 76.7 | 29.8 | 67.0 | 73.0 | 0.05 / 0.05 | fail: breaking accuracy (−12.4..−2.1) |
| Edge 100% | 96.6 | 100.0 | 83.6 | 42.4 | 68.0 | 76.8 | 0.10 / 0.05 | **pass** |

**H2** (347 guide and major-note units, breaking), against J1 at 0.5 (R 90.0, P 94.5):

| Arm | Breaking R | Breaking P | Predicted | Pass |
|---|---|---|---|---|
| Edge 100% at 0.5 | 91.7 | 94.2 | 224 | pass |
| Edge 100% at fitted 0.10 | 98.7 | 87.6 | 259 | **fail**: P CI −12.1..−2.9 |
| Edge 50% at 0.5 / fitted 0.05 | 90.9 / 99.6 | 92.9 / 81.5 | 225 / 281 | fail / fail |
| Edge 25% at 0.5 / fitted 0.10 | 85.2 / 98.3 | 94.2 / 85.0 | 208 / 266 | pass / fail |

- The 100% model fails the pre-registered rule at its dev-fitted threshold, the same mode as SubQ Snap
  (`../select/slice4/RESULTS.md`): H1's sparse breaking set rewards a low threshold that over-flags guides.
- More data closed slice 4's actionable gap (69.9 → 71.2 → 76.7 → 83.6).

**Diagnostic, not admissible** (threshold chosen on the held-out sets): breaking threshold sweep, 100% model.

| Threshold | H1 breaking recall vs J1 (CI) | H2 R vs J1 (CI) | H2 P vs J1 (CI) | H2 pass |
|---|---|---|---|---|
| 0.1 | 0..+10.3 | +5.1..+12.7 | −12.1..−2.9 | no |
| 0.2 | −10.3..+10.3 | +2.9..+11.4 | −9.3..−1.8 | no |
| 0.3 | −13.8..+6.9 | +1.0..+8.0 | −6.4..−1.3 | no |
| 0.4 | −20.7..+6.9 | +0.4..+7.2 | −2.8..+0.2 | yes |
| 0.5 | **−27.6..−3.4** | −1.2..+5.2 | −2.3..+1.8 | yes |

A single threshold (0.4) passes both sets, unlike Snap, but it was found on the test sets.

## Stage 5: fresh held-out, thresholds fixed in advance (breaking 0.4, benefit 0.05)

**Fails the pre-registered rule.** On A ∪ B the encoder is significantly below Jev at 0.5 / 0.5 on breaking precision
and benefit-vs-none accuracy. It is not admissible as the no-key fallback at these thresholds.

- Units (`s5-units.py`): A 250 records / 99 validation technologies; B 150 / 45 (`x.0.0` releases); C 100 / 29
  (training technologies, records outside the capped sample, dated 2026-10-01 or later).
- Labels (`s5-label.mts`, `s5-adjudicate.py`, `s5-adjudicated.json`): J1 and J2 agreed on all four fields for 386 of
  500 records (breaking 98.0%, benefit set 91.8%, change type 86.6%, actionable 96.2%). The 137 disputed fields on
  114 records were adjudicated from the record state alone, each with a one-line reason, before any Jev or encoder
  answer was read.
- Scoring (`s5-predict.py`, `s5-score.py`): slice 4's `to_pred` / `metrics` / `compare`, paired record bootstrap
  (2,000 resamples); breaking precision paired with `score.paired` over all units, as `analyze_h2.py`.

**A ∪ B** (400 records; 80 breaking, 138 benefit, 225 actionable):

| Metric | Encoder 0.4/0.05 | Jev 0.5/0.5 | Jev 0.05/0.10 | Encoder − Jev 0.5 (95% CI) | Encoder − Jev fitted (95% CI) |
|---|---|---|---|---|---|
| Breaking recall | 91.2 | 92.5 | 100.0 | −1.3 (−7.5..+5.0) | −8.8 (−15.0..−2.5) |
| Benefit-vs-none recall | 99.3 | 84.8 | 97.8 | +14.5 (+8.7..+21.0) | +1.4 (−1.4..+4.3) |
| Actionable recall | 94.7 | 94.2 | 94.2 | +0.4 (−2.7..+3.6) | +0.4 (−2.7..+3.6) |
| Breaking precision | 80.2 | 92.5 | 64.5 | **−12.3 (−19.7..−5.6)** | +15.7 (+9.4..+22.4) |
| Benefit-vs-none accuracy | 81.8 | 91.8 | 88.8 | **−10.0 (−14.0..−5.8)** | −7.0 (−10.0..−3.7) |
| Change type (descriptive) | 77.8 | 81.5 | 81.5 | −3.7 (−7.0..−0.3) | −3.7 (−7.0..−0.3) |

Encoder − Jev 0.5/0.5 by stratum (95% CI):

| Stratum | Breaking R | Benefit R | Actionable R | Breaking P | Benefit acc |
|---|---|---|---|---|---|
| A (250; 36 breaking) | −8.3 (−19.4..+2.8) | +15.5 (+9.1..+22.7) | +3.5 (−0.9..+8.7) | −19.8 (−33.2..−7.0) | −10.4 (−16.4..−4.4) |
| B (150; 44 breaking) | +4.5 (0..+11.4) | +10.7 (0..+25.0) | −2.7 (−6.4..0) | −5.7 (−13.1..+0.1) | −9.3 (−15.3..−3.3) |
| C (100; 15 breaking) | +6.7 (−20.0..+40.0) | +25.5 (+13.7..+37.3) | 0 (0..0) | −29.8 (−52.9..−7.7) | +1.0 (−10.0..+11.0) |

- The benefit threshold 0.05 buys recall with false positives: benefit precision 65.6 against Jev's 90.7 on A ∪ B.
- Breaking 0.4 over-flags ordinary records (A: 42 flagged, 69.0% precise); on major releases (B) it holds up.
- Jev at the slice 4 fitted thresholds (0.05 / 0.10) also loses precision and accuracy against Jev at 0.5 / 0.5;
  the live thresholds are the stronger baseline here.
- Seen technologies, unseen records (C) do not rescue the encoder: breaking precision is the worst of the three.

Interpretations of the rule, fixed before scoring: B's per-technology cap of 5 counts within B; a major release is a
`release` of exactly `x.0.0` (optional `v`, no pre-release suffix); C has no per-technology cap; "released" is the
record's `date`. The labeler prompt is PACKET.md's questions verbatim.

**Spend:** gateway (J2, flex tier) $0.014: 42 calls, 85,385 input, 34,570 output (22,728 reasoning) tokens. Codex
(J1): 42 calls, 594,702 input (430,080 cached), 46,233 output tokens. No Jev calls.

## Next, if revisited

1. Fit the breaking threshold on a dev set that includes guides and major notes, pre-registered.
2. Stage 5 failed at fixed thresholds; a new threshold choice needs a fresh held-out set, not this one.
3. Stage 6: smaller encoders for a lossless download under 150 MB.

## Files

`PREREG.md` (rules), `build-data.mts` (stage 2), `train.py` (stage 3, predictions for stage 4), `score.py` (stage 4),
`footprint.py` (stage 1), `s5-units.py`, `s5-label.mts`, `s5-adjudicate.py`, `s5-predict.py`, `s5-score.py` and
`s5-adjudicated.json` (stage 5). Outputs are not committed (checkpoints and data are local).
