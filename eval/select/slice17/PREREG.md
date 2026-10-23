# Slice 17 pre-registration: held-out sets for the Jev request kinds with none, and the quote guard

Written 23 October 2026. At this point the request builders exist and their request counts are known (dry runs). No
Jev answer, reference label or score exists for any set below. The user approved this coverage work.

## Sets

Every technology in these sets is outside slices 2–16, and outside next, prisma, nestjs, nuxt and the step-D held-out
technologies. The source is the restored production state (`catalog-state`, generation `state-20261023T014649Z-…`,
read only, cloned to side stores).

| Id | Kind | Source | Size |
|---|---|---|---|
| **ADV** | Advisory judge (`advisories.ts` judgeFix). Requests rebuilt from the current catalog by `advisory.mts`, exactly as judgeFix builds them (pool, order, K). The advisory's own trace is taken off its holders. Advisories that production linked by id without a judge are left out. | vm2, pillow, pypdf, axios, hono, electron, aiohttp, undici, gitpython, dompurify, pyjwt, react-router, nodemailer, better-auth: 570 requests | **130 requests**, seeded sample (sha256("slice17-adv:" + key) order) |
| **DOCS** | Same-or-new on docs-page edit notes (incoming kind `docs`), lineage pairs excepted | `build.mts` (slice 16's builder with the docs module on: ledger moved aside, every stored docs event re-extracted, ingested in pipeline order) over effect-platform-bun, effect-vitest, pandas, langsmith, langchain-langgraph-checkpoint, langchain-anthropic, langchain-openai, qdrant-js-client-rest and sphinx. Live extraction only for the 28 uncached notes of the two effect packages. | **≤ 150 requests**, seeded sample if more |
| **LIN** | Lineage (`sameLineage` true for some candidate; the bar is LINEAGE_SAME_P) | Every lineage request in the DOCS replays, a census | All; n reported (expected below 100) |
| **SURF** | Step D `surface` | Incoming items of the DOCS replays (release notes and docs), with the run's own Jev 1.14 label answer | **130 items**, seeded sample |
| **QG** | The 35 production merges that a 0.99 quote guard would newly block outside the short rules (slice 16 `otherkinds.json`) | Production history | All 35 |
| **SHORT** | Short-rules requests | Slice 16's fresh set: answers and pairs as scored there | 1,598 requests, 248 SAME items |

DOCS natural prevalence: a request is a docs incoming item that had at least one candidate. Most such requests have
no true match, and that is kept.

## Reference labels (slice 5's method: two judges, disagreements adjudicated)

- **ADV, DOCS, LIN:** every candidate of every sampled request is labelled, not only those Jev scored high, so recall
  is not limited to Jev's pair set.
- **QG:** the 35 pairs.
- **Judges:** J1 Codex gpt-5.6-luna (the plan) and J2 `openai/gpt-6-luna` on the AI gateway (reasoning low). Each gets
  `eval/heldout/audit.mts`'s prompt and v3 identity rules, 12 pairs a call. ADV adds the pipeline's ADVISORY_RULE
  sentence.
- **Adjudication:** where J1 and J2 differ, I decide SAME / DIFFERENT / UNSURE, blind to the arms and to Jev's p.
  Where they agree, their verdict stands. For QG, my slice 16 verdicts are not used; the disagreements are
  adjudicated afresh.
- **SURF:** each judge picks one of `vocab.ts`'s SURFACES for the record (subject, summary, quote, technology), given
  the surface definitions. Disagreements are adjudicated by me, blind to Jev's answer.

## Arms (scored on Jev 1.14's answers to the same requests)

| Arm | Short-rules requests (same / cross / quote) | All other requests (same / cross / quote) | Lineage |
|---|---|---|---|
| **P** (production) | 0.87 / 0.87 / 0.95 | 0.70 / 0.85 / 0.95 | 0.80 |
| **C** | 0.82 / 0.91 / 0.99 | 0.70 / 0.85 / **0.99** | 0.80 |
| **C′** (scoped) | 0.82 / 0.91 / 0.99 | 0.70 / 0.85 / 0.95 | 0.80 |

The decision is `match.ts` `pick` with the arm's constants, as in slice 16's `score16.mts`, which matches `pick` at
production constants on 1,598/1,598 requests.

## Metrics, per set

- **False merges per 100 merges** = 100 × (DIFFERENT + 0.5 × UNSURE) / merges, with the exact 95% interval.
- **Recall** = items with at least one SAME candidate that merge into a SAME candidate / items with at least one SAME
  candidate.
- Paired against P: exact McNemar on recall items and on merged items.
- **QG:** the share of SAME among the 35. This is what C would lose outside the short rules, scaled to the 3,903
  production merges.
- **SURF:**
  - Jev 1.14's surface accuracy against the reference (all 9 classes);
  - actionable accuracy (surface ≠ runtime_internal) and configuration recall and precision (the local CLI's funnel
    keys on `configuration`);
  - the confusion of the top classes, with 95% intervals;
  - the surface question's token share of a step D request, and its $ per technology-year at the step D cost.
- **Use of `surface`:** a code census of what reads it (already done: `local/cli/src/funnel.rs` reads it in about ten
  places). It is reported with the accuracy; dropping it is not proposed if something reads it.

## Decision (the quote guard)

An arm **ships** only if, on every set (SHORT, ADV, DOCS, LIN; QG through ADV, DOCS and LIN as other kinds, and on
its own):
1. guarded false merges ≤ 1.0 per 100 (point estimate; a set with no merges passes); and
2. recall is not significantly below P (McNemar p < 0.05 with fewer recalled = fail).

C fails if QG's SAME share means it newly blocks more true merges than wrong ones (slice 16's rule). If C and C′ both
pass, C′ ships (the narrower change). P cannot ship: it is production, and it fails SHORT (2.3 per 100). If neither
passes, production stays and the per-set trade-off is reported. A shipped arm changes `thresholds.ts` and `match.ts`
(a short-rules quote constant for C′), with tests.

One look: each set is scored once, after its labels are complete.

## Budget

≤ $10 in all: Jev 1.14 (DOCS replays, ADV requests), the gateway (J2, the uncached effect extractions); Codex on the
plan.
