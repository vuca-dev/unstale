# Edge encoder: pre-registration (9 November 2026)

Question: can a small encoder running on the user's CPU replace Jev for step D (record labels) without users seeing
worse results? Design note: vault "Edge Inference". Prior attempt: `eval/select/slice4/RESULTS.md` § Encoder (failed
on actionable recall, 69.9 against 83.6).

The stages run cheapest first. **The run stops at the first stage that invalidates the encoder.**

## Stage 1: CPU and footprint (no model calls)

On the slice-4 checkpoint first (the architecture is the same, so footprint carries over).
- Measure on this machine (M1 Pro, 10 cores): file size, cold start, peak RSS, records/s and p95 batch latency at 1,
  2 and 4 threads; and quantised variants against fp32 on the same states.
- **Invalidates** if no lossless variant reaches ≥ 10 records/s on one thread or stays under 1.5 GB peak RSS.
- **Flagged, not invalidating:** a download above 150 MB (a smaller encoder is the remedy, stage 6).

## Stage 2: data (no model calls)

Stored extractions paired with Jev's cached answers (`build-data.mts`).
- Excluded: every step-D dev and held-out technology (slice 4's list plus H2: SvelteKit, MSW, transformers, mypy),
  matched on the technology id.
- **Invalidates the generalisation test** (not the encoder) if fewer than 300 technologies or 30k labelled records.

## Stage 3: learning curve (no model calls)

- Fixed validation split: 10% of technologies by sha256, never trained on.
- Records capped at 200 per technology.
- Train ModernBERT-base on 25%, 50% and 100% of the training technologies (same recipe as slice 4 otherwise).
- Report agreement with Jev on the validation technologies: change_type, actionable (surface ≠ runtime_internal),
  breaking, benefit-any.
- **Diagnostic only:** Jev is the teacher, not the reference.
  - Agreement still rising at 100% means more data would help.
  - A flat curve means the recipe or the teacher is the limit.

## Stage 4: the existing held-out sets (no model calls)

The 100% model, scored with slice 4's harness (`analyze.py`: thresholds fitted on dev, paired against Jev J1).
- **H1:** breaking, benefit and actionable recall.
- **H2:** breaking recall and precision at 0.5 and at the dev-fitted threshold.
- **Invalidates** if, at the encoder's dev-fitted thresholds:
  - any H1 floor metric (breaking, benefit or actionable recall) is below Jev with a paired 95% CI that excludes 0;
  - H1 breaking or benefit-vs-none *accuracy* is below Jev the same way. This is the precision guard: a smoke model
    that calls everything positive passes the recall floors;
  - or H2 fails slice 4's pass rule (breaking recall and precision CIs against J1 both reach 0).
- Added after the smoke run (an untrained model that passed the H1 recall floors), before any real result was seen.
- **H1 has been looked at once already (slice 4), so a pass here does not validate.** It only earns stage 5.

## Stage 5: fresh held-out (costs model calls; only if stage 4 passes)

New technology-disjoint references, blind-labelled by two models plus an adjudicator; plus a time split (releases after
the training data). Decision rule as in the vault note.

## Stage 6: smaller encoders (only if stage 4 passes)

A size-against-accuracy curve to bring the download under 150 MB.
