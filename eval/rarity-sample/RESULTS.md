# Rarity sample: deterministic replay queue (15 October 2026)

`rarity_queue.py` runs the harness's replay queue (condition `orig`, as in `eval/replay/RESULTS.md`) with the term
weight swapped; no model call. Match results reused from the 15 October final replay (record ids unchanged: only term
counts differ). Catalog: `catalog-v2` with the sample, before guides. Key changes whose entry is in the first batch of 16:

| Weights | Usage order (Next / Prisma / Nest) | Type tier (Next / Prisma / Nest) |
|---|---|---|
| Harness corpus (as RESULTS.md) | **14** (2 / 6 / 6) | **13** (0 / 10 / 3) |
| No sample: catalog's own terms (the edge at `sample_n: 0`) | 13 (1 / 6 / 6) | 13 (0 / 10 / 3) |
| Central sample, n = 5 (the edge now) | 10 (2 / 2 / 6) | 13 (0 / 10 / 3) |

The Prisma key entries match only terms every Prisma 7 project has (`datasource`, `DATABASE_URL`, `process.env`,
`generate`, `schema.prisma`: 5 of 5 sample repositories), so the sample gives them the minimum weight and records with
rarer matches go ahead. That is the weight working as designed; it shows those key entries had no specific term.
Three events: not a measurement of the sample's value (the vault's 233-adoption set is).

```sh
python3 ../replay/run_replay.py --catalog CAT --work W setup; cp -c <final>/replay/<ev>/match.json W/replay/<ev>/
python3 rarity_queue.py --catalog CAT --work W --weights harness|fallback|sample
python3 rarity_queue.py --catalog CAT --work W --weights sample --score
```
