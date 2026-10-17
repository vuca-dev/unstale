# Upgrade guides in the catalog: replay (15 October 2026)

Final `catalog-v2` (release notes + guides, rarity sample, cross-source rule p ≥ 0.85). `eval/replay/run_replay.py`
setup/queue/match (Codex, two runs) unchanged; queue orders with the sample weights (`../rarity-sample/rarity_queue.py
--weights sample`); then reviews, arms tier and all, K=2, Codex. Condition `orig` throughout, as in
`eval/replay/RESULTS.md`; Laravel not covered.

| | Release notes (RESULTS.md) | + guides, harness weights | + guides, sample weights |
|---|---|---|---|
| Key changes with an entry (of 40) | 19 (3 / 10 / 6) | **23** (6 / 11 / 6) | 23 |
| In the type-tier first 16 | 13 (0 / 10 / 3) | 11 (2 / 6 / 3) | 10 (1 / 6 / 3) |
| In the usage first 16 | 14 | 11 | 15 (2 / 7 / 6) |
| Queue size | 128 / 81 / 47 | 176 / 106 / 61 | same |
| Tier 0 (breaking) records in the queue | 42 / 54 / 12 | 72 / 75 / 18 | same |
| Found by the review, tier batch (mean of 2) | 10.5 | | **8** (0.5 / 6 / 1.5) |
| Found by the review, whole queue (mean of 2) | 13.5 | | **17.5** (5 / 11 / 1.5) |
| Required (classifier label) covered / found tier / found whole | 17 / 9.5 / 12.5 | | 21 / 7 / 16.5 |

- **Duplicates in the first tier batch:** none among the audited guide↔notes pairs. Reading the three batches: one
  cross-source near-duplicate (Prisma guide "driver adapters required" beside the notes record "PrismaClient needs a
  driver adapter or accelerateUrl", judged below 0.5 at ingest), plus notes↔notes near-duplicates that were already
  there (three PrismaClient-constructor records).
- **Crowding, not duplication, is what costs the tier batch:** guides add 30 breaking records to Next.js's tier 0 and
  21 to Prisma's (vault: "guides mark most items breaking"). Prisma's first tier batch held 10 key entries before and 6
  now. The whole-queue review gains most (13.5 → 17.5), from Next.js entries only the guide carries.
- Reviews: 12 Codex calls, 3.51M input (2.83M cached), 75k output. Match: 6 calls, 157k input.
