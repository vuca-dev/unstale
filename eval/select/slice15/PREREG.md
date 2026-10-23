# Slice 15 pre-registration: step E constants under Jev 1.14

Written 22 October 2026, before the fit below was computed and before the decision run existed. `jev-latest` now
serves `jev-1.14.0`. At production's SAME_P_SHORT / CROSS_SAME_P_SHORT 0.87 (QUOTE_GUARD_BELOW 0.95), its Q8 held-out
run makes 2.7 guarded false merges per 100, against the 1.0 floor (slice 14 `RESULTS.md`).

**Already seen (stated, not hidden):** in slice 14, the slice 5 fit with the quote guard free gave 0.82 / 0.91 / 0.99
on Jev 1.14's dev run. It scored 0.8 per 100 at 88.3% recall on held-out run `j2-Q8-heldout`. That look is spent.

## Fit (dev only)

- Data: the existing Jev 1.14 Q8 dev run `j2-Q8-dev` (within-source 72 + Prisma/NestJS guides).
- QUOTE_GUARD_BELOW stays 0.95. It is shared with advisories, docs and lineage requests, which these sets don't cover.
- SAME_P_SHORT and CROSS_SAME_P_SHORT are fitted by the slice 5 objective (`score5.mts --quote 0.95`):
  - grid 0.50–0.99, cross ≥ same;
  - maximise dev merge recall subject to guarded false ≤ 1.0 per 100;
  - ties go to the higher constants.

## Decision (held-out, one look)

- Data: a fresh Jev 1.14 Q8 held-out run `j2-Q8-heldout-r3`, unseen. The items are Nuxt plus the Next.js guide (236
  requests, 197 SAME items), the same items as slice 14's look; only the answers are new.
- **Ship the fitted constants** if both hold:
  1. Pooled guarded false merges ≤ 1.0 per 100.
  2. Merge recall is not significantly below the earlier production run (`j2-M8-heldout`, Jev 1.13 at 0.87, 175/197 =
     88.8%). Test: exact McNemar on SAME items, where p < 0.05 with fewer recalled is a fail; the paired bootstrap CI
     is shown.
- Otherwise don't ship, and report the false-merge/recall trade-off.
- Reported either way: r3 at production 0.87, so the drift is confirmed on unseen answers.

## Step D check (report only)

Jev 1.14 on H1 (`jev-heldout-qv1-r2`, which exists) and on a fresh H2 run (`jev-heldout2-qv1-r2`), against Jev 1.13,
at production's 0.5. Reported: breaking recall and precision, benefit-vs-none recall, actionable recall. A change ships
only if 1.14 at 0.5 is significantly worse than 1.13 on a floor metric and a dev refit clearly fixes it.

Budget: Jev ≤ $0.08. No SubQ, gateway or Cloudflare.
