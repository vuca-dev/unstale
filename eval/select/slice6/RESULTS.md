# Slice 6 results: one extraction per shared upgrade guide

20 October 2026. Pre-registration: `PREREG.md` (committed before any `rep`, `shared` or held-out run). Runner
`run6.mts`, scorer `score6.mts`, gold inputs `gold_prep.py`, cost `cost6.py`. The design's code is `design.patch`
(`git apply` on `b0880fa`; the runner needs it for the `shared` arms), not merged.

## Decision

**Rejected. Guides stay extracted per package.** The shared design fails the pre-registered rule on held-out (5 of
8 conditions) and on gold. It would have saved 74% of the held-out pairs' A + B + D spend, but the per-package
selection cannot reproduce which records each package gets today: it kept 262 records where production keeps 1,183
and a fresh per-package run keeps 1,208. `central/src` is unchanged.

| Condition (held-out, `shared` against `rep`) | `rep` vs base | `shared` vs base | `shared − rep` (paired 95% CI) | Pass |
|---|---|---|---|---|
| 1. F1 per pair, ≤ 3 points below | 84.5 (77.1…90.7) | 47.7 (35.7…59.8) | −36.8 (−49.8…−23.3) | **No** |
| 2. Recall vs current, ≤ 5 below | 80.2 (70.8…89.0) | 15.5 (7.0…28.5) | −64.8 (−76.4…−50.9) | **No** |
| 2. Precision vs current, ≤ 5 below | 78.6 (71.2…85.7) | 69.8 (64.1…80.4) | −8.7 (−19.0…+5.1) | **No** (margin) |
| 3. Records within ±10% of base | +2.1% | −77.9% | | **No** |
| 4. Terms Jaccard, ≤ 5 below | 47.6 | 38.3 | −9.4 (−17.1…−3.6) | **No** |
| 5. Breaking agreement, ≤ 3 below | 96.1 | 94.0 | −2.1 (−5.0…+3.3) | Yes |
| 5. Benefit agreement, ≤ 3 below | 97.5 | 98.8 | +1.4 (−0.0…+3.3) | Yes |
| 6. Failed pairs ≤ max(1, 2%) | 0 | 0 of 45 | | Yes |
| 7. Gold (below) | | | | **No** |
| 8. `shared` costs less than `rep` | $0.2368 | $0.0626 | −$0.1742 (−73.6%) | Yes |

45 pairs in 5 units (AI SDK 4.0, 5.0, 6.0, 7.0; NestJS 12). Labels are compared on 903 (`rep`) and 168 (`shared`)
matched records.

**Gold** (the held-out majors set's three guides, each read by its own package; `holdout/score.py compare`, section
bootstrap, 193 groups; baseline slice 3b's gpt-6-luna two-call run on the same prompts):

| Metric | Baseline | `shared` | Diff (95% CI) | 3b replicate − baseline (noise) |
|---|---|---|---|---|
| Required recall, excl. unsure (n 104) | 91.3 | 75.0 | −16.3 (−33.0…0.0) | −9.6 (−18.3…0.0) |
| Breaking recall (n 126) | 88.1 | 74.6 | −13.5 (−30.2…+0.9) | −7.1 (−15.2…+1.2) |
| Precision | 80.7 | 73.3 | −7.4 (−11.7…−2.1) | −1.1 (−4.9…+2.3) |

Both recalls are more than 5 points below the baseline: the selection drops a guide's own changes for its own
package. (The 3b replicate is itself 7–10 points below on this set; one run per side.)

## Why it fails

- **Per-package relevance is load-bearing and inconsistent across families.** Production's per-package extraction
  keeps most of the AI SDK guide for most providers (7.0 guide: 43–84 records for 12 of 14 packages, 9 for
  `@ai-sdk/otel` and 21 for `@ai-sdk/react`; the fresh replicate agrees at F1 71–98 on 12 of the 14 pairs), but
  keeps only a package's own changes in Tiptap (`@tiptap/extension-table`: 2 of the 32 records the neutral extraction
  finds) and in Next.js plugins (`@next/third-parties`: 0). The selection prompt was fitted on dev (the second kind)
  and so dropped the core changes AI SDK providers get today. No one wording fitted both on dev:

  | Dev (37 pairs, 39 base records) | F1 | Recall vs current | Precision vs current | Records | Verdict |
  |---|---|---|---|---|---|
  | `rep` (noise) | 92.7 | 66.7 | 86.7 | 30 | |
  | r0, registered (`d0a51dbf`): keeps shared parts of the family | 74.8 | 66.7 | 36.6 | 71 | fail (4) |
  | **r1 (`757f969d`, run on held-out)**: the package itself only | 83.8 | 38.5 | 68.2 | 22 | fail (5) |
  | r2: the package and the feature it plugs into | 82.4 | 69.2 | 42.2 | 64 | fail (5) |

  r1 was frozen for held-out as the best dev F1 (the slice 3d headline); no revision passed dev.
- **The shared extraction itself is fine.** Post hoc and descriptive only (not a registered arm, not adoptable):
  without the selection (`shared-all`, every package keeps the whole neutral extraction), held-out recall vs current
  is 93.1 (`rep` 80.2), terms Jaccard 45.7 (`rep` 47.6), breaking agreement 93.8 (`rep` 96.1), benefit 97.5 (97.5),
  but precision vs current 37.4 with 2,945 records (2.5× base). The neutral prompt finds what the per-package prompts
  find; only the per-package choice is missing. On dev the neutral prompt's terms differ more from production's
  (Jaccard 32–40 against `rep` 57.5 on 15–35 matched records), which the larger held-out does not show (45.7).

## Cost (provider-reported gateway $, Jev at $0.042/M input; step E not run)

| Arm | Held-out (45 pairs) | Dev (37 pairs) |
|---|---|---|
| `rep` (per package, as production) | $0.1284 gateway + $0.1084 Jev = **$0.2368** | $0.0189 |
| `shared` | $0.0442 + $0.0184 = **$0.0626** | $0.0195 (r1) |

On held-out, extraction is paid once per guide (69 gateway calls against 183) and labels once per record (203 Jev
calls against 1,208). Of `shared`'s held-out gateway $0.044, the selection calls are about half (the same units
without selection cost $0.023). On dev the design costs slightly more: most dev packages get `[]` per package (cheap), while
the neutral extraction writes every record once plus one selection call per package. On the production log of 19–20
October the guide spend was $0.336 (A $0.072, B $0.060, Jev labels $0.122, Jev judge $0.081), $0.25 of it on shared
guides, so a design that held quality would save roughly $0.15–0.20 a day at that mix.

Slice spend: gateway $0.298 of the $3.00 cap, Jev $0.209 of $0.50 (all arms, all splits, including the post hoc
`shared-all` runs: $0.039 gateway + $0.053 Jev).

## What could still work (not tested)

A selection that decides relevance the way the per-package extraction does would need to see what that extraction
sees. Two candidates for a new pre-registered slice, each fitted on a dev set that includes a provider family:
(1) the selection call also reads the guide text (input is cheap; output stays ids); (2) a Jev relevance question per
record and package. Both keep A + B + D shared. The in-flight join of identical model and classifier requests in
`design.patch` (llm.ts, adapter.ts) is independent of the design and could be adopted on its own; it changes no
answer.

## Method notes

- Base answers were replayed from the 20 October production state's caches with the network refused; 49 of the 1,183
  held-out base records had no cached label (not ingested) and are compared on extraction only.
- `shared` ran a unit's packages one after another (as production meets them); `rep`, `shared` and gold ran
  concurrently with separate caches and logs.
- Dev revisions: r0 → r1 → r2, each a full dev rerun with new caches (outputs `out/slice6/dev/shared-r0`, `shared`
  (r1), `shared-r2`; scores `score-r0.md`, `score-r1.md`, `score-r2.md`).
- The held-out set was run once per arm. Outputs: `out/slice6/<split>/<arm>/pairs.jsonl`, `score*.md`, `cost.json`,
  `gold/score/compare.txt` (gitignored).
