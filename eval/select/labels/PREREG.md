# Label fields (step B): reference set, conditions hill-climb, input diet — pre-registration

Written 16 October 2026 before any reference answer was scored or compared with a model's answer. Model settled:
`vercel:openai/gpt-6-luna`, reasoning `low`, two calls (slice 3b). Vault: Inference Costs, "Cost levers and next
experiments", #5 and #6.

## The set (#5a)

- **Records:** fixed. Every record gpt-6-luna extracted from both held-out sets in slice 3b (`items.mts` →
  `items.json`): H1, 40 short notes from posthog-js, zod, uvicorn and typer (41 chunks, 222 records); H2, 7 guides and
  major notes (7 chunks, 441 records). 48 chunks, 663 records. Every candidate labels exactly these records from the
  pipeline's brief and the chunk's notes, so comparisons are paired by record. Label quality is measured conditional on
  gpt-6-luna's records, which is what production will label.
- **Reference:** two blind Claude labelers, A = Opus and B = Sonnet (`claude -p`, no tools, empty directory), each given
  `LABEL_PROMPT` filled with the brief and the notes, plus a short "gold-standard, be precise" preface. Neither sees a
  model's label answer. H2 chunks are split into batches of at most 20 records. Where A and B differ on `replaces`,
  `requires`, `prerequisites` or `conditions` for a record, an Opus adjudicator gives the final value, shown the two as
  "Annotator 1/2" in a hash-fixed order. Side-taking (final = A, = B, other) is reported as a bias caveat (Opus labels A
  and adjudicates). Agreement fields take the agreed value.
- **Terms are not adjudicated.** Reported descriptively only: core recall (share of A ∩ B terms the candidate gives) and
  loose precision (share of the candidate's terms in A ∪ B). Terms have many valid answers; the gate measures their
  effect.

## Scoring (`score.py`, deterministic; rescoring the same answers must give identical numbers)

- **Normalisation** (replaces, requires): trim, strip surrounding backticks and quotes, drop a trailing `()`, collapse
  whitespace, lower-case. Prerequisites match on (ecosystem, name) lower-cased; min/max agreement reported separately.
- **Conditions:** a candidate phrase matches a reference phrase of the same record when the Jaccard overlap of their
  content-word sets (lower-cased, stop words and punctuation dropped) is at least 0.5; greedy one-to-one matching.
- **Per field:** item-level micro precision and recall over all records, and record-level presence precision and recall
  (the record has any value). The answer the pipeline actually stores is what is scored: raw label answer, before
  `toIncoming`'s deterministic audience and docs additions to `conditions` (those are not the label call's).
- **Comparisons:** paired bootstrap over chunks (cluster resampling, 2,000 resamples, seed 0), 95% CI of the
  difference.
- **Power:** a field with fewer than 30 reference positive records (presence) is reported as underpowered: descriptive
  only, it cannot pass or fail a variant.

## Baselines

- **G0:** gpt-6-luna, the slice 3b label answers for these records (cached, no new call).
- **G0r:** gpt-6-luna again on the identical prompt with a cache-busting request field (`user: "labels-rep"`): the
  run-to-run noise floor.
- **L:** Luna 5.6 through `codex exec` (plan), same prompts.

## #5b: label-prompt variants (at most 3)

Designed only on DEV records (Luna's slice 3 dev-document extractions of next, prisma and nestjs; never H1/H2 records),
then one look at the set. Target: `conditions` (gpt-6-luna fills it on 5.9% of gate records against Luna's 11–12%) and
any field the baselines show weak. Answers stay ids and short identifiers or short phrases; no restated prose.

**Pass rule:** on the targeted field, recall improves over G0 with the CI excluding 0, and precision does not fall
significantly (CI upper bound below 0 counts as a loss); on every other adequately powered field, no significant loss in
recall or precision; output tokens up by at most 25%. If more than one passes, the one with the better targeted-field F1;
ties go to fewer tokens.

## #6: input diet

The label call receives, instead of the whole chunk, only the sections that hold the batch's records' evidence: the
section is located with the pipeline's `locate` (heading-bounded), sent with its heading line; sections are kept in
document order and de-duplicated. Records whose evidence is not located bring the whole chunk (the worst case equals
today's input). Applied to the prompt that wins #5b (or G0's prompt if none passes).

**Pass rule:** no adequately powered field loses recall or precision significantly (CI upper bound below 0), and no
point estimate of recall drops by more than 5 points; then the input-token saving, measured, converted to $ per
technology-year at 10k / 50k / 200k with slice 3b's cost model.

## #6b: evidence-only label input (added before any reference look)

Measured before any run: the section diet (#6) keeps 88% of H1's notes and 100% of H2's (extraction is exhaustive, so
nearly every section holds a record), which cuts the label prompt by only 5%, about 1% of A + B. A second arm drops the
notes altogether: the label call gets the prompt and the brief (which already carries each record's verbatim
evidence), with each record's located section heading added to its brief entry. That cuts the label prompt by 42% on
the set (51% on dev). Same pass rule as #6. Expected risk: `requires`, `prerequisites` and `conditions` stated outside
a record's own sentence (a section's lead-in, a "Requirements" section) are lost.

## Caps

Gateway $1.20 for this track (budget guard keeps the $1 reserve). No Jev. Codex (plan) for L. Claude labelers on the
user's plan.
