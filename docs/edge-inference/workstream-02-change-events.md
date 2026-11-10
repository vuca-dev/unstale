# WS2: Change events in the catalog

## Scope
Central publishes, beside today's records, the deterministic inputs the client's model steps need: for each release
of each technology, the normalised source text split into chunks with stable ids and content hashes, plus source URL,
version, date and kind (release notes, guide, docs change). Advisories and registry deprecations are already
deterministic; keep them.

## Pre-conditions
None. **Investigation first:** confirm how central chunks notes today (`extract.ts`, `changelog.ts`, `items.ts`),
which parts of that are deterministic, and how the client syncs shards (`local/cli/src/sync.rs`, `cache.rs`).

## Acceptance criteria
- [ ] A schema for change events in `local/schema` (Rust is the source of truth), generated Zod, `check:schema` passes.
- [ ] Chunk ids are stable across runs on unchanged input (a test re-chunks the same note twice and across a no-op
      republish).
- [ ] Published as signed, content-addressed shards in the same layout as records; older clients ignore them.
- [ ] The client syncs and caches them (no consumer yet; WS4 reads them).
- [ ] Size measured on the live catalog: bytes per technology-year (expected about 32 KB) and total.
- [ ] The coverage service's onboarding path publishes events for a new package without any model call.

## Risks and rollback
Catalog size growth on the free hosting tier: measure before merging. Rollback: stop publishing the shards; nothing
reads them yet.
