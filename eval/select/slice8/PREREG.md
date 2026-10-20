# Slice 8 pre-registration: skip release-boilerplate chunks before step A

Written 20 October 2026, after fitting on DEV and before any held-out decision, held-out replicate call or gold
check of the candidate was looked at. Inventory `inventory.mts`, split `split.py`, candidate `skip.ts` with the
options in `frozen.ts`, fitting table `fit.mts`, replicate `rep8.mts`, scorer `score8.mts`, gold `gold8.mts` (this
directory). Code: `origin/main` `0d8c09e`; `central/src` unchanged so far.

## Why

A chunk whose step-A answer is `[]` costs one extraction call (step B is never called for it). `contentFree`
(`central/src/pipeline/extract.ts`) already skips chunks with no letter or digit once structural headings, links,
"Full Changelog", "No changes" and changesets' "Updated dependencies" lists are set aside.

From the `catalog-state` release (generation `state-20261020T142253Z-39418632257-1`, restored read-only to a scratch
store), `inventory.mts` rebuilds every chunk production extracted (release notes, upgrade guides, docs notes) and
looks up its cached step-A answer: 14,122 chunks with records, 4,136 answered `[]` (82% of the cache's 5,042 `[]`
answers are rebuilt; the rest are notes since refetched or rechunked). Matched to the usage log, `[]` chunks are 5% of
step-A dollars on DEV ($0.112 of $2.182; release notes $0.111, guides and docs $0.001). They are short (median 199
characters against 576 for chunks with records), so their cost is mostly the prompt.

## Sets (`split.py`)

Each chunk is dated by the call that answered it (the usage log line with the cached answer's token counts).

| Split | What | Chunks | Answered `[]` |
|---|---|---|---|
| DEV | answered before 2026-10-19T00:00Z | 11,280 | 2,358 |
| HELD-OUT | answered on or after 2026-10-19T00:00Z, family (repository owner) with no DEV chunk: time and family split | 1,486 | 231 |
| HELD-OUT-TIME | answered on or after 2026-10-19T00:00Z, family also in DEV: time split only | 5,492 | 1,547 |
| GOLD | the held-out majors set (its 3 upgrade guides of slices 6/7, and its 4 major release notes) and the held-out set (40 notes), with adjudicated labels | 47 notes | — |

Only counts of the held-out splits have been seen (the table above), not any decision, record or text.

## Candidate (frozen)

`boilerplate(notes, FROZEN)` in `skip.ts`: a chunk is not sent to step A when `contentFree` holds or every non-empty
line is one of these generic shapes (no technology, package or repository names):

- `bump`: a "version bump only" line (lerna, conventional-changelog).
- `sections`: a heading or bold line that is a changelog section label (Bug Fixes, Features, Patch Changes, Thank You,
  Authors, New Contributors, Dependencies, …; emoji, `:shortcodes:`, counts, versions removed), and list items under a
  credits heading.
- `markup`: fences, HTML comments, `<a name>` anchors, rules and table rules.
- `deps`: "Updated dependencies" in any form, bare `pkg@version` items, "The following workspace dependencies were
  updated", a bare "dependencies" line.
- `release`: "Release v1.2.3", "Version 1.2.3", "Initial release", "No updates", "No changes in this release", and a
  heading that is a single token (a package name or version).
- `bumps`: an item that only moves a dependency to a version ("bump x from 1 to 2", "update dependency x to v3",
  optionally under a `deps` scope), nothing else said.

Rejected on DEV (they skip chunks production got records from): `pointers` ("Please see this changelog for more
information": 6 Next.js security releases whose one record is the CVE fix), `chores` (conventional `chore:` items: 14
records, e.g. "drop support for Imagen models"), and a `deps:`-scope rule without the bump shape ("**deps:** update
dependencies and require Node.js 22.19+"). Duplicate chunks (identical text earlier in the same technology) were
measured and not used: 7 of 52 later copies of an earlier `[]` chunk got records.

DEV (`fit.mts --split dev`):

| Options | Skipped | of them `[]` | With records | Records lost | `[]` $ saved | Share of `[]` $ |
|---|---|---|---|---|---|---|
| bump | 632 | 632 | 0 | 0 | $0.0194 | 17.3% |
| + sections + markup | 655 | 655 | 0 | 0 | $0.0203 | 18.1% |
| + deps | 796 | 796 | 0 | 0 | $0.0246 | 21.9% |
| **+ release + bumps (frozen)** | **962** | **962** | **0** | **0** | **$0.0305** | **27.1%** |
| + pointers + chores (rejected) | 1,211 | 1,191 | 20 | 20 | $0.0417 | 37.1% |

## Noise (`rep8.mts`)

A fresh replicate of step A (empty cache, production's model, effort, tier and exact prompt) on every HELD-OUT chunk
production answered with records (`--set aplus`). **Noise** = production records in chunks the replicate answered
`[]` / production records in the chunks replicated (failed calls excluded): the whole-chunk loss of asking again,
the same kind of loss a skip causes. HELD-OUT-TIME uses HELD-OUT's noise (no second replicate). The replicate is also
run on every chunk the candidate skips in HELD-OUT and HELD-OUT-TIME (`--set skipped`), reported.
DEV calibration (a 300-chunk sample, `dev-aplus`) is reported in RESULTS and does not enter the rule.

## Decision rule (one look; `score8.mts`, `gold8.mts`)

The candidate passes when ALL hold:

1. On HELD-OUT and on HELD-OUT-TIME, records lost against production (records of skipped chunks / all production
   records of the split) ≤ the replicate noise (point estimates).
2. On HELD-OUT and on HELD-OUT-TIME, records lost ≤ 0.5% ("essentially none").
3. GOLD: no labelled group lost (all its anchors only in skipped chunks) in the three upgrade guides; on the whole
   gold set, lost required and lost breaking groups each ≤ the slice 3b replicate's own drop on the guides
   (required recall −9.6 points, breaking −7.1, `../slice6/RESULTS.md`), i.e. well inside noise.
4. The candidate saves step-A dollars on HELD-OUT and HELD-OUT-TIME.

If it passes: the frozen classes go into `central/src/pipeline/extract.ts` (`contentFree` or a sibling it calls)
with tests, behaviour identical to `skip.ts` on every inventory chunk (checked), and a PR. If any condition fails: an
eval-only PR records it. Neither is merged by this slice.

## Cost reporting

Step-A dollars of skipped chunks (provider-reported, from the usage log), per split, and per day by phase over
2026-10-19 (the only full day after the cut) and 2026-10-20 (partial): all phases and the monitoring phase alone
(`score8.mts --days`). Step B and Jev are unaffected (never called for a `[]` chunk).

## Budget

Gateway **$2.00** across this slice's replicate log (`rep8.mts` refuses a call once spend plus $0.01 per call in flight
would pass it); Jev **$0** (no Jev calls). Projection: ≈ $0.23 per 1,000 calls; DEV sample $0.07, HELD-OUT ≈ $0.30.

## Known limits

- The baseline is production's own answer, not gold; the gold check is on labelled notes, and skipped chunks are
  rare there by construction (guides and major releases have content).
- One replicate. Noise counts only whole-chunk loss; record-level disagreement inside a chunk is larger (slice 6:
  recall vs current 80% for a fresh run) and is not used, because a skip only ever loses whole chunks.
- The saving is bounded by `[]` chunks' share of step-A dollars (5% on DEV); the candidate takes about a quarter of it.
