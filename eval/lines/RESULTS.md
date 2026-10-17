# Release lines from the release index (16 October 2026)

**Question.** The catalog defined a release line as the major (0.minor below 1.0): records kept the earliest release
per major, and the edge treated a version as having a change when a release on its major was at or below it. When an
older minor gets patches after a newer minor shipped (next 15.0.8 after 15.1.0), that hides backports. Example:
`next:react-server-components` (GHSA-9QR9, critical RCE, fixed in 15.0.5, 15.1.9, 15.2.6, 15.3.6, 15.4.8, 15.5.7 and
16.0.7) kept only 15.0.5 on line 15, so a project on 15.4.x or 15.5.6 was told it already had the fix. Does a line
derived from each technology's release index remove these errors without regressing anything else?

**Change.** Central (`central/src/pipeline/lines.ts`): per technology, the line depth is the smallest version-prefix
depth at which, in every prefix group, version order is publish order (stable releases in the window, same-day ties
allowed, prereleases ignored; cap 3). Records keep the earliest release per derived line, recomputed every run from
their sources, current releases and attached advisories' fixes (deterministic, no model calls). The tech index
publishes the release index (version, date, line, `line_start` on a line's zero version). `Release.line` keeps the
old rule (older edges, shard names). Edge (`local/cli/src/lines.rs`): v has a record's change iff a release on v's line
is at or before v (index position), or v's line began in the window (`line_start`) after a release of the record on an
older line. A version outside the index is placed by its numeric prefix at the index's depth; anything else, or a
catalog without an index, keeps the old rule.

**Measure.** `eval/lines/wrong.py <central> <catalog>` (adapted from the research script `wrong.py`, which counted 13
records / 542 version pairs on the live next store): every active next record × every stable next version on npm
published since 2025-06-01. Truth: registry dates, minor lines (a release the change shipped in, from the record's
sources and releases, on v's minor at or below v; or v's minor first published after the earliest of them).
Shown: the edge contract on the published catalog (`eval/lines/contract.py`, the reference for `lines.rs`). Wrong =
shown as having the change when the truth says not; missed = the reverse.

## Pre-registered decision rule (16 October 2026, 21:40, before the acceptance runs)

The wrong-pairs script was run once during development (on the live store and a first side-store build) to check
it works; the numbers below are from the final side store. Accept when all hold on the side store
`.store/central-lines` → `.store/catalog-lines` with the CLI built from HEAD plus the edge change:

1. next: **0 wrongly-available pairs** (in and outside the index), and no more missed pairs than before.
2. prisma and nestjs: derived depth 1 (no interleaving measured) and **no record's releases changed** (no churn).
3. Advisory metrics unchanged or better (eval/advisories/RESULTS.md, section of 16 October): 87/87 units dated,
   next-prisma-app digest 31/31, advisory precision 1.0, line precision ≥ 0.72.
4. Gate (`eval/gate/run_gate.sh`, K = 3): DEV CLI first 16 ≥ 31; `tier` review DEV not materially below 27.3
   (within the K = 3 range of the last run, 25–29); HELD-OUT reported once at the end.
5. `cd central && npm test`, `cd local && cargo test`, `cargo clippy --all-targets` (no new warnings),
   `scripts/dogfood.sh` green.
6. Generality: `eval/advisories/generality.mts` reports the derived depth for Django, tokio, golang.org/x/net and
   log4j-core, and Django's and tokio's backports dated per line (the five fixes the major-line rule collapsed:
   Django 4.1.7; tokio 1.20.4, 1.24.2, 1.43.1, 1.44.2).

## Results (16 October 2026, 22:50)

Side store `.store/central-lines3` (a `cp -cR` of the live store at 21:56) → `.store/catalog-lines3`, all three
technologies run with `npm run catalog -- advisories --offline` at 7b71334. CLI: HEAD's `local/` (`git archive`) plus
`local/cli/src/lines.rs` and its wiring in `funnel.rs` (committed later as ef19d09, after the other session's work in
`funnel.rs`/`main.rs` was committed as 517c2e4). The gate ran on `.store/catalog-lines2`, built
from a 21:45 copy at a3f4c14; for next/prisma/nestjs it differs from lines3 only in one record's evidence order and
label_version (`next:middleware-proxy~5`) and in two records another session changed on the live store meanwhile.

| | Before (live catalog, old rule) | After |
|---|---|---|
| next × npm versions since 2025-06-01: wrongly shown as having the change | **1,180 pairs, 28 records** | **0** |
| ... missed (shown as not having it when it has) | 0 | 0 |
| Derived depth: next / prisma / nestjs | (major) | **2 / 1 / 1** |
| Records whose releases changed: next / prisma / nestjs | | 17 / 0 / 0 |
| `next:react-server-components` releases | 15.0.5, 16.0.7 | 15.0.5, 15.1.9, 15.2.6, 15.3.6, 15.4.8, 15.5.7, 16.0.7 |
| Advisory units dated (old lines / derived lines) | 87/87 | 87/87 / 103/103 |
| next-prisma-app digest: recall, advisory precision | 31/31, 1.0 | 31/31, 1.0 |
| line precision | 31/43 = 0.72 | **31/44 = 0.70** (old edge on the new catalog: 31/43 = 0.72) |
| Gate DEV: CLI first 16 / `tier` review | 31 / 27.3 [25–29] | **31 / 27.3 [25–29]** (per event identical first-16 counts) |
| Gate HELD-OUT (reported once): first 16 / `tier` review | 6 / 5.0 | 6 / 5.0 [5–5] |
| `npm test` / `cargo test` (HEAD + edge) / clippy / dogfood | | 210 passed / all passed (cli 69 incl. 4 in `lines.rs`, e2e 4, schema 12) / no new warnings / 50 of 50 |

Also: the old wrong.py definition (same major, at or above the record's lowest release) counted 13 records / 542
pairs on the live store; the table counts every pair, including the old rule's carry-forward across majors
(`next:avif-image-optimization` 15.5.25 shown as already in 16.0.0–16.0.7).

**Decision: not accepted as pre-registered; accepted by the user (16 October 2026).** Every criterion holds except
line precision (≥ 0.72), missed by one line. The new line in the next-prisma-app digest is `next:next-og` [15.5.26]
("additional security hardening for next/og"): 16.4 began after 15.5.26 shipped, so by the contract 16.4.2 has it and
16.2.1 does not. The old rule said 16.2.1 already had it (15.5.26 < 16.2.1 numerically), which was false. The line is
correct and is not a duplicate: GHSA-VCVR (`next:next-og-imageresponse`, 16.3.6) affects 16.2.0–16.3.6 only (OSV), so
15.5.26's hardening is a separate change with no advisory, which the metric counts against precision. The user
accepted the trade (1,180 wrongly-available pairs fixed for one correct extra line), noting that past some level
extra lines are noise that outweighs a recall gain, so line precision stays watched.

**Live (16 October, 02:00):** the stale onboarding service (code from 20:26, which republished next without the
release index at 23:11 and 01:32) was stopped and not restarted; next, prisma and nestjs were republished under the
lock. Live checks: next's tech index carries 81 releases; `next:react-server-components` has 15.0.5, 15.1.9, 15.2.6,
15.3.6, 15.4.8, 15.5.7 and 16.0.7; no advisory on more than one next record; `wrong.py .store/central .store/catalog`
→ 0 wrong and 0 missed of 60,804 pairs; dogfood 50/50; next-prisma-app digest 31 advisory lines of 44 security
lines. The CLI was reinstalled with the wiring.

Generality: eval/advisories/GENERALITY.md (Django 2, tokio 2, golang.org/x/net 1, log4j-core 1; the five collapsed
fixes dated per line). Across the 81 technologies of the live store with a release index: depth 1 for 78, depth 2 for
next, react and @auth0/nextjs-auth0.

Cost: 0 Jev, 0 Codex in the stage (every run of the stage on the side stores). Evaluation: 102 Codex calls for the
advisory reference (`measure.mts`, two uncached runs of 51), about 74 for the gate (20 match, 54 review incl. 2 that
hit the Codex usage limit and were rerun after it reset).
