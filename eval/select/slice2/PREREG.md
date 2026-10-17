# Slice 2 pre-registration: one call per chunk (A + B folded) on Luna

Written 16 October 2026, before any model run. Question: does folding the labelling call (`LABEL_PROMPT`: terms,
replaces, requires, prerequisites, conditions) into the extraction call (`EXTRACT_PROMPT`) hold quality? Model fixed:
Luna (`gpt-5.6-luna`) through Codex (`codex exec`, the user's plan).

## Arms

All three are built from scratch, each into its own side store (`UNSTALE_CENTRAL_DIR=.store/slice2-<arm>`,
`UNSTALE_CATALOG_DIR=.store/slice2-<arm>-catalog`), with the same working-tree code and the same command per technology:

```
npm run pipeline -- --tech <next|prisma|nestjs> --offline --no-docs --no-sample
```

Every side store is seeded identically: `releases/`, `guides/`, `advisories/` of the three technologies, the npm
registry cache and the live classifier cache (copied from `.store/central`); the catalog dir is a copy of
`.store/catalog` (so the gate's other technologies are unchanged), and the run republishes the three technologies.
`--no-docs` in every arm: the docs module's state is mutable, and the live store extracted no docs notes for these
technologies. Advisories stay on (offline OSV data) in every arm.

| Arm | Structure | Codex cache | What it measures |
|---|---|---|---|
| **T-cached** | two calls (default) | copied from the live store | the published labels, where requests are identical |
| **T-fresh** | two calls | empty | Luna's run-to-run noise against T-cached |
| **O** | one call (`UNSTALE_EXTRACT_STRUCTURE=one-call`) | empty | the candidate |

Classifier (Jev): the live classifier cache is copied into every arm, so an identical request reuses its answer; a new
request calls Jev, which is nondeterministic. Jev spend for the slice stays under $1 at $0.042/M input, read from each
side store's `usage.jsonl`; a run is stopped if the cumulative Jev input passes 21M tokens ($0.88).

Dry count (no calls): 146 documents (140 releases, 6 guides), 157 chunks. T-fresh at most 314 Codex calls, O at most
157: 471 ≤ 700, before retries. T-cached's 157 extraction prompts all hit the copied cache.

## Metrics

1. **Extraction recall:** `python3 eval/sets/score.py extraction <catalog>`: all, fetched, required, DEV, HELD-OUT.
2. **Gate, order only:** `GATE_K=0 eval/gate/run_gate.sh <catalog> slice2-<arm>`: required key changes in the CLI's
   first batch of 16, DEV and HELD-OUT; covered and in-queue as context. (The gate's match step makes 2 Codex calls
   per event whose window changed, about 30 per arm; that is also Luna noise, and is present in every arm.)
3. **Records per document and grounded-quote rate**, from the run report (`extracted`, `ungrounded`) and the
   extraction files.
4. **Tokens:** Codex usage including the harness (each side store's `usage.jsonl`), and a prompt-only estimate
   (characters / 4 of the rendered prompts plus the outputs) per arm and per chunk.
5. **Parse failures:** chunks with a call that failed after three attempts (`failedCalls`), per chunk; attempt-level
   retries from the run logs.

Secondary, reported, not in the rule: label fill rates (records with non-empty `terms`, `replaces`, `requires`,
`prerequisites`, `conditions`), key changes that flip item by item between arms.

## Decision rule (as given; fixed before running)

Let, per metric m in {extraction recall on required fetched items; gate first-batch required DEV; gate first-batch
required HELD-OUT}:

- floor(m) = |T-fresh(m) − T-cached(m)| (the noise floor),
- loss(m) = T-fresh(m) − O(m) (positive = O lost key changes),
- material(m) = the smallest loss that matters: extraction required 2 (of 61), gate DEV 3 (of about 28), gate
  HELD-OUT 1 (of about 5).

**ADOPT** one call if loss(m) ≤ floor(m) on all three metrics, and O's parse-failure rate (failed chunks / chunks) is
not above T-fresh's, and floor(m) ≤ material(m) on all three (the test could have seen a material loss).
**REJECT** if loss(m) > floor(m) on any metric, or parse failures rise.
**INCONCLUSIVE** if the losses are within the floor but floor(m) > material(m) on some metric (the noise is larger
than the difference that would matter).

One noise pair understates the noise; where a REJECT rests on a margin of one key change, the report says so, but the
verdict stands as registered.
