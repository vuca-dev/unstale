# Slice 16 results: step E constants under Jev 1.14, on a fresh set

22–23 October 2026, under `PREREG.md` (pushed before the set existed). One look.

## Decision

**Production stays: SAME_P_SHORT / CROSS_SAME_P_SHORT 0.87, QUOTE_GUARD_BELOW 0.95.** Neither arm meets the rule.
- **C (0.82 / 0.91 / quote 0.99)** passes on the fresh set but fails the other-kinds check. Raising the shared quote
  guard would have blocked 31 true production merges outside the short rules, to remove 1 DIFFERENT and 2 UNSURE.
- **F (0.97 / 0.97 / 0.95)** misses the floor (1.17 per 100) and loses 8.5 recall points.

**The drift is confirmed a third time, on requests no arm has seen:** production makes 2.3 false merges per 100.

## Fresh set

- **Technologies:** nx, langchain-core, openvino and astro, whole, re-ingested from empty from the restored
  production state (`build.mts`).
  - Every replay reproduces its run: 749/749, 247/247, 291/291 and 866/866 decisions.
  - That gives 1,598 short-rules judge requests and 330 pairs at Jev p ≥ 0.5, 23 of them guide vs notes.
- **Reference:** Codex gpt-5.6-luna under the v3 rules, then my reading of every pair, blind to the arms
  (`verdicts.json`). I changed 49 of Codex's 330 verdicts, giving 250 SAME, 52 DIFFERENT and 28 UNSURE.
  - Deprecation-announcement vs removal pairs were marked UNSURE throughout.
  - Two kinds of Codex error stood out: identical announcements called different, and follow-up fixes called the
    same as the original.
- The re-implemented decision equals match.ts `pick` at production's constants on 1,598/1,598 requests.

| Arm | Merges | **False per 100** (D, U) [95% CI] | **Recall** (248 SAME items) | vs P: recall lost / gained, McNemar p | False merges removed / added vs P |
|---|---|---|---|---|---|
| **P** 0.87 / 0.87 / 0.95 (production) | 238 | **2.3** (3, 5) [1.5–6.5] | **92.7%** | — | — |
| **C** 0.82 / 0.91 / 0.99 | 228 | **0.66** (0, 3) [0.3–3.8] | **90.7%** | 6 / 1, p 0.13 (−2.0 pts) | 5 / 0, p 0.06 |
| **F** 0.97 / 0.97 / 0.95 | 213 | **1.17** (1, 3) [0.5–4.7] | **84.3%** | 21 / 0, p 1e-6 (−8.5 pts) | 4 / 0 |

## Other request kinds (`otherkinds.mts`, the whole production history: 2,703 technologies, 3,903 merges)

- 795 merges were same-kind and outside the short rules.
- 185 of them had p in [0.95, 0.99). 35 of those have no near-identical quote, so C would newly block them: 19 guide
  vs guide (not lineage), 14 release notes against records that hold other kinds, and 2 docs.
- My verdicts (`otherkinds-verdicts.json`): **31 SAME, 1 DIFFERENT, 2 UNSURE**, so blocked SAME (31) > DIFFERENT + UNSURE
  (3). **That is a regression.**
- They are mostly upgrade-guide restatements of one change (Next.js 16, Jest 29/30) and release notes restating
  their own advisory.
- Approximation: whether a request used the short rules is judged from the kinds its candidates hold now. That can
  only over-count non-short requests.

## For the coordinator (not pre-registered, not shipped)

The quote guard is what fails C, not the short-rules constants. Variant **C′** applies the 0.99 quote guard only under
the short rules (a `QUOTE_GUARD_BELOW_SHORT`) and leaves other requests at 0.95.
- On this set it equals C: every scored request is short-rules.
- By construction it blocks none of the 35 production merges above.
- Shipping it needs its own pre-registration and a look the C′ form has not had. Every number here was seen while
  designing it.

## Evalisms

- Recall is within Jev's p ≥ 0.5 pair set.
- The verdicts are mine, made after Codex's. They were made blind to the arms but not to p, since the pair set is
  p ≥ 0.5.
- The run's own decisions at production's constants shaped which candidates later requests saw (as Nuxt's did).
- One technology's run (astro) used a live extraction of 113 notes; the others came from the production cache.

## Spend

$0.40: Jev 1.14 $0.30 (7.06M input tokens), gateway gpt-6-luna $0.10 (astro extraction), Codex on the plan. No
production store was written: the state was restored read-only into a side store, and nothing was published or saved.
