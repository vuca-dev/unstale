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
  - Thresholds from `central/src/pipeline/thresholds.ts` and the eval results, as data.
- [ ] **Local store:** records written where the client reads catalog records today; each carries provenance
      (provider, model, model version, prompt version).
- [ ] **User-level cache:** results keyed by chunk hash, step, model and prompt version, shared by every repo on the
      machine. A second repo with the same technologies makes about zero new calls (test).
- [ ] **Order:** technologies processed in demand order under the WS3 budget; backfill window bounded.
- [ ] **JSON subcommand** for evals (for example `unstale internal run-step --step d --in states.jsonl`) so
      `eval/select` harnesses can call the Rust implementation.
- [ ] **Port parity (hold-the-line):** on slice 4's H1 and H2 and slice 5's held-out set, the client's numbers for
      `gpt-6-luna` and for Jev match central's published numbers within the run-to-run noise recorded in those
      RESULTS files. Results in `eval/edge-port/RESULTS.md`.

## Risks and rollback
The largest chunk; it may split into A+B, D and E sub-PRs behind one flag. Default off until WS7.
