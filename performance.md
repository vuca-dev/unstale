# performance agent log

## Revisit
- 2026-10-27: per-path breakdown of gateway subrequests (diagnostics.ts groups only by hour and status) to confirm the batch endpoints dominate; exceededResources rows average 18-20 subrequests and ~13 ms CPU (would show what is left after PR #174)
- 2026-10-27: ingest "Drain and publish" is a fixed 140-minute window (RUN_MINUTES); throughput needs per-cycle step times, and the observations only had job-level minutes (no lead yet)

## Entries

### 2026-10-27 · Gateway packed-asset reads: one bucket read per hit, shared probes
- Tried: read the observations (ingest steps: Drain and publish always ~145 min, bounded by the window; gateway: 98,580 requests, 774,534 subrequests, 357 exceededResources errors at 18-20 subrequests and ~13 ms CPU each). Benchmarked cold batches of 16 status reads on a packed 20,000-technology tree with the asset-layer stand-in: 48 fetches for hits (header, the same bucket again, 16 concurrent probes) and 48 for misses (two buckets, then the static 404).
- Found: a hit fetched its bucket twice; the probe cache missed concurrent reads; the directory-redirect check read a second bucket because `x/index.html` was grouped as `x/`, not `x`.
- Chosen: read the file along with a cold header, keep probes as in-flight promises, group index files under the directory's path; 48 -> 17 (hits) and 48 -> 32 (misses) fetches per cold batch, 3.40 -> 2.10 ms and 2.31 -> 1.29 ms in the stand-in; PR #174
- Outcome: packed status reads cost one bucket fetch per hit plus one probe per isolate; the remaining miss cost is the static 404 (rejected: skipping it moves pack policy into the Worker and breaks unpacked previews)
