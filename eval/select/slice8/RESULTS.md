# Slice 8 results: skip release-boilerplate chunks before step A

20 October 2026. Pre-registration: `PREREG.md` (commit `a16af81`, pushed before any held-out decision, held-out
replicate call or gold check). One look at each held-out split. Scorer `score8.mts`, gold `gold8.mts`, replicate
`rep8.mts`.

## Decision

**Passes; shipped in `central/src/pipeline/extract.ts`** (`contentFree` now also holds when every line is release
boilerplate, `releaseBoilerplate`). No record is lost beyond a fresh replicate's noise on either held-out split, and
none on gold. **The saving is small.** Skipped chunks are cheap ones. On 19 October, the one full day after the cut,
the filter saves about $0.018 of step-A spend across all phases, most of it in onboarding. In monitoring it saves
$0.0004 a day: `[]` answers were $0.0101 of monitoring's $0.1203 step-A spend that day, and nearly all of them were
real release notes that the model judged irrelevant, which no generic line rule can tell apart.

| Condition | HELD-OUT (time + family, 1,486 chunks) | HELD-OUT-TIME (5,492 chunks) | Pass |
|---|---|---|---|
| Skipped chunks (of them answered `[]` in production) | 22 (21) | 568 (568) | |
| 1. Records lost vs production ≤ replicate noise | 1 of 7,405 = 0.01% (CI 0.00…0.04) ≤ 0.45% (CI 0.09…1.07) | 0 of 18,270 = 0.00% ≤ 0.45% | Yes |
| 2. Records lost ≤ 0.5% | 0.01% | 0.00% | Yes |
| 3. Gold: lost labelled groups | guides 0 of 193; majors 0 of 510; held-out set 0 of 270 (1 of 43 chunks skipped) | | Yes |
| 4. Step-A $ saved | $0.0009 of $0.3637 (0.25%) | $0.0189 of $1.0442 (1.81%) | Yes |
| Replicate on skipped chunks: chunks with records | 0 of 22 | 0 of 568 | (reported) |

Noise is the share of production records sitting in chunks that a fresh step-A call answered `[]`: 11 of 1,255
HELD-OUT chunks with records (DEV calibration: 4 of 300, 0.26%). The one lost record is a "### Changed / - Initial
release" note (`metamask-test-dapp-bitcoin` 0.1.0), where the fresh call also answered `[]`.

## Saving at the production mix (`score8.mts --days`, provider-reported step-A $ of the skipped chunks)

| Day | Step-A $ (all phases) | Skipped | Monitoring step-A $ | Monitoring `[]` $ | Monitoring skipped |
|---|---|---|---|---|---|
| 2026-10-18 (pre-cut, bulk onboarding) | $1.8634 | $0.0295 | — | — | — |
| **2026-10-19 (full day)** | $0.9743 | **$0.0175** | $0.1203 | $0.0101 | **$0.0004** |
| 2026-10-20 (partial) | $0.4335 | $0.0023 | $0.0561 | $0.0043 | $0.0002 |

That is about $0.02 a day at the 19 October mix (≈ 1.8% of step-A spend), rising with onboarding volume. Step B and
Jev are unchanged, because neither is ever called for a `[]` chunk.

## What the `[]` spend is

- Across the whole inventory, `[]` chunks are 5% of step-A dollars (DEV) and 8% of monitoring's step-A dollars on
  19 October. They are mostly short release notes with real but minor content (bug fixes, chores, internal
  refactors). The model drops these by judgment. Any line rule that catches them also drops records: on DEV,
  `chore:` items lost 14 records and "see the changelog" pointers lost 6 (Next.js CVE releases).
- Content-free shapes are what generalise: lerna's "version bump only" (the largest class), changesets and
  conventional-changelog section labels with credits, dependency-update lists, and bare dependency bumps. Repeated
  chunks were not used, because 7 of 52 later copies of a `[]` chunk got records.

## Change after registration (a strict subset)

The registered `deps` class matched any line starting "Updated dependencies", including a sentence that an existing
central test keeps as content ("- Updated dependencies can now be configured per client"). The shipped rule takes
only the changesets header (hashes, PR numbers or inline `pkg@version`). This change was made before any held-out
number was read, and only the gold check had been run (0 lost). Over all 39,783 inventory chunk texts it differs from
the frozen candidate on 4 texts, all of which it now keeps. Both variants are scored above (`--impl frozen|central`),
with identical results except one HELD-OUT-TIME `[]` chunk the shipped rule now sends. The shipped function equals
`skip.ts` with `FROZEN` on every other inventory chunk (parity checked). The existing test
"`chore(deps): bump webpack-sources to v3` is content" is reversed by the registered `bumps` class (0 records lost on
any split). Note: `fit.mts` tables were produced against `origin/main`'s `contentFree`; on this branch `skip.ts`
inherits the shipped classes.

## Spend

Gateway $0.432 of the $2.00 cap (DEV calibration $0.06, HELD-OUT and skipped-chunk replicates $0.37). Jev $0. The
state was restored read-only from the `catalog-state` release (generation `state-20261020T142253Z-39418632257-1`).
Nothing was written to it.
