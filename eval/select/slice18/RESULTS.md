# Slice 18 results: the lineage bar

23 October 2026, under `PREREG.md` (pushed before any new label). One held-out look per round.

## Decision

**No change ships. LINEAGE_SAME_P stays 0.80.** No setting holds 1.0 false merges per 100 on dev, and both fitted
settings either keep held-out above the floor or lose recall.

| Held-out (21 technologies, 468 requests, 139 with a true lineage match) | Lineage merges | False per 100 (D, U) [95% CI] | Recall | vs production |
|---|---|---|---|---|
| **Production, 0.80** | 120 | **3.75** (1, 7) [2.9–12.7] | **80.6%** | — |
| Round 1, LINEAGE_SAME_P 0.94 (dev fit) | 95 | 3.16 (1, 4) | 64.7% | **22 lost, 0 gained, p 5e-7** |
| Round 2, 0.72 plus a lineage quote guard below 0.99 (dev fit) | 113 | 4.42 (2, 6) | 75.5% | 15 lost / 8 gained, p 0.21 |

| Dev (next, nestjs, prisma, 359 requests) | Merges | False per 100 | Recall |
|---|---|---|---|
| Production 0.80 | 219 | 6.85 (7 D, 16 U) | 84.8% |
| Every bar from 0.70 to 0.97 | 227 → 187 | 7.5 → 6.4 | 87.4% → 72.7% |

**Why no bar works:** the wrong lineage merges sit at p ≈ 1, so raising the bar removes true merges and leaves
the wrong ones. Most of the false rate is UNSURE, not DIFFERENT (held-out 7 U against 1 D). These are merged items
whose quote is a sentence listing several APIs ("These methods are deprecated…", "`serverRuntimeConfig` and
`publicRuntimeConfig` have been removed"). The item's own subject is not stored, so no reference can say which API
it was. **Counting only DIFFERENT, held-out production is 0.83 per 100.**

**Downstream:**
- **A lineage miss** leaves the same guide change as two records: a duplicate in the catalog and in reports, and a
  record's history split across guide versions.
- **A lineage false merge** folds one API's change into another's record, so the absorbed change (for example one of
  several removed options) disappears from reports.

## What would move it

The p-bar is the wrong lever. Two levers that could:
1. **Store each merged item's own brief** (subject, facet, summary) in the record's history. That makes these pairs
   labellable and lineage requests rebuildable, which also opens the wording and candidate-set levers.
2. **Extract one item per API from list sentences.** The ambiguity starts at extraction.

Both need their own pre-registration.

## Method and checks

- **Labels:** 2,551 lineage pairs from the whole production history (`lineage.mts`), two judges (agree 96.2%), 97
  disagreements. 19 were adjudicated in slice 17 and 78 here (`adjudicated.json`).
- **Answers:** production's recorded p (Jev 1.13 or 1.14).
- **Re-decision check:** at 0.80, the re-decision reproduces production on 791 of 827 requests. The 36 mismatches are
  requests where the recorded judged list does not determine the outcome (ties, or candidates my census marks lineage
  that production judged under another guard). This is stated, not corrected.
- **Splits:** dev is next, nestjs and prisma, which were already in use. Held-out is the other 21 technologies;
  slice 17's 82-request look came from it.

## Spend

$0.03 (J2 on the gateway); Codex on the plan; no Jev.
