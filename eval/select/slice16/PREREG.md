# Slice 16 pre-registration: step E constants under Jev 1.14, on a fresh set

Written 22 October 2026, before the fresh set below existed: no run, no answer and no verdict yet. Slice 15 showed
that Jev 1.14 at production's constants makes 2.4–2.7 guarded false merges per 100 on the slice 5 held-out set,
against a floor of 1.0. The coordinator asked for the candidate below to be validated on requests it has never seen.

## Arms (every arm on the same requests and answers)

| Arm | SAME_P_SHORT | CROSS_SAME_P_SHORT | QUOTE_GUARD_BELOW | Origin |
|---|---|---|---|---|
| **P** (production) | 0.87 | 0.87 | 0.95 | `thresholds.ts`, `match.ts` |
| **C** (candidate) | 0.82 | 0.91 | 0.99 | slice 14's free-quote dev fit on Jev 1.14; seen on the slice 5 held-out set |
| **F** (fallback) | 0.97 | 0.97 | 0.95 | slice 15's pre-registered fit |

## Fresh set

- **Technologies:** nx, langchain-core, openvino and astro, whole. They are in no eval set, and they are the
  production catalog's richest sources of judged pairs after electron, whose 849 pairs are too many to adjudicate.
  Astro brings the upgrade-guide pairs.
- **Build** (`build.mts`): the restored production state (`catalog-state`, generation
  `state-20261023T014649Z-…`, read only) is cloned to a side store. Each technology's records are removed and it is
  re-ingested from empty:
  - by the catalog pipeline's `runTechnology`, offline;
  - stored release lists, notes and guides;
  - no docs, no advisories, no publish;
  - extraction from the production LLM cache. Astro's 113 uncached notes are extracted live; nothing else is.
  - Jev (`jev-latest` = 1.14) live, with an empty classifier cache, at production's constants.

  A replay from the run's own extractions and answers then rebuilds every judge request with its candidates as they
  stood. The replay must reproduce the run's decisions.
- **Pairs** (the Nuxt held-out method, `eval/heldout/audit.mts`): every (request, candidate) asked with Jev p ≥ 0.5.
  The main set is the requests the constants govern: `shortRulesApply` (release notes and guides, no lineage).
- **Reference:** Codex gpt-5.6-luna under the v3 identity rules (audit.mts's prompt, 12 pairs a call). Then I read every
  pair, blind to the arms, and give SAME / DIFFERENT / UNSURE. Codex's verdict is the default; where I differ, it is
  listed.

## Metrics (slice 5's, each arm re-decided per request by `match.ts` `pick` with the arm's constants)

- Guarded false merges per 100 merges = 100 × (DIFFERENT + 0.5 × UNSURE) / merges, with the exact 95% interval.
- Merge recall = items with an audited SAME pair that merge into a SAME candidate / items with an audited SAME pair.
  This is recall within Jev's p ≥ 0.5 pair set.
- Paired against P: exact McNemar on SAME items (recall) and on merged items (false-merge indicator), plus a paired
  bootstrap CI of the recall difference.

## Other request kinds sharing QUOTE_GUARD_BELOW (descriptive)

Advisory, docs and guide-against-guide requests (not lineage) keep SAME_P 0.70. Their quote guard moves with C. The
check uses the whole production history (full read-only restore). It finds every merge whose target already held
evidence of the incoming item's kind, whose recorded p was in [0.95, 0.99), and whose quote is not near-identical to
one of the target's quotes of that kind. C would newly block these. I adjudicate them all, or a seeded sample of 40 if
there are more. **No regression** means the newly blocked merges are not mostly true ones: blocked SAME ≤ blocked
(DIFFERENT + UNSURE).

## Decision

1. **Ship C** if, on the fresh main set: C's guarded false merges ≤ 1.0 per 100; C's recall is not significantly
   below P's (McNemar p < 0.05 with fewer recalled = fail); and the other kinds show no regression.
2. **Otherwise ship F** if F's guarded false merges ≤ 1.0 per 100 and its recall is less than 3.0 points below P's
   (point estimate).
3. **Otherwise production stays**, and the trade-off is reported.

A shipped arm changes `thresholds.ts` (SAME_P_SHORT, CROSS_SAME_P_SHORT) and, for C, `match.ts` QUOTE_GUARD_BELOW,
with tests. One look: the set is scored once, after adjudication is complete.

## Budget

Total ≤ $3: Jev (labels and judge on four technologies), the gateway (astro's extraction), Codex on the plan.
