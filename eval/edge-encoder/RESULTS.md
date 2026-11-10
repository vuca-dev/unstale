# Edge encoder: results (10 November 2026)

**Verdict: stopped at stage 4. Jev stays for step D.** A ModernBERT-base encoder trained on Jev's cached answers
matches Jev on H1, but fails H2 at its dev-fitted breaking threshold (precision). Rules: `PREREG.md`. No model calls.

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

## Next, if revisited

1. Fit the breaking threshold on a dev set that includes guides and major notes, pre-registered.
2. Stage 5: fresh technology-disjoint held-out and a time split (costs model calls).
3. Stage 6: smaller encoders for a lossless download under 150 MB.

## Files

`PREREG.md` (rules), `build-data.mts` (stage 2), `train.py` (stage 3, predictions for stage 4), `score.py` (stage 4),
`footprint.py` (stage 1). Outputs are not committed (checkpoints and data are local).
