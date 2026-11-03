# performance agent log

## Revisit
- 2026-11-03: docs pass outcome mix (not_modified / unchanged / changed per pass) is not logged; adding it to `coverage_stages` would size the PR #207 gain fleet-wide and show which hosts answer 200 to conditional requests (django, expo, builder.io did): those pay a full body per page every pass
- 2026-11-03: advisories stage is 17% of stage time with outliers (@types/react 299 s, @types/react-dom 119 s in run 41674492178); look at what it fetches for type-stub packages
- 2026-10-27: per-path breakdown of gateway subrequests (diagnostics.ts groups only by hour and status); lower priority now: exceededResources 357 -> 56 a week after PR #174
- 2026-10-27: ingest cycles: per-cycle times are in the run log (`[hh:mm:ss] cycle N` lines): ~20 min drain + 66-140 s publish per cycle, 7 cycles a run

## Entries

### 2026-11-03 · HTTP client closed the connection on every 304 and redirect
- Tried: summed `coverage_stages` over ingest run 41674492178 (293 events): docs 5,984 s of 9,242 s (65%), advisories 1,591 s, extraction 488 s; docs skewed to page-by-page crawls (expo 1,032 s, builder.io 941, oxlint-plugins 617, pinecone 592, django 555, posthog 468). Counted connections with a local server: 200 sequential 304s opened 200 connections, 200s opened 1, 100 redirects opened 101. A/B against real hosts on this runner, conditional re-checks: docs.pinecone.io 142/141 -> 86/91 ms per request, posthog.com 131 -> 70 ms; django, expo, builder.io answer 200 (no gain).
- Found: `#once` called `res.destroy()` on every 3xx before reading it, which on Node destroys the socket, so each 304 (a re-check's normal answer) and each redirect hop cost a new TCP+TLS handshake. Gateway is no longer a lead (exceededResources 357 -> 56, subrequests 774k -> 363k a week).
- Chosen: read 3xx bodies to the end (64 KiB cap) and drop them; 2 tests; 535 central tests pass; $0 model spend. PR #207
- Outcome: 304s and redirects reuse connections (~40% less time per 304 on Mintlify/posthog-style hosts); fleet share of 304s still unmeasured

### 2026-10-27 · Gateway packed-asset reads: one bucket read per hit, shared probes
- Tried: read the observations (ingest steps: Drain and publish always ~145 min, bounded by the window; gateway: 98,580 requests, 774,534 subrequests, 357 exceededResources errors at 18-20 subrequests and ~13 ms CPU each). Benchmarked cold batches of 16 status reads on a packed 20,000-technology tree with the asset-layer stand-in: 48 fetches for hits (header, the same bucket again, 16 concurrent probes) and 48 for misses (two buckets, then the static 404).
- Found: a hit fetched its bucket twice; the probe cache missed concurrent reads; the directory-redirect check read a second bucket because `x/index.html` was grouped as `x/`, not `x`.
- Chosen: read the file along with a cold header, keep probes as in-flight promises, group index files under the directory's path; 48 -> 17 (hits) and 48 -> 32 (misses) fetches per cold batch, 3.40 -> 2.10 ms and 2.31 -> 1.29 ms in the stand-in; PR #174
- Outcome: packed status reads cost one bucket fetch per hit plus one probe per isolate; the remaining miss cost is the static 404 (rejected: skipping it moves pack policy into the Worker and breaks unpacked previews)
