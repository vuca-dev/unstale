# Technology-disjoint held-out sets (model selection)

Phase 1: technologies, packets and scorers. Independent labelers fill `*/labels/<labeler>.json` from the packets;
an adjudicated file (`*/labels/adjudicated.json`, built from the note text and the labeler files only) is what the
scorers read. Rules: `PREREG.md`
(written before any note was read; deviations listed there). Power: `POWER.md`.

## Technologies

| Technology | Ecosystem | Style | Why it is clean |
|---|---|---|---|
| `posthog-js` (`posthog-js-bf3ade81`) | npm | changesets | Named in no eval file; repository PostHog/posthog-js shared with no other stored technology |
| `zod` (`zod-6ac59393`) | npm | prose (GitHub releases, hand-written) | Same (the only "zod" in eval/ is the repository name prisma-zod-generator) |
| `uvicorn` (`uvicorn-9342337b`) | PyPI | GitHub-generated "What's Changed" | No PyPI technology exists in any set |
| `typer` (`typer-4f6b46bd`) | PyPI | sectioned (Features / Fixes / Internal) | Same |

These four must stay out of every dev set, prompt hill-climb and threshold fit (`technologies.json`).

## Files

| File | What |
|---|---|
| `PREREG.md` | Selection and sampling rules, seed `unstale-holdout-v1`, deviations |
| `select_tech.py` | Technology selection (heading lines and counts only). Writes `out/holdout/selection-{npm,pypi}.json`; the PyPI step fetches release lists with `gh api` |
| `build.mts` | Notes, feasibility, the extraction sample, the PyPI extraction (Luna via Codex), the classifier sample. `cd central && npx tsx ../eval/select/holdout/build.mts <phase>` |
| `vocab_dump.mts`, `make_packets.py` | The packets, from the pipeline's constants verbatim: `npx tsx ../eval/select/holdout/vocab_dump.mts > ../eval/select/out/holdout/vocab.json && python3 ../eval/select/holdout/make_packets.py ../eval/select/out/holdout/vocab.json` |
| `extraction/notes/`, `extraction/notes.json` | The 40 sampled notes (text as the pipeline reads it, after `clean`) and their strata |
| `extraction/PACKET.md` | Labelling instructions (inventory of qualifying changes) |
| `classify/records.json` | 233 units (80 posthog-js, 80 zod, 40 uvicorn, 33 typer: all of typer's records): id, technology, stratum, source key, the exact `recordState` state, `faithful` (npm: the state hit the pipeline's classifier cache) |
| `classify/packet-records.json`, `classify/PACKET.md` | What labelers see: id, technology name and state only, shuffled. No stratum, no hint, no model label |
| `score.py`, `test_score.py` | Scorers (stdlib) and their smoke tests: `python3 -m unittest -v test_score` |
| `power.py`, `POWER.md` | Minimum detectable differences |

Bulky and model-derived files stay in `eval/select/out/holdout/` (gitignored): raw PyPI bodies
(`notes/<tech>/<version>.md`), selection tables, `pypi/<tech>/incoming.json` (Luna's records over all in-window PyPI
notes) and the build logs.

## Scoring

```
python3 score.py extraction <incoming.json | catalog-dir | {note_file: [quote]}> --labels extraction/labels/adjudicated.json
python3 score.py classify <pred.json> --labels classify/adjudicated.json
python3 score.py compare <a> <b> --labels <adjudicated.json>
```

The same scorer scores held-out set 2 (upgrade guides and major notes) with `--notes ../holdout-majors/extraction/notes.json`;
its labels carry `required`, and required-group recall then leads the report (`../holdout-majors/README.md`).

- **Extraction:** the reference is `extraction/labels/adjudicated.json` (`{note_file: [{id, group, anchors, change_type,
  breaking, unsure?}]}`; decisions and principles in `extraction/labels/extraction-adjudication.json`). An item lists
  every verbatim span that states its change (prose sentence, commit line, heading, "At a glance" bullet); items split
  out of one bullet or sentence share a `group`. **Recall is per group**, so granularity neither rewards nor punishes a
  model: a group is recalled when a record's quote overlaps any anchor of any of its items (overlap: the shorter
  normalised text is contained in the longer and is at least 25 characters, or similarity is at least 0.8), with one
  record recalling at most one group (maximum matching, so a whole-note quote cannot sweep a note). **Precision:** a
  record is credited when it overlaps an anchor in its note, each group crediting at most as many records as it has
  items (duplicates and one-record-per-line beyond that earn nothing). Reported: group recall pooled and macro-averaged
  per note (zod 4.5.0 alone holds ~40% of groups, so pooled is never reported alone), recall excluding `unsure`
  groups, breaking-group recall, and precision; each by technology, ecosystem, structure and length. A note with no
  records counts as zero records, never dropped.
- **Score extraction on incoming records, not on a catalog.** A catalog merges records across releases and keeps a
  few evidence quotes per record, so most notes lose their quotes (on the store's own catalog only 12 of the 40 notes
  have any). The runner's `incoming.json` is the right input.
- **Classify:** per label precision, recall, F1 and accuracy; breaking first; benefit-vs-none; per benefit;
  change_type accuracy and removal + deprecation recall (exact type, and as an obligation); actionable recall.
  A missing prediction is wrong (for a binary label, the opposite of the reference).
- **Compare:** exact McNemar on per-unit correctness and a 2,000-resample paired bootstrap CI of B − A. Extraction
  units are groups and the bootstrap resamples whole notes (groups within a note are not independent); the macro
  recall row shares the pooled McNemar counts, so read its CI; precision has only the bootstrap.
- **Pooled numbers are stratum-weighted, not natural.** The extraction sample balances length and structure cells
  (natural: 80% short); the classifier sample puts at least 40% in stratum O (removal, deprecation,
  behavior_change, default_change by the extraction hint). Report per stratum.

## Checks run

- Smoke tests: 26 pass (5 of them for the majors set, `../holdout-majors/`: required-group recall headline, kind
  slices, guide-vs-notes routing of incoming records, scoped names, the real manifest loads; and the first set's 21: one record per line earns no precision beyond the matched items; a whole-paragraph quote
  matches one item; duplicates are credited once; missing predictions lower recall in both scorers; `compare` on
  identical inputs gives p = 1 and a zero difference; a 60-item all-or-nothing difference gives p < 0.001; one record
  recalls a four-item group; a commit-line anchor counts as well as the prose one; five duplicates on a one-item group
  earn one precision credit, four on a four-item group earn four).
- Adjudicated extraction reference: its own anchors score 270/270 recall and 287/287 precision; labeler A's anchors
  recall 268/270 groups and B's 254/270 (B skipped A's splits and implementation-level perf commits).
- Real data: the store catalog's quotes for the sampled notes, used as both labels and predictions, score 155/155
  recall and 155/155 precision (URL attribution and shard loading).
- npm states: all 160 sampled states are byte-identical to requests the pipeline asked (classifier cache hits).
