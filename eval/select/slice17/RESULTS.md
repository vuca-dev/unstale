# Slice 17 results: held-out sets for the Jev request kinds with none, and the quote guard

23 October 2026, under `PREREG.md` (pushed before any answer or label) and its LIN amendment (pushed before any LIN
label). One look.

## Decision

**Ship C′.** Under the shorter rules SAME_P_SHORT goes to 0.82, CROSS_SAME_P_SHORT to 0.91 and a new
QUOTE_GUARD_BELOW_SHORT to 0.99. Every other request keeps 0.70 / 0.85 / 0.95.
- It holds the false-merge floor on every set it governs, with no significant recall loss.
- It decides ADV and DOCS exactly as production does.
- **C (0.99 for every request) fails.** QG shows 33 of the 35 production merges it would newly block are true.
- **LIN is above the floor under every arm, production included.** All three arms share LINEAGE_SAME_P 0.80, and the
  amendment kept LIN out of the quote-guard decision. It is a separate finding, below.

## Per set (Jev 1.14; reference = two judges, disagreements adjudicated by me)

| Set | Requests (population) | Labelled pairs (judges agree) | Production false per 100 [95% CI] | Production recall | C′ | C |
|---|---|---|---|---|---|---|
| **SHORT** (slice 16) | 1,598 | 330 | 2.3 (3 D, 5 U) [1.5–6.5] | 92.7% | **0.66**, 90.7% (−2.0, p 0.13) | as C′ |
| **ADV** advisory judge | 130 (570) | 787 (773) | **0** of 129 merges [0–2.8] | **99.2%** (129/130) | identical | identical |
| **DOCS** docs-page notes | 150 (683) | 1,050 (1,044) | **0** of 6 merges [0–46] | 6/7 | identical | identical |
| **LIN** lineage, held-out technologies (production's recorded answers) | 82 | 256 (243) | **3.1** (0 D, 1 U of 16) | **65%** (15/23) | identical | identical |
| LIN, all 150 sampled (descriptive: includes next, nestjs and prisma) | 150 (827) | 471 (454) | 2.8 (1 D, 1 U of 53) [0.5–13] | 76.1% (51/67) | identical | identical |
| **QG** C's newly blocked merges | 35 | 35 (29) | — | — | not blocked | **blocks 33 SAME, 1 U, 1 D** |

- **The scorer** equals match.ts `pick` at production's constants on 130/130 ADV and 150/150 DOCS requests.
- **ADV:** every sampled advisory has a true fix record among its candidates. The advisory judge is the
  strongest kind measured: no wrong merge, one miss.
- **DOCS:** natural prevalence is low (7 of 150 requests have a true match). The floor holds, but 6 merges cannot
  measure it well.
- **LIN:**
  - **Deviation:** the census drew 68 of its 150 requests from next, nestjs and prisma, which the pre-registration
    excludes. The held-out figure is the first LIN row; the second is descriptive.
  - Production merges 53 lineage pairs, one of them DIFFERENT and one UNSURE.
  - 10 of 70 SAME lineage pairs sit below the 0.80 bar.
  - Most pairs come from moving upgrade guides: next 114, nestjs 53, tanstack-react-query 51, prisma 48.
  - A merged item's own summary is not stored, so 9 of the UNSURE pairs are one list sentence ("these methods are
    deprecated …") that cannot be told apart.
  - **A lineage-bar refit needs its own set with rebuilt requests.**

## Surface (step D), 130 items

| | Value |
|---|---|
| Jev 1.14 accuracy (9 classes) | **84.6%** [77.2–90.3] |
| Actionable (≠ runtime_internal) accuracy | 93.8% |
| Configuration (the class `funnel.rs` keys on) | reference 3, Jev 5: recall 3/3, precision 3/5 |
| Main confusions (reference → Jev) | types_only → code_api 6; runtime_internal → code_api 6; code_api → schema_or_migration 2 |
| The question's share of a step-D request | 13.8% of characters, about $0.0014 per technology-year ($14 per 10k) |

**`surface` is read.** `local/cli/src/funnel.rs` keys config-key matching, option values, the runtime_internal
exclusion, command_line and tooling records on it, in about 10 places. Dropping it is not proposed. Its errors lean
toward `code_api`, which the funnel treats as ordinary code. The configuration class was too rare here (3 items) to
measure what the funnel depends on most.

## Method

- **ADV:** `advisory.mts` rebuilds judgeFix's requests from the current catalog, for 14 advisory-heavy technologies,
  with the advisory's own trace taken off its holders. Jev 1.14 answers fresh.
- **DOCS:** `build.mts` replays 9 docs technologies from empty with every stored docs event re-planned:
  1,032/1,032 decisions reproduce. 28 notes were extracted live.
- **LIN:** `lineage.mts`, a census of production history.
- **Labels:** `label.mts`. J1 is Codex gpt-5.6-luna and J2 is gpt-6-luna on the gateway. The two agree on 98% of pairs
  and 86% of surface items. My 61 adjudications are in `adjudicated.json`.
- **Scores:** `score17.mts` → `out/slice17/summary17.json`.

## Evalisms

- ADV candidates are today's records: their later merges are kept, while the advisory's own trace is removed.
- DOCS and ADV cannot separate C, C′ and P, because no pair sits in the quote-guard band. The quote-guard question is
  settled by QG (production history), not by these sets.
- LIN uses production's recorded p (1.13 or 1.14), not a fresh 1.14 run.
- The reference judges are LLMs and I adjudicated their disagreements. The labels are not human-audited.

## Spend

About $0.24: Jev 1.14 $0.20 (DOCS replays and ADV), gateway J2 $0.03 and extraction $0.01; Codex J1 on the plan.
