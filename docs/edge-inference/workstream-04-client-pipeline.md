# WS4: Client pipeline steps and port parity

## Scope
Port steps A+B, D and E to the client on top of WS3, reading WS1's prompts and WS2's change events, producing the
same records the client reads from the catalog today.

## Pre-conditions
WS1, WS2 and WS3 merged.

## Acceptance criteria
- [ ] **Steps:**
  - A+B: extraction on chunks, two calls, answering by chunk id.
  - D: labels on Jev when a Jev key is configured, otherwise `gpt-6-luna` read on its choices.
  - E: matching on Jev, otherwise `gpt-6-luna` at its fitted constants.
  - Anthropic key only: A+B and D on Haiku 5.5; E off (every record is new, so more duplicates).
  - Only for releases with change events and no catalog records (the README's "One switch").
  - Thresholds from `central/src/pipeline/thresholds.ts` and the eval results, as data.
- [ ] **Local store:** records written where the client reads catalog records today; each carries provenance
      (provider, model, model version, prompt version).
- [ ] **User-level cache:** results keyed by chunk hash, step, model and prompt version, shared by every repo on the
      machine. A second repo with the same technologies makes about zero new calls (test).
- [ ] **Bounded disk use: delete what is free to re-fetch, keep what cost tokens.**
  - The client cache is never pruned today (152 MB on a heavy development machine, mostly registry metadata and
    superseded catalog shards).
  - A shard is superseded when the technology's current index no longer names it. Each shard holds every record of
    one release line, so a superseded shard is an older copy of what its replacement holds: delete it when the new
    index is synced (no grace period on the client; central's 7 days only protect clients mid-sync).
  - Registry metadata and change events for technologies no longer in any synced repo: evict after 30 days unused,
    or first when over the size cap.
  - Model results (records, labels, matches) are what the user paid for and are a few KB per technology-year: never
    evicted by the cap; only after a year unused, or by an explicit `unstale cache clean`.
  - **Triggers.** Every sync records, per technology, when a repo on this machine last needed it. Deletion runs at
    the end of a sync. Re-download needs no trigger of its own: a sync reads each needed technology's index and
    fetches any named shard (by content hash) or event missing from the cache, so an evicted file costs one download
    the next time a repo needs it. An evicted model result would cost tokens, which is why the cap never takes them.
  - `unstale status` shows the cache size. Test: a cache past the cap shrinks below it, keeps everything the current
    indexes name, and keeps every model result.
- [ ] **Order:** technologies processed in demand order under the WS3 budget; backfill window bounded.
- [ ] **JSON subcommand** for evals (for example `unstale internal run-step --step d --in states.jsonl`) so
      `eval/select` harnesses can call the Rust implementation.
- [ ] **Port parity (hold-the-line):** on slice 4's H1 and H2 and slice 5's held-out set, the client's numbers for
      `gpt-6-luna` and for Jev match central's published numbers within the run-to-run noise recorded in those
      RESULTS files. Results in `eval/edge-port/RESULTS.md`.

- [ ] **Measured cost:** tokens and dollars per technology-year and for a first sync, per provider option, from the
      parity runs. WS5's quotes and WS8's docs use these numbers.

## Spend
The parity runs call paid APIs. Estimate first and follow the README's spend rule; reuse central's cached answers
wherever the request is byte-identical.

## Risks and rollback
The largest chunk: it splits into sub-PRs (extraction; labels and matching; cache and disk bounds; parity) behind
the one switch, each merged on its own.
