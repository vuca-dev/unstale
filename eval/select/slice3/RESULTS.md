# Slice 3 results: the generative model for steps A (+B)

16 October 2026. Pre-registration: `PREREG.md` (written before any held-out run; not changed after).

## Decision

**By the pre-registered rule: `alibaba/qwen3.8-flash`, two calls.** It is the only candidate that clears the held-out
floor and the nits gate, and it costs about 2.6× less than Luna per technology-year at list price ($0.019 against
$0.048 for the mean technology). Qwen's one call fails the floor (macro −9.2 points, CI below 0), so it stays on two
calls. gpt-oss-20b, gpt-oss-120b and DeepSeek V4 Flash fail the floor.

**Do not switch yet. Evidence outside the decision set contradicts the pass on long documents.** The held-out set
has no upgrade guides and no major-version notes. Where those dominate, Qwen loses key changes that matter:

- DEV, 9 documents, Luna fresh against Qwen: 61/61 against 53/61 required.
- Gate rebuild, next/prisma/nestjs from scratch: 50/61 required, against slice 2's Luna 59 (T-fresh) and 57
  (T-cached). Required key changes covered on the gate's DEV events fall from 51–52 to 46.

The misses are real: no record at all for "Prisma ORM now ships as an ES module", the `--webpack` / Turbopack
default, `prisma-client-js` → `prisma-client`, or the parallel-routes `default.js` requirement.

**Next step:** a held-out set that includes long upgrade guides and major-version notes from technology-disjoint
packages. Until then, the options are:

- keep Luna;
- or route by input kind: Qwen on short notes, where it ties Luna (short held-out notes 42/43 for both), and Luna on
  guides and major-version notes. The vault allows routing only "if one model cannot clear the floor on both kinds of
  input", and that is what the dev and gate evidence suggests. It is not proven on held-out data.

## Held-out (40 notes, 258 sure groups, 35 breaking groups), two calls

| Arm | Recall pooled | Recall macro | Breaking recall | Precision | Records/note | Failed chunks (parse / trunc.) | Calls (retries) | Input / output / reasoning tokens | $ this run | Floor | Nits |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Luna fresh** (baseline) | 66.3 | 90.0 | 80.0 | 80.6 | 5.55 | 0 / 0 | 83 (0) | 152k prompt-only (2.07M with harness) / 60k / 28k | $0.10 prompt-only, at list; plan | — | — |
| Luna cached (33 notes) | 68.2* | 91.2* | 79.4* | 81.9* | 6.36* | 7 chunks not cached | 0 | — | 0 | — | — |
| **qwen3.8-flash** | **67.1** (+0.8, CI −7.1…+4.9) | **92.4** (+2.3, −2.4…+9.1) | **80.0** (0, −5.9…+12.5) | 81.6 (+0.9) | 5.42 | 0 / 0 | 85 (1) | 190k / 43k / 0 | $0.049 | **pass** | **pass** |
| deepseek-v4-flash | 57.8 (−8.5, −25.6…+1.8) | 54.1 (**−35.9**, −51.9…−20.8) | 77.1 (−2.9) | 81.8 | 4.67 | 0 / 0 | 69 (0) | 157k / 32k / 0 | $0.029 | fail | — |
| gpt-oss-120b | 49.2 (**−17.1**, −23.9…−8.3) | 84.0 (−6.0) | 68.6 (−11.4) | 74.9 (−5.8) | 4.38 | 0 / 0 | 83 (0) | 173k / 41k / 13k | $0.039 | fail | — |
| gpt-oss-20b | 28.7 (**−37.6**) | 62.2 (**−27.8**) | 34.3 (**−45.7**) | 85.4 | 2.23 | 0 / 0 | 76 (1) | 149k / 25k / 10k | $0.008 | fail | — |

Recall is group recall excluding unsure. Differences are candidate − Luna fresh, with the note-level bootstrap 95% CI
(`stats.py`; McNemar p in `out/slice3/cmp-*.json`). \* = the 33 notes Luna's stored answers fully cover.

- **DeepSeek** returns `[]` for 17 short notes (at least 5 each of typer's and uvicorn's): PyPI recall excluding unsure falls to
  53–64%.
- **gpt-oss-20b** writes 40% of Luna's records. No chunk truncated at its 8,192-token ceiling.
- **Gemini 3.1 Flash-Lite was not run:** its list price of $0.25 / $1.50 is above Luna's.

**Noise floor (Luna fresh − cached, 33 notes):**

| Metric | Difference (points) | 95% CI |
|---|---|---|
| Pooled | −1.7 | −4.8…+6.1 |
| Macro | +0.8 | −8.6…+10.0 |
| Breaking | +2.9 | 0…+15.0 |
| Precision | +0.4 | |

28 of 242 groups are discordant (12%). Qwen's differences from Luna fresh lie inside this noise.

**Can the set separate candidates?** It separates large losses: gpt-oss-20b and 120b, and DeepSeek on macro recall.
It cannot certify the 5-point margin:

- Qwen's pooled CI spans 12 points and its breaking CI 18 (35 breaking groups).
- zod 4.5.0 holds about 38% of the groups, so pooled recall is mostly one note (Luna 58%, Qwen 59% on zod).

## One call (passers only): qwen3.8-flash

| | Pooled | Macro | Breaking | Precision | Records/note | Failures | Calls | $ |
|---|---|---|---|---|---|---|---|---|
| One call | 71.3 (+5.0, CI −16.1…+15.0) | 80.8 (**−9.2**, −18.8…−1.9) | 74.3 (−5.7) | 85.9 (+5.3) | 5.50 | 0 parse failures (1 retry), 0 truncations | 44 | $0.038 |

One call fails the floor on macro and breaking. Its losses are on PyPI and short notes:

- PyPI recall excluding unsure: 77.5% with one call, against 100% with two.
- Short notes: 72% against 98%.

Its label fields cannot be scored here.

## Worst-case cost per technology-year (`cost3.py`, list price, input uncached)

The formula is from the pre-registration: N, c and R come from `cost.mts`. Output is R × the measured completion
tokens per record, reasoning included. R is scaled by the arm's records relative to Luna, and the cost is multiplied
by the attempt factor.

| Arm | Mean technology | Largest technology (N 204k, c 531, R 1,092) | 10k / 50k / 200k technologies | Output tokens per record | Attempt factor |
|---|---|---|---|---|---|
| Luna, two calls (prompt-only, no harness) | $0.0481 | $0.62 | $481 / $2,405 / $9,620 | 272 | 1.00 |
| **qwen3.8-flash, two calls** | **$0.0186** | **$0.30** | **$186 / $932 / $3,727** | 198 | 1.01 |
| qwen3.8-flash, one call (fails the floor) | $0.0161 | $0.26 | $161 / $803 / $3,213 | 205 | 1.02 |
| deepseek-v4-flash (fails) | $0.0113 | $0.21 | $113 / $563 / $2,250 | 172 | 1.00 |
| gpt-oss-120b (fails) | $0.0159 | $0.23 | $159 / $796 / $3,186 | 235 | 1.00 |
| gpt-oss-20b (fails) | $0.0035 | $0.06 | $35 / $174 / $695 | 284 | 1.01 |

Output dominates the cost: Qwen's price per output token is 39% of Luna's.

## DEV (9 documents, `eval/sets/score.py extraction`, fetched / required)

| | Luna fresh | qwen two calls | qwen one call | DeepSeek | gpt-oss-120b | gpt-oss-20b |
|---|---|---|---|---|---|---|
| Fetched (of 96) | **94** | 79 | 71 | 79 | 70 | 71 |
| Required (of 61) | **61** | 53 | 48 | 52 | 49 | 45 |
| Records | 364 | 269 | 251 | 352 | 224 | 127 |
| Ungrounded quotes | 8% | 20% | 23% | 18% | 17% | 36% |

Dev was used for sanity only, as pre-registered, but its gap is the main finding against switching. The 9 documents
are long: 12 chunks averaging 14k characters, including 3 upgrade guides. Every candidate writes fewer records there
and quotes less faithfully.

## Gate, label fields end to end (qwen3.8-flash, two calls)

Rebuilt into `.store/slice3-qwen3.8-flash` (+ `-catalog`) with slice 2's seeding and command:

- `npm run pipeline -- --tech <t> --offline --no-docs --no-sample`, with central/src unchanged.
- `UNSTALE_CODEX_BIN=eval/select/slice3/codex-shim.mjs` routes only extraction and label prompts to the gateway.
- Scored with `GATE_K=0 run_gate.sh`.

Slice 2 had concluded INCONCLUSIVE, so the rebuild used two calls. The gate is **not technology-disjoint**:
next/prisma/nestjs are the dev technologies.

| Required key changes | Luna T-cached | Luna T-fresh | Luna one call | **Qwen** |
|---|---|---|---|---|
| Extraction set, required fetched (of 61) | 57 | 59 | 60 | **50** |
| Gate DEV: covered / in queue / first 16 (of 72) | 52 / 44 / 26 | 51 / 43 / 30 | 52 / 47 / 28 | **46 / 44 / 36** |
| Gate HELD-OUT: covered / in queue / first 16 (of 22) | 11 / 11 / 6 | 11 / 10 / 6 | 12 / 12 / 8 | **11 / 10 / 7** |
| Records | 1,349 | 1,356 | 1,214 | **914** |
| Grounded / terms per record | 96.4% / 4.4 | 95.1% / 4.6 | 93.1% / 2.9 | **89.7% / 3.8** |
| Replaces / requires / conditions | 15.0 / 15.9 / 10.9% | 14.6 / 12.5 / 12.3% | 13.1 / 15.0 / 11.0% | 18.1 / 10.1 / 3.4% |

- **First-16 is higher with Qwen, but coverage is lower.** Qwen's 33% fewer records leave less competition in the
  queue, so a required change that is extracted ranks higher. The 5–6 required changes that are no longer covered
  cannot be reviewed at all. Recall over precision makes coverage the deciding row.
- **Label fields:** Qwen writes `conditions` on 3.4% of records against 11–12% for Luna, and `requires` on 10%
  against 12–16%. No set scores their correctness.
- **The rebuild:** 272 Qwen calls, $0.19, 1 truncated answer (it parsed on the pipeline's retry), 0 failed chunks.

## Spend

| Provider | Calls | Tokens | $ |
|---|---|---|---|
| Gateway | 754 | | **$0.515 of the $4.00 cap** |
| ↳ qwen3.8-flash | 442 | | $0.357 (gate rebuild $0.194) |
| ↳ gpt-oss-120b | 112 | | $0.079 |
| ↳ deepseek-v4-flash | 97 | | $0.064 |
| ↳ gpt-oss-20b | 103 | | $0.015 |
| Codex (Luna, plan) | 108 extraction and label calls, plus the gate's match calls | 2.5M input with the harness, 137k output (50k reasoning) | billed to the plan; $0.28 at list |
| Jev (gate rebuild classifier) | | 4.70M input | about $0.20 |

The gateway's live balance fell from $9.73 to $7.69 over the session. The difference beyond this slice's $0.52 is the
slices running at the same time.

## Evalism concerns

1. **The held-out set does not represent the documents that matter most.** It has 23 short notes and 17 long ones,
   with no upgrade guides and no major-version release. Every candidate's dev and gate losses sit in that gap, and the
   rule's pass does not cover it.
2. **The dev reference was built from Luna's own evidence quotes.** Matching is by line similarity, so a different
   quoting style could cost a little. The misses checked above are absent records, not rewordings.
3. **One noise pair for Luna.** The 5-point margin is the brief's; the CIs are wider than it.
4. **Precision credits only adjudicated anchors.** No set scores the label fields (terms, replaces, requires).
5. **The paths differ.** Luna runs through `codex exec` (harness system prompt, the default reasoning) and the
   candidates through chat completions at the lowest reasoning effort. Higher reasoning effort for gpt-oss or Qwen
   was not tried.
6. **The shim.** The gate rebuild used a `codex` stand-in. Prompts, parsers, retries and caching are the pipeline's,
   but the per-call max_tokens is 16k with no harness.

## Files

- `PREREG.md`: the pre-registration.
- `run3.mts`: the runner (held-out, dev and smoke; Luna fresh or cached; gateway).
- `stats.py`: the floor metrics and paired bootstrap, using score.py's own `paired`.
- `cost3.py`: the cost table.
- `codex-shim.mjs`: the codex stand-in for the gate rebuild.
- Runs: `eval/select/out/slice3/runs/*` (incoming.json, raw.jsonl, meta.json), `out/slice3/usage.jsonl`,
  `cmp-*.json`, `cost.json`.
- Gate: `eval/gate/results/slice3-qwen3.8-flash.{md,json,summary.json}`.
