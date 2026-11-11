# Change events: catalog size

What the change-event shards (central/src/pipeline/events.ts) add to the published catalog, before deploy.

```sh
# on a copy of a central store (it records and publishes events into the store it is given)
UNSTALE_STORE=<copy> npx tsx central/scripts/events-size.ts
```

## 10 November 2026

**Measured, local store** (an operator store of 18 October 2026: 203 technologies, 94 with release notes; release notes
and upgrade guides read offline; docs changes not included). Window 2025-10-15 to 2026-10-18 (1.01 years).

| | |
|---|---|
| Events (one per release note or guide) | 3,218, in 3,245 chunks |
| Source text | 4.96 MB |
| Event shards, gzipped | **1.62 MB**, 224 shards (one per technology and release line) |
| Per event | 504 B |
| Per technology-year | **7.9 KB** over all technologies; **17.1 KB** over those with release notes |
| Per technology | p50 6.4 KB, p90 43.8 KB, max 150.5 KB (next); largest shard 147.5 KB |

**Projected, live catalog** (4,284 technologies on 10 November 2026; 200 indexes sampled read-only): 17.3 releases per
technology (92.5% with any), so about 4,284 × 17.3 × 504 B ≈ **37 MB** of event shards, about 8.7 KB per
technology-year, beside about 28 MB of record shards (6.6 KB per technology sampled). Measured on the live catalog
only after deploy: the first export prints the event shards' bytes with the records' (`catalog export`, `bytes`).

- Below the 32 KB per technology-year expected: most technologies publish short notes; a few (next, posthog-js,
  sentry, astro) hold most of the bytes.
- Hosting: no file is near the 25 MiB limit. Event shards add about 1.6 files per technology plus their grace copies;
  the deploy packs files beyond the 20,000-file limit into its buckets (gateway/scripts/pack.ts), event shards first,
  since no client reads them by default yet.
- A release line's shard is rewritten on each release of the line, as record shards are: a client with the switch on
  downloads the line again (posthog-js: 531 releases on line 1, 105 KB).
