# Slice 7 results: shared guide extraction + a Jev relevance question per record and package

20 October 2026. Pre-registration: `PREREG.md` (commit `3521927`, before any slice 7 call). Frozen revision r3 at
threshold 0.7 committed in `03d8d10` (`relevance.mts` blob `595b24ad`) before the held-out run. Runner `run7.mts`,
question and composition `relevance.mts`, scorer `score7.mts`, threshold sweep `thresh7.mts`, gold inputs `gold7.py`,
cost `cost7.py`.

## Decision

**Rejected. Guides stay extracted per package; `central/src` is unchanged.** The frozen revision fails both held-out
sets (F1, recall, records; terms Jaccard on AI SDK; benefit agreement on the family-disjoint set), gold, and cost:
on both held-out sets the design costs more than per-package extraction. No dev revision passed dev either.

| Condition (candidate `jev-r3`@0.7 against `rep`) | HELD-OUT (family-disjoint, 35 pairs) | HELD-OUT-AISDK (14 pairs) |
|---|---|---|
| 1. F1, ≤ 3 below | 95.2 → 88.2, −7.1 (−15.0…−1.1) **No** | 91.7 → 37.7, −54.0 (−77.5…−30.8) **No** |
| 2. Recall vs current, ≤ 5 below | 82.8 → 63.4, −19.4 (−50.0…−9.4) **No** | 76.2 → 36.9, −39.2 (−94.9…−16.2) **No** |
| 2. Precision vs current, ≤ 5 below | 85.6 → 88.1, +2.5 (0.0…4.4) Yes | 75.9 → 73.3, −2.6 (−30.1…10.1) Yes |
| 3. Records within ±10% of base | −28.0% (rep −3.2%) **No** | −49.6% (rep +0.4%) **No** |
| 4. Terms Jaccard, ≤ 5 below | 48.4 → 50.4 Yes | 51.0 → 36.7 **No** |
| 5. Breaking agreement, ≤ 3 below | 91.2 → 91.3 Yes | 97.0 → 96.8 Yes |
| 5. Benefit agreement, ≤ 3 below | 100.0 → 95.7 **No** (23 matched records) | 98.0 → 97.9 Yes |
| 6. Failed pairs | 0 Yes | 0 Yes |
| 8. Design costs less than `rep` | $0.0615 vs $0.0264 **No** | $0.0668 vs $0.0566 **No** |

**Gold (7), No:** neutral extraction + r3 for the guide's own package (Jev kept 184 of 187 records) against slice 3b's
baseline: required recall excl. unsure 91.3 → 72.1 (−19.2, CI −36.1…−2.8), breaking recall 88.1 → 72.2 (−15.9,
−32.5…−0.7), precision 80.7 → 72.8 (−7.9). The 3b replicate's noise: −9.6, −7.1, −1.1. The loss is the neutral
extraction's on a package's own guide, not the relevance question's (it dropped 3 records).

## Dev (33 pairs, 869 base records; `rep` F1 79.3, recall 80.6, precision 78.9)

| Revision (threshold, dev-F1-best) | What Jev is asked | F1 | Recall | Precision | Records |
|---|---|---|---|---|---|
| r0 (0.7) | one question: this package's own change, or a shared-core change its users meet | 46.4 | 89.0 | 55.1 | +62% |
| r1 (0.6) | r0 + the guide part's headings and a conditional rule (core only on parts without per-package sections; not for plugins) | 50.9 | 73.4 | 60.8 | +21% |
| r2 (0.7) | simple judgments composed in code: own, core, provider(package), one-backend(record) per part | 50.6 | 73.2 | 73.3 | −0.1% |
| **r3 (0.7), frozen** | r2 with own × (1 − core) for non-core packages, and a core-package question | 53.5 | 69.5 | 80.3 | −13.5% |

## Why it fails

- **Today's per-package choice is mostly an artifact of how the extraction sees the guide, not a relevance rule a
  question can state.** On multi-part guides the per-package extraction keeps or drops whole parts: AI SDK 7.0,
  `@ai-sdk/mistral` keeps 25 of 25 records of part 2 and 2 of 25 of part 1, `@ai-sdk/groq` keeps 1 of 23 of part 3; on
  single-part guides (4.0, 6.0) most providers keep only their own section, except `@ai-sdk/alibaba` (29 of 34 on
  6.0) and providers with no section, which keep none or one record. The fresh replicate reproduces these choices (same prompt,
  same chunks), a per-record question does not.
- **One long conditional question is not followed.** r0/r1 put p(yes) near 1 for every provider on every guide.
  Composing short judgments (r2/r3) fixes part of 6.0 (5 of 13 non-core packages at F1 100, from 0–13 in r0) and
  keeps 7.0's model providers at 76–93 (but `@ai-sdk/gateway` at 2), while plugins, bindings and utilities lose their records (`@ai-sdk/react`, `@ai-sdk/otel`,
  `provider-utils`, `@react-router/*`, `eslint-config-next`: F1 0), and held-out AI SDK 4.0 providers lose their
  single record while 5.0's `provider-utils` loses all 42.
- **The relevance calls eat the saving where per-package extraction is already cheap.** A question costs about 630
  Jev input tokens ($0.000026). Families whose packages get few records today (Next.js plugins, AI SDK 4.0 providers)
  pay little per package; the design extracts the whole guide and asks one question per record and package.

## Cost (provider-reported gateway $; Jev at $0.042/M input; step E not run)

| Split | `rep` (per package) | Shared A + B + D | Relevance (Jev) | Design total | Saving |
|---|---|---|---|---|---|
| Dev (r3) | $0.1727 | $0.0251 | $0.0491 (1,872 calls) | $0.0741 | 57% |
| Held-out | $0.0264 | $0.0352 | $0.0263 (1,059) | $0.0615 | −133% |
| Held-out AI SDK | $0.0566 | $0.0308 | $0.0361 (1,418) | $0.0668 | −18% |
| All 15 units | $0.2556 | $0.0910 | $0.1114 | $0.2024 | 21% |

Without the relevance calls the shared extraction alone would save 64% over the 15 units; the Jev calls take 0.11 of
the 0.16 saved. At the production log's mix (guides $0.336 a day, $0.25 on shared guides) the design would save about
$0.05 a day if it held quality; it does not, so the steady-state saving of this slice is $0.

Slice spend: Jev $0.271 of the $0.50 cap (dev r0–r3 $0.199, held-out $0.062, gold $0.009); gateway $0.000 of $3.00
(gold's extraction and labels were answered from slice 6's gold cache; no chat fallback fired).

## What could still work (not tested)

Sharing only what is identical today: the in-flight join of identical requests (slice 6 `design.patch`, llm.ts and
adapter.ts) changes no answer. A shared extraction that wants per-package agreement would have to give each package
the part-level view the per-package extraction has (one call per package and part over the neutral records), which
is a selection call again and costs what slice 6's did.

## Method notes

- `base` and `rep` are slice 6's runs (`out/slice6/{dev,heldout}`); the shared extraction is slice 6's `shared-all`
  (every package keeps every neutral record); each slice 7 arm only adds the relevance calls, with its own empty
  classifier cache.
- Thresholds were swept per revision on dev from `probs.jsonl` without new calls (`thresh7.mts`), as registered.
- Outputs (gitignored): `out/slice7/<split>/jev-rN/{pairs,probs}.jsonl`, `score-*.md|json`, `cost.json`,
  `gold/score/compare.txt`.
