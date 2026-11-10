# performance agent log

## Revisit
- 2026-11-10: next ingest run after PR #219: compare per-cycle `cpu_s`/`wall_s` (was 85-98 % of a core in 5 of 7 cycles of run 42873865732) and summed `docs_ms` (7,288 s of ~10,090 s); if the drain is still CPU-bound, profile a cycle (`--cpu-prof`) for the next hotspot: candidates are pages.ts pack reads (each get/put reads and scans the whole 1-of-256 pack file) and HTML extraction of MB-scale pages
- 2026-11-10: shared docs page cache (docs/pages.ts) keeps only 200s: a 304 to technology A is not kept, so technology B on the same site (langchain-openai 1,045 s then langgraph 782 s docs_ms in the same run, likely both docs.langchain.com) fetches again; keeping the validated etag/last-modified would answer B's matching conditional request locally (unmeasured: needs the same-site share of 304s)
- 2026-11-03: docs pass outcome mix (not_modified / unchanged / changed per pass) is not logged; adding it to `coverage_stages` would size the PR #207 gain fleet-wide and show which hosts answer 200 to conditional requests (django, expo, builder.io did): those pay a full body per page every pass
- 2026-11-03: advisories stage is 17% of stage time with outliers (@types/react 299 s, @types/react-dom 119 s in run 41674492178); look at what it fetches for type-stub packages
- 2026-10-27: per-path breakdown of gateway subrequests (diagnostics.ts groups only by hour and status); lower priority now: exceededResources 357 -> 56 a week after PR #174
- 2026-10-27: ingest cycles: per-cycle times are in the run log (`[hh:mm:ss] cycle N` lines): ~20 min drain + 66-140 s publish per cycle, 7 cycles a run

## Entries

### 2026-11-10 · Docs page cache compressed every page at Brotli quality 11
- Tried: summed `coverage_stages` of ingest run 42873865732 (439 events): docs 7,288 s of ~10,090 s (anthropic-ai-sdk 1,207, langchain-openai 1,045, nx-jest 897); drain cycles' cpu_s/wall_s 541/1204, 1066/1206, 1186/1205, 1519/1642, 1031/1204, 733/1203, 276/483 (CPU-bound; 7-12 refresh slices started per cycle in the worst). Gateway quiet (74,639 requests, 156,652 subrequests a week, no errors beyond 14 client disconnects). Benchmarked brotliCompressSync on real pages: q11 184-1,086 ms per 0.3-2.1 MiB HTML page, q6 2.8-14.7 ms, +10-13 % bytes. A/B of `Collector.checkAll` through `SharedPages` (16/2 per host): 80 docs.langchain.com pages 36.4 s wall/36.6 s CPU -> 2.0/1.4 (control rerun 36.3); Expo 60 pages first 9.4 -> 2.1 s, re-check (answers 200) 7.3 -> 1.7 s.
- Found: pages.ts called `brotliCompressSync(body)` with the default quality 11 on the event loop for every 200 body; the snapshot store already uses q6. 304 re-checks are unaffected. `git stash` is denied here: A/B by editing the line back and forth.
- Chosen: q6 text mode for cached page bodies; 560 central tests pass, typecheck clean; $0 model spend. PR #219
- Outcome: a docs page's cache write costs ~10 ms, not ~0.5 s; fleet-wide gain to be read from the next ingest run's cpu_s and docs_ms

### 2026-11-03 · HTTP client closed the connection on every 304 and redirect
- Tried: summed `coverage_stages` over ingest run 41674492178 (293 events): docs 5,984 s of 9,242 s (65%), advisories 1,591 s, extraction 488 s; docs skewed to page-by-page crawls (expo 1,032 s, builder.io 941, oxlint-plugins 617, pinecone 592, django 555, posthog 468). Counted connections with a local server: 200 sequential 304s opened 200 connections, 200s opened 1, 100 redirects opened 101. A/B against real hosts on this runner, conditional re-checks: docs.pinecone.io 142/141 -> 86/91 ms per request, posthog.com 131 -> 70 ms; django, expo, builder.io answer 200 (no gain).
- Found: `#once` called `res.destroy()` on every 3xx before reading it, which on Node destroys the socket, so each 304 (a re-check's normal answer) and each redirect hop cost a new TCP+TLS handshake. Gateway is no longer a lead (exceededResources 357 -> 56, subrequests 774k -> 363k a week).
- Chosen: read 3xx bodies to the end (64 KiB cap; a declared Content-Length over the cap is destroyed unread, review round 1) and drop them; 3 tests; 535 central tests pass; $0 model spend. PR #207
- Outcome: 304s and redirects reuse connections (~40% less time per 304 on Mintlify/posthog-style hosts); fleet share of 304s still unmeasured

### 2026-10-27 · Gateway packed-asset reads: one bucket read per hit, shared probes
- Tried: read the observations (ingest steps: Drain and publish always ~145 min, bounded by the window; gateway: 98,580 requests, 774,534 subrequests, 357 exceededResources errors at 18-20 subrequests and ~13 ms CPU each). Benchmarked cold batches of 16 status reads on a packed 20,000-technology tree with the asset-layer stand-in: 48 fetches for hits (header, the same bucket again, 16 concurrent probes) and 48 for misses (two buckets, then the static 404).
- Found: a hit fetched its bucket twice; the probe cache missed concurrent reads; the directory-redirect check read a second bucket because `x/index.html` was grouped as `x/`, not `x`.
- Chosen: read the file along with a cold header, keep probes as in-flight promises, group index files under the directory's path; 48 -> 17 (hits) and 48 -> 32 (misses) fetches per cold batch, 3.40 -> 2.10 ms and 2.31 -> 1.29 ms in the stand-in; PR #174
- Outcome: packed status reads cost one bucket fetch per hit plus one probe per isolate; the remaining miss cost is the static 404 (rejected: skipping it moves pack policy into the Worker and breaks unpacked previews)
