# Slice 2 results: one call per chunk (A + B folded), Luna through Codex

16 October 2026. Pre-registration: `PREREG.md` (written before any run, not changed after).

## Decision

**INCONCLUSIVE under the pre-registered rule, with no measured loss.** One call lost nothing against T-fresh on any of
the three metrics, and it scored at or above both two-call arms on all of them. The rule still cannot return ADOPT:
the gate's DEV noise floor (4 required key changes between two two-call builds) is larger than the 3 that counts as
material, so this test could not have detected a material DEV loss. Parse failures did not rise.

What it costs to go further: one call reads the notes once and sends **40% fewer prompt input tokens per chunk** (53%
fewer counting the harness), with about half the calls. **The open risk is label richness, not recall.** O writes 10%
fewer records and 37% fewer `terms` per record (2.9 against 4.4–4.6), and 2 points fewer grounded quotes. The gate's
order did not get worse, but no set measures precision, and the gate's 15 repositories exercise terms only lightly.

Next step, if the user wants a decision rather than a bound: a second T-fresh and O pair (about 460 Codex calls,
about $0.5 of Jev) to estimate the DEV floor from more than one pair, and the `terms` question checked on the gate's
usage order.

## Metrics per arm

All arms: same working tree, `npm run pipeline -- --tech <t> --offline --no-docs --no-sample` for next, prisma and
nestjs, each arm in its own side store (`.store/slice2-<arm>`, `.store/slice2-<arm>-catalog`), 146 documents, 157 chunks.

| Metric | T-cached | T-fresh | O (one call) | Floor \|TF−TC\| | Loss TF−O | Material | Within the floor? |
|---|---|---|---|---|---|---|---|
| Extraction recall, required fetched (of 61) | 57 | 59 | **60** | 2 | −1 | 2 | yes; floor ≤ material |
| Gate, required in CLI first 16, DEV (of 72) | 26 | 30 | **28** | 4 | 2 | 3 | yes; **floor > material** |
| Gate, required in CLI first 16, HELD-OUT (of 22) | 6 | 6 | **8** | 0 | −2 | 1 | yes |
| Parse failures (failed chunks / chunks) | 0 / 157 | 0 / 157 | 0 / 157 | | | | not above T-fresh |

Context (not in the rule):

| | T-cached | T-fresh | O |
|---|---|---|---|
| Extraction recall, all / fetched (of 100 / 96) | 90 / 90 | 89 / 89 | 92 / 92 |
| Extraction: DEV / HELD-OUT fetched (of 74 / 22) | 70 / 20 | 71 / 18 | 71 / 21 |
| Gate covered, required DEV / HELD-OUT | 52 / 11 | 51 / 11 | 52 / 12 |
| Gate in CLI queue, required DEV / HELD-OUT | 44 / 11 | 43 / 10 | 47 / 12 |
| Records (incoming) | 1,349 | 1,356 | **1,214** |
| Records per document | 9.24 | 9.29 | **8.32** |
| Grounded quotes | 96.4% | 95.1% | **93.1%** |
| Terms per record | 4.44 | 4.61 | **2.88** |
| Records with replaces / requires / prerequisites / conditions | 15.0 / 15.9 / 1.7 / 10.9% | 14.6 / 12.5 / 1.8 / 12.3% | 13.1 / 15.0 / 1.7 / 11.0% |
| Codex attempts retried (unparseable answer) | 0 | 1 of 303 | 1 of 158 |

Key changes that flip between arms (extraction, fetched misses):
- T-cached and T-fresh share 3 misses. Each has 3 or 4 of its own: T-cached misses chmonitor K4 and payloadplugins K8 (the same
  `revalidateTag` line) and aksel K9; T-fresh misses aksel K4 and jsontypes K2, K3 and K5 (one `prisma-client-js` line).
- O misses chmonitor K6, aksel K4, aksel K9 and temporal K13, and none of the jsontypes items.

## Tokens and cost per chunk

| Per chunk (157 chunks) | Two calls (T-fresh) | One call (O) | Change |
|---|---|---|---|
| Prompt-only input, characters / 4 | 4,199 | 2,518 | −40% |
| Prompt-only output, characters / 4 | 1,208 | 1,094 | −9% |
| Codex calls | 1.93 | 1.01 | −48% |
| Harness-inclusive input (cached share) | 35.4k (73%) | 16.8k (71%) | −53% |
| Harness-inclusive output (includes reasoning) | 2,153 | 1,743 | −19% |
| $ at Luna list price, prompt-only ($0.20 / $1.20 per M) | $0.00229 | $0.00182 | −21% |
| $ at list price, harness-inclusive ($0.02 per M cached) | $0.0050 | $0.0033 | −34% |

- The label call's prompt was 60% of two-call input: 1.59M of 2.64M characters. It repeats the notes and adds the
  record briefs.
- **Output dominates the dollars** (about 60% prompt-only), so halving input saves about a fifth at list price.
- **Worst case per technology-year:** two calls are O(2N + R·o_A + c·(P_A + P_B)), with P_A 0.6k and P_B 0.9k tokens.
  One call is O(N + c·P_1), with P_1 1.45k. A full 30k-character chunk (7.5k tokens) bounds input per chunk at
  about 16.5k + R·o_A for two calls, against about 9.0k for one. The largest chunk measured was 109k characters with
  two calls against 60k with one, input and output together.
- Output is R·(o_A + o_B) in both structures. O's output is smaller only because it writes fewer records and fewer
  terms; that is a quality question, not a saving.

## Spend

- **Jev:** $0.657 in total, under the $1 cap. 15.7M input tokens and 5,931 calls: T-cached $0.156 (1,293 calls),
  T-fresh $0.260, O $0.240, smoke $0.001.
- **T-cached also called Jev,** because a build from scratch asks judge requests the live store never asked (a
  different ingest order, current guide snapshots only). Jev is nondeterministic, so even T-cached is not the published
  catalog.
- **Codex:** 554 calls. Extraction: T-fresh 303, O 158, smoke 3. The gate's match step: 30 per arm, 90 in total,
  none failed. The dry count was 471 extraction calls at most, against the 700 limit.

## Evalism and caveats

- **The published 61/61 does not reproduce from scratch.**
  - T-cached gets 57/61 with identical extraction answers.
  - Two of the misses (temporal K13, aksel K9) were extracted only from older guide snapshots (`b0c7d729`,
    `604704de`). The live store keeps those snapshots' records, but an offline fetch returns only the current snapshot.
  - Two more (workout K2 and chmonitor K1, the same `default.js` line) are extracted in T-cached but lost when the
    record merges and keeps the other source's quote.
  - So the extraction set scores extraction **plus matching**. Its noise includes Jev's same-or-new judge, not only
    Luna.
- **The gate's own match step is Luna** (2 runs per event, new for every catalog). Part of the noise floor is the
  measuring instrument; for example, T-fresh's satisfactory match runs gave [4, 2].
- **One noise pair.** The floors (2, 4, 0) are single draws. A HELD-OUT floor of 0 is luck, not evidence of stability.
- **Recall-only sets reward over-extraction,** and O extracts less. O's recall held, but the 10% fewer records and 37%
  fewer terms are unscored: there is no precision set and no `terms` or `requires` set.
- **Docs off in every arm** (`--no-docs`), so the docs-section notes, a growing input kind, are untested.
- **The extraction set's items cite 9 documents of the 146.** The gate covers 15 events in 3 technologies, with no
  PyPI technology.

## Reproduce

- **The arms:** `.store/slice2-{tcached,tfresh,one}` and their `-catalog` directories are kept. Each was seeded with
  `releases/`, `guides/` and `advisories/` for the three technologies, the npm registry cache and the live classifier
  cache. T-cached also got the live Codex cache. Each catalog dir started as a copy of `.store/catalog`.
- **Scores:**
  - `python3 eval/sets/score.py extraction .store/slice2-<arm>-catalog`.
  - `GATE_K=0 eval/gate/run_gate.sh .store/slice2-<arm>-catalog slice2-<arm>`, which writes
    `eval/gate/results/slice2-*`.
- **Stats and tokens:**
  - `python3 eval/select/slice2/stats.py .store/slice2-<arm>`.
  - `UNSTALE_CENTRAL_DIR=.store/slice2-<arm> npx tsx ../eval/select/slice2/tokens.mts two-call|one-call` (from
    `central/`).
- **Dry count:** `eval/select/slice2/count.mts`.
- **Code:**
  - `UNSTALE_EXTRACT_STRUCTURE=one-call` in `central/src/pipeline/extract.ts`, with `ONE_CALL_PROMPT`,
    `parseOneCall` and `extractStructure` exported. The default is unchanged.
  - `eval/select/prompts.ts` re-exports the prompt from there.
  - Test: `central/test/extract-one-call.test.ts`.
