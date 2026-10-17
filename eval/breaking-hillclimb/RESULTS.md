# Breaking hill-climb: results (15 October 2026)

Pre-registered in `PLAN.md` (commit e92c674, before any labelling call; P4 appended in a8a7b98 before any P4 call).
Scripts: `label.mts` (Jev/Luna through the adapter, cached), `codex_label.py` (Codex, batches of 12, cached),
`devrun.py` (relabelled store COPY → republish → replay `queue` → score with the final replay's match runs),
`analyze.py`. Raw numbers: `analysis.json`; review scores: `scores/review_P4-luna.json`.

**Reference (held-out):** the 241 of 251 records where both vault judges (Codex `pipeline`, Sonnet `reference`) agree
(143 breaking). The 10 judge disagreements have no recorded hand ruling and are left out. Codex `gpt-5.6-luna` was
one of the two judges (with the guide section as context), so Codex has a home advantage on this reference.

**Sanity:** republishing the store copy with the cached catalog labels gives a byte-identical catalog, the same
queue orders, 13 of 19 and tier-0 sizes 42 / 54 / 12, as in `eval/replay/RESULTS.md`.

## Held-out agreement and dev metric

Held-out: agreement on 241 (false breaking / missed breaking). Dev: covered key changes with their entry in the
first type-tier batch of 16 (Next / Prisma / Nest = total, of 3 / 10 / 6 = 19). Tier 0: Next / Prisma / Nest.

| Variant | Classifier | Held-out | FB / MB | Dev first 16 | Tier 0 |
|---|---|---|---|---|---|
| catalog (cached) | Jev, 8-question request | — | — | 0 / 10 / 3 = **13** | 42 / 54 / 12 |
| P0 rubric | Jev | 89.6% | 5 / 20 | 0 / 10 / 3 = **13** | 44 / 54 / 12 |
| P0 | Luna | 92.5% | 8 / 10 | 1 / 10 / 0 = 11 | 56 / 56 / 32 |
| P0 | Codex | 95.4% | 8 / 3 | 1 / 10 / 0 = 11 | 60 / 59 / 14 |
| P1 paraphrase | Jev | 84.6% | 4 / 33 | 0 / 10 / 3 = 13 | 40 / 54 / 11 |
| P1 | Luna | 90.5% | 6 / 17 | 0 / 10 / 0 = 10 | 36 / 53 / 17 |
| P1 | Codex | 92.9% | 11 / 6 | not run | |
| P2 obligation | Jev | 83.0% | 17 / 24 | 2 / 10 / 3 = **15** | 49 / 54 / 11 |
| P2 | Luna | 75.1% | 12 / 48 | 2 / 10 / 3 = **15** | 39 / 52 / 10 |
| P2 | Codex | 90.0% | 22 / 2 | not run | |
| P3 more context | Jev | 91.7% | 7 / 13 | 0 / 10 / 3 = 13 | 43 / 54 / 9 |
| P3 | Luna | 94.6% | 6 / 7 | 0 / 10 / 0 = 10 | 52 / 54 / 21 |
| P4 hill-climb | Jev | **95.4%** | 5 / 6 | 0 / 10 / 0 = 10 | 47 / 54 / 16 |
| P4 | Luna | 93.8% | 10 / 5 | 0 / 10 / 3 = 13 | 54 / 55 / 22 |

Baseline (slice-0 catalog, extraction's labels): 18 of 20. Codex ran P0–P2 on held-out and P0 on dev only (budget,
as pre-registered); P4 held-out would have taken it past ~150 calls with the reviews, so it was skipped. P4's
held-out number is in-sample (P4 was written from P0–P3's held-out errors).

## P0 vs P1 flips and P0 reproduction

| Classifier | Held-out flips (of 251) | Dev flips (of 493 extractions) |
|---|---|---|
| Jev | 16 (**6.4%**), all yes → no | 6 (1.2%), all yes → no |
| Luna | 20 (**8.0%**), 16 to no | 48 (**9.7%**), 46 to no |
| Codex | 11 (4.4%) | not run |

P0 asked alone reproduces the catalog's cached labels (asked inside the eight-question request): Jev 491 / 493
extractions (99.6%), 433 / 435 records; Luna 438 / 493 (47 more breaking); Codex 460 / 493 (29 more breaking).

## Pre-registered tests

- **Model issue** (Jev > 5 points below Codex or Luna under the same prompt): **fires narrowly at P0 against Codex
  only** (89.6 vs 95.4, −5.8; Codex is a reference judge). Against Luna −2.9 (P0), −5.9 (P1), −2.9 (P3); at P4 Jev
  leads (95.4 vs 93.8). Jev's error is a missed-breaking bias (silent behaviour/default changes, new methods for
  implementers) that one paragraph of prompt removes. It does not explain dev: fixing it lowers dev (P4-Jev 10).
- **Prompt sensitivity** (P1 flips > 5%): **fires for Jev (6.4% held-out) and Luna (8.0% / 9.7%)**, not Codex
  (4.4%). Jev's flips cost it 5 points of held-out agreement but leave dev unchanged (13).
- **Evalism** (dev up, held-out down, or dev up through tier-0 inflation): **fires for P2** for both classifiers:
  dev 13 → 15, held-out −6.6 (Jev), −17.4 (Luna), Codex −5.4. The gain is exactly two records the vault ruled not
  breaking (below); Next tier 0 grows 44 → 49 for Jev, so it is the specific labels, not general crowding.
- **Rubric/design** (classifiers agree with the reference under P0 and dev stays low): **fires.** All three agree
  with the rubric reference at 89.6–95.4%, and no rubric-faithful variant (P0, P1, P3, P4) for any classifier gets
  dev above the catalog's 13; the most accurate cell (P4-Jev, 95.4%) gets 10.

## The records behind the dev changes

Record labels (y/n, p(yes) for Jev and Luna) on the dev set, and the entry's type-tier rank:

| Record (key changes) | What the source says | catalog | P0 Jev / Luna / Codex | P2 Jev / Luna | P4 Jev / Luna | Rank: catalog → P2-Jev → P4-Jev |
|---|---|---|---|---|---|---|
| `next:proxy.ts` (Next K1) | "Add codemod for `middleware` to `proxy`"; Proxy replaces the deprecated Middleware convention | n .38 | n .32 / y .57 / y | y .95 / y .87 | n .19 / n .15 | 71 → 3 → 73 |
| `next:images.domains-domains` (K4) | "feat(next/image)!: deprecate and warn on `images.domains`" | n .00 | n .00 / n .00 / n | y 1.0 / y .99 | n / n | 44 → 7 → 49 |
| `next:turbopack` (K5) | "default --turbopack to true", `--webpack` opt-out | n .38 | n .38 / y .74 / y | n .30 / n .44 | y .84 / y 1.0 | 66 → 67 → 46 |
| `nestjs:esm-packages` (K1, K2, K8) | "All core Nest packages now ship as ESM"; CommonJS apps generally keep working | n .22 | n .16 / n .16 / n | n / n | n / n | 15 → 12 → 19 |
| `nestjs:vitest` (K9, K10, K12) | Vitest is the default for generated ESM projects; CommonJS projects keep Jest | n .04 | n / n / n | n / n | n .06 / y .53 | 25 → 22 → 26 |

- **Next proxy and `images.domains`** are deprecations that still work. The held-out reference agrees: `proxy-convention`,
  Next `Middleware` and `images.domains` are not breaking by both judges, and every classifier says no under P0/P1/P3
  (Luna and Codex say yes to dev `proxy.ts` under P0 because its record says "replaces"). Only P2 lifts them, which is
  the evalism case.
- **Turbopack** is breaking by the reference (held-out `turbopack-default` and notes `turbopack`: both judges true).
  Jev misses it under P0/P1/P2 (p .34–.39), Luna and Codex get it, P4 fixes Jev. But labelled breaking it still
  ranks 46–59: Next's tier 0 holds 42–60 breaking records, ordered by usage score, and the workout app barely uses
  Turbopack-specific terms. A correct label does not reach the first 16.
- **Nest ESM** is labelled not breaking by every classifier and variant on dev (the source says CommonJS apps keep
  working; the vault: "no labelling rule recovers that"). Its rank 12–25 depends only on how many other Nest records
  are tier 0: in at 9–12 tier-0 records, out at 14+ (Codex P0, Luna, P4-Jev). Held-out `ESM-only Nest packages`
  (judges: not breaking) is called breaking by Jev, Luna and Codex under P0 and not under P3/P4.
- **Nest Vitest** carries three key changes (Jest → Vitest), but it is a new-project default; only P4-Luna says yes
  (p .53, rank 2). Those three are a matching/entry problem (the replay notes `nestjs-vitest` "picked up three
  test-runner changes"), not a labelling one.

## Reviews (pre-registered step)

P2 fails the evalism test, and no other variant raises dev above 13. The best non-evalism cell by dev is a tie at 13
(P0/P1/P3-Jev, P4-Luna), broken by held-out agreement: **P4-Luna** (93.8%). Its first-16 batches differ from the
catalog's (6 / 8 / 16 ids changed in Next / Prisma / Nest). Arms `tier` and `all`, K=2:

| Batch | Next.js 16 | Prisma 7 | NestJS 12 | Total P4-Luna (of 19) | Catalog (RESULTS.md) | Baseline |
|---|---|---|---|---|---|---|
| Type tier, 16 | 0 | 10 | 0 | **10** | 10.5 | 17.5 |
| Whole queue (52–131) | 1.5 | 10 | 3 | **14.5** | 13.5 | 19.5 |

Same as the catalog within noise (Nest's three Vitest keys were in the tier batch at rank 2 and neither review
proposed them). Queue sizes 131 / 82 / 52 (vs 128 / 81 / 47): relabels moved bump-line records into the queue.

## Calls and cost

| | Calls | Tokens | Cost |
|---|---|---|---|
| Jev `jev-latest` (→ jev-1.13.0) | 3,604 | 2.59M input, 0.11M output | ≈ $0.11 ($0.042/M input) |
| OpenAI Decisions `gpt-6-luna` | 3,604 | 1.65M input | ≈ $0.17 ($0.10/M) |
| Codex `gpt-5.6-luna`, labelling | 115 (24 × 3 held-out, 43 dev), 0 failed | 1.50M input (1.15M cached), 36k output | subscription |
| Codex, reviews | 12 | 3.51M input | subscription |

All classifier calls are cached by request hash (a rerun makes 0 uncached calls; checked on held-out P0 Jev);
usage per call in the scratch `central/usage.jsonl` and `codex/usage.jsonl`. `~/unstale/.store` was only read.
`npm test` in `central`: 138 passed (no tests added).

## Caveats

- One run per (variant, classifier); no repeat-run noise estimate except P0-Jev's 99.6% reproduction.
- Held-out and dev share content (both cover Next 16, Prisma 7, Nest 12), so held-out is held out from the replay
  metric, not from the technologies.
- P3/P4 on dev label each merged record once; P0–P2 label each extraction and OR them (the pipeline's combine rule).
- The dev metric uses the final replay's two Codex match runs unchanged; only the queue is recomputed.
