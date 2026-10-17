# Confirm H on H2 (16 October 2026)

Pre-registration: `PREREG.md` § "Confirm H on H2", written before any classifier run on these records.

## Verdict

**H passes the pre-registered breaking rule but is not shippable as it stands.**
- Breaking holds and even improves: recall rises from 90.0 to 93.9 (+3.9, CI +0.5…+6.4), and precision is unchanged (94.5 against 94.7).
- But H loses removal and deprecation answers, which the client treats as obligations (`funnel.rs` `is_obligation`). On the records with a removal or deprecation reference, obligation recall drops from 85.6 to 77.3 (−8.3, CI −13.2…−3.5, McNemar 15/0, p 0.0001).
- That check was descriptive in this section. But the compression arms' own rule 2 ("removal + deprecation recall: paired CI not wholly below 0") fails here. On H1 that rule had too little power to see this (n 12; here n 181).

**JQ1 (v1) is confirmed.** Breaking answers are identical to J1 on every record (its breaking question is unchanged), and obligation recall and change_type agreement are within ±1. It is the safe −7.5%.

## Data

- **Records:** slice 3b's gpt-6-luna two-call H2 run, 441 records, with the pipeline's own `recordState` (`build_h2_units.py`).
- **References:** each record takes the adjudicated group credited to it by the scorer's precision matching. That credits 374 of the 441 records (84.8%, matching slice 3b's precision).
- **Excluded:** 67 records match no group and 27 match an `unsure` group.
- **Kept:** 347 records in 59 sections, 230 breaking, 181 with a removal or deprecation item in their group.
- **Bootstrap:** section-cluster (score.py `paired`, 2,000 resamples, seed fixed); re-running the analysis gives byte-identical output.

## Results (live threshold 0.5, n = 347)

| Arm | Input tokens per record | Breaking recall | Breaking precision | Predicted breaking | Obligation recall (descriptive) | change_type agreement (descriptive) |
|---|---|---|---|---|---|---|
| J1 (pipeline) | 2,254 | 90.0 | 94.5 | 219 | 85.6 | 82.4 |
| H | 1,635 | **93.9** (+3.9, CI +0.5…+6.4, McNemar 3/12 p 0.035) | 94.7 (+0.2, CI −1.9…+2.5) | 228 | **77.3** (−8.3, CI −13.2…−3.5) | 79.5 (−2.9, CI −6.5…+1.0) |
| JQ1 (v1) | 2,087 | 90.0 (identical) | 94.5 (identical) | 219 | 86.2 (+0.6) | 83.3 (+0.9) |

On non-breaking references, H and J1 are each right on 89.7%, with 3 discordant records in each direction.

## Why H loses obligations

All 15 discordant records go one way: J1 answers `removal` and H does not. H answers behavior_change ×7, new_api ×4, tooling ×3 and other ×1.
- **Typical records:** "The minimum required TypeScript version is v6", "minimum required Svelte version is v5.57.1", "$lib alias replaced by #lib", "types move to $app/server".
- **The cause is H's removal gloss.** H says "Removed or support dropped." The pipeline's says "...removed or no longer works, including dropped support for a runtime or platform version". Raised minimum versions and moved or renamed APIs lose their cue in H.
- **The pattern is spread across documents:** SvelteKit (9), transformers (3) and MSW (3).

## Recommendation

- **Ship JQ1 now:** −7.5% on step D, confirmed on both held-out sets.
- **Do not ship H as it stands.** A candidate that keeps the pipeline's change_type question and uses H's surface and breaking questions (the change_type block is about 1,377 characters of J1's 7,167) would recover most of H's saving. But it was designed after seeing H2, so it needs a third held-out set to be judged honestly.

## Spend

Jev $0.088 (smoke $0.0009, J1 $0.033, H $0.024, JQ1 $0.030), within the $0.25 cap. No gateway or Cloudflare.

## Caveats

- **One extractor run:** every record comes from one gpt-6-luna run, so the references inherit its record split.
- **Group-level breaking flag:** a non-breaking record inside a breaking group counts as breaking.
- **Claude-made references:** as for H1.
- **The obligation metric is group-level and was descriptive here.** It counts any removal or deprecation item in the group, and the pre-registered rule for this section was breaking only.
- **No H2 reference for benefit or actionable.** H's benefit questions are v1's, which passed pre-registered in JQ1; H's actionable result rests on H1 only.

## Files

- `build_h2_units.py`: units → `out/slice4/h2-units.json`.
- `analyze_h2.py`: the table and paired tests → `out/slice4/confirm-h2.json`.
- `run4.mts`: new `--split heldout2 | smoke2` (additive; other splits unchanged).
- Runs: `out/slice4/runs/jev-{smoke2,heldout2,heldout2-qh,heldout2-qv1}`.
