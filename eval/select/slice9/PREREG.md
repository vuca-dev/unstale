# Slice 9 pre-registration: step D's rule text paid once per group of records

Written 20 October 2026, before any dev or held-out run of a grouped arm was scored. Code: `origin/main` `3dcaeb5`;
`central/src` unchanged so far. Design `grouped.ts`, runner `run9.mts`, scorer `score9.py` (this directory).

## Why

Step D (`classify/labels.ts`) sends Jev one request per record: the record's state (about 105 Jev tokens) and eight
closed-choice questions whose instructions and options carry all the rule text. Jev bills input only ($0.042/M, no
cached-input discount), and the question block is most of each request. Measured on dev before this was written
(`probe2.mts`, one call per line):

| Request | Jev input tokens |
|---|---|
| 1-key state, 1 yes/no question | 312 |
| 1-key state, 8 yes/no questions | 634 (about 265 per call + 46 per question) |
| a dev record's state, 1 yes/no question | 415 (the state: about 105) |
| the same plus every field's rule text in the state | 1,571 (the rule text stated once: about 1,156) |
| 1-key state, today's 8 questions | 1,993 (the question text: about 1,360 + 8 × 46) |
| change_type, 12 options with today's descriptions / with empty criteria | 698 / 361 |

Jev has no field for shared instructions, but the state can hold them, and a choice option's criterion may be empty.
Slice 4 (`RESULTS-compress.md`) shortened the wording itself and lost removal/deprecation and benefit recall; slice 5's
judge restructure (rules once, answers by id) lost recall. This slice keeps today's wording verbatim and changes only
where it is stated and how often it is paid.

## Design (`grouped.ts`)

- A **group** is up to N consecutive records of one technology (production: the ingest order `labelPending` already
  holds; the sets: their file order).
- The eight fields (change_type, surface, breaking, benefit × 5) are cut into N field groups of 8/N fields. **One
  request per field group**: its state holds `technology` once, `rubric` (the pipeline's own wording, `CHANGE_TYPES`,
  `SURFACES`, `BREAKING_RUBRIC`, `BENEFIT_DEFS`, `BENEFIT_RULE`, for that request's fields only, each stated once) and
  `records` (`r1`…`rN`, each the pipeline's `recordState` without `technology`). Its questions are one short question
  per record and field ("Record r2: breaking? Use rubric.breaking."), option keys unchanged, criteria empty for
  change_type and surface, "Yes."/"No." for yes/no. 8/N fields × N records = 8 questions, Jev's limit.
- Answers are reassembled into `labelQuestions()`' ids and options per record, so `interpret`, the thresholds (0.5)
  and everything downstream are unchanged.
- Token model per record: about 265 + 1,156/N + 105·N + 8 × (46 + short text). N = 2 and N = 4 are near the minimum;
  N must divide 8. A smoke on 8 dev records: today 2,097 per record, N = 2 1,676 (−20%), N = 4 1,609 (−23%).

Arms: **g2** (N = 2: {change_type, surface, breaking, security}, {correctness, performance, cost, maintainability})
and **g4** (N = 4: {change_type, surface}, {breaking, security}, {correctness, performance}, {cost, maintainability}).
**Up to 3 dev revisions** (new arms in `VARIANTS`, each run on dev only), then **one held-out look**, of one arm.

## Baseline and noise

- **B**: today's request (`labelQuestions()`, one per record), a fresh run with an empty cache.
- **Br**: B again, fresh, with its own empty cache: the noise of a fresh replicate.
- Both on dev and on each held-out set, the same day as the arm.

## Dev (selection only)

Slice 4's dev set: the benefit set (170 units → 150 records, benefit = union over sources) and the breaking 241 (both
reference judges agree). Dev metrics, at 0.5: breaking recall and precision (241), benefit-vs-none recall and
precision (150). Dev has no change_type or surface reference, so each field's **flip rate against B** (choice for
change_type and surface; p ≥ 0.5 for breaking and each benefit) is compared with Br's.

An arm **passes dev** when every dev metric passes the held-out rule below (item bootstrap), and every field's flip rate
against B is at most max(Br's + 2 points, 1.5 × Br's). The cheapest passing arm (measured Jev input tokens per record
on dev) gets the held-out look. If none passes after the revisions, the held-out look goes to the arm with the fewest
failed dev conditions (ties: fewer tokens), and the verdict is fail unless it passes held-out.

## Held-out sets

- **H1**: slice 4's held-out classifier set (`holdout/classify/records.json`, 233 records of posthog-js, zod, uvicorn,
  typer; adjudicated breaking, benefit, change_type, actionable). Cluster: the source note.
- **H2**: slice 4's held-out set 2 (`out/slice4/h2-units.json`, 347 records of SvelteKit 3, MSW 3, transformers 5,
  mypy 2 guides and majors; group-level breaking, obligation = removal or deprecation in the group, the group's
  change_types). Cluster: the section.

**Why these and not a fresh set.** Both have been looked at before (H1 by about eight slice 4 arms, H2 by four), but
always to choose *wording*; the production wording (v1) was itself picked on them. This slice keeps that wording
verbatim and designs only on dev, so its one look is not adapted to H1/H2, and any wording overfit favours the
baseline, which makes the test conservative. They are the only sets with references for every field named in the
pass rule (benefit and actionable only in H1); building a fresh labelled set would need a new Claude reference.

## Held-out metrics (live 0.5 thresholds; an unanswered record is wrong)

| Metric | Set | Definition |
|---|---|---|
| breaking recall, precision | H1 + H2 pooled | p(yes) ≥ 0.5 |
| removal/deprecation recall, precision | H1 + H2 pooled | answer ∈ {removal, deprecation} against reference change_type (H1) or the group's obligation (H2) |
| change_type agreement | H1 + H2 pooled | answer = reference (H1) or ∈ the group's change_types (H2) |
| benefit-vs-none recall, precision | H1 | any benefit p ≥ 0.5 |
| actionable recall, precision | H1 | surface ≠ runtime_internal |

Pooled metrics resample H1 notes and H2 sections together (cluster bootstrap, 2,000 resamples, fixed seed).

## Pass rule (one look)

For each of the nine metrics, with Δa = arm − B and Δr = Br − B (points):

1. **No loss beyond replicate noise:** Δa ≥ −max(|Δr|, one record), where one record is 1 / the metric's denominator
   under B (reference positives for recall, B's predicted positives for precision, records for agreement).
2. **Held:** the 95% paired cluster-bootstrap CI of Δa is not wholly below 0.

The arm **passes** if both hold on all nine. Reported, not the rule: arm vs Br, per-benefit and per-set results, flip
rates against B, Jev input tokens per record.

## Cost

Jev input tokens per record, measured on the held-out runs (both sets), arm against B; saving in $/yr =
Δtokens × $0.042/M × 114.6 records per technology-year (`cost.mts`, slice 4) × 20,000 technologies.

## If it passes / fails

Pass: implement in `central/src` (grouped labelling in `labelPending`; a failed group request falls back per record to
today's request and the existing fallback chain), tests, central's test suite, a PR. Fail: an eval-only PR. Neither is
merged here.

## Budget

Jev ≤ $1 for the slice (`run9.mts` refuses past $0.90, from `out/slice9/usage.jsonl`); no gateway spend.
