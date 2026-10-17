# Slice 3b results: the extraction model on both held-out sets

16 October 2026. Pre-registration: `PREREG.md`, section "Slice 3b". It was written before any model output on held-out set 2
(H2) existed and was not changed afterwards.

## Decision

**Switch steps A+B to `openai/gpt-6-luna` at reasoning effort `low`, with two calls.** It is the only arm that is clearly
adequate on both sets.

- **H1 (short notes):** it ties Luna 5.6.
- **H2 (guides and major notes):** it beats Luna 5.6 by a wide margin: required recall 88.7 against 63.8 (r1) and 69.7
  (r2). A replicate run gives 85.1.
- **Cost:** about 2.5× less than Luna 5.6 per technology-year ($0.019 against $0.048).

**By the letter of the rule, the cost criterion does not separate the two passers.** gpt-6-luna and `alibaba/qwen3.8-flash`
both pass both sets against the pre-registered baseline (Luna r1).

| | Qwen3.8 | gpt-6-luna |
|---|---|---|
| Worst-case cost, mean technology | **$0.0186** (3% cheaper) | $0.0192 |
| Worst-case cost, largest technology | $0.302 | **$0.265** (12% cheaper) |

Both gaps are smaller than the cost noise between gpt-6-luna's own two H2 runs (8%). Rule 5 (trade-off) then decides.
On H2, gpt-6-luna is significantly better than Qwen3.8:

| Metric | gpt-6-luna − Qwen3.8 | 95% CI |
|---|---|---|
| Required recall | **+26.7** | +11.4…+44.8 |
| Breaking recall | +24.6 | +9.6…+42.1 |
| Precision | +8.3 | +2.3…+17.9 |

That gain costs at most $0.0006 per technology-year: $6 per 10k technologies. **Qwen3.8's H2 pass is also fragile.**
Against Luna's other fresh run (r2), Qwen3.8 is −7.7 on required recall and −8.2 on breaking recall (CI −18.4…−0.2), which
fails the margin.

- **Every other arm fails.** gpt-5-nano, nemotron-3.5-lightning, qwen3.7-flash and glm-4.7-flash fail the H1 floor (pooled
  recall 14–24 points below Luna). On H2, nano and GLM collapse (20–29% required recall), Nemotron is at −16, and Qwen3.7 fails
  the nits gate (precision −14.1).
- **The incumbent is the weak arm on long documents.** Luna 5.6 through `codex exec` writes fewer records on 30k-character
  chunks. gpt-6-luna is +24.9 on required recall against r1 (CI +13.7…+38.1) and +19.0 against r2 (+5.6…+36.1).
- **Gate** (dev technologies, label fields end to end): required coverage on DEV is 49 of 72, against Luna's 51–52 and
  Qwen3.8's 46. First 16 is 35, against Luna's 26–30. The extraction set's required fetched is 59 of 61, as Luna T-fresh.
- **Medium effort is not needed.** Required recall is +0.9 (n.s.), breaking +3.6 (CI +0.5…+7.3) and major-notes group recall
  +8.2, for 30% more cost on H2 ($0.0210 against $0.0161 for the mean technology). Keep `low`. Medium is the option if
  breaking recall on major notes becomes the binding constraint.
- **One call is not adopted.** With gpt-6-luna it loses 19.5 points of required recall against its own two calls (CI −35.6…−6.8).

## H1: short release notes (40 notes, 258 sure groups, 35 breaking)

Baseline and Qwen3.8 are slice 3's runs, reused. Differences are candidate − Luna fresh, with the note bootstrap 95% CI
(`stats.py`). Comparisons are in `out/slice3b/cmp-h1-*.json`.

| Arm | Pooled excl. unsure | Macro excl. unsure | Breaking | Precision | Records/note | Failed chunks | Calls | Input / output / reasoning tokens | $ run | Floor |
|---|---|---|---|---|---|---|---|---|---|---|
| Luna 5.6 fresh | 66.3 | 90.0 | 80.0 | 80.6 | 5.55 | 0 | 83 | 2.07M (harness) / 60k / 28k | plan ($0.10 list, prompt only) | — |
| qwen3.8-flash (slice 3) | 67.1 (+0.8, −7.1…+4.9) | 92.4 (+2.3) | 80.0 (0) | 81.6 | 5.42 | 0 | 85 | 190k / 43k / 0 | $0.049 | pass |
| **gpt-6-luna (low)** | **66.3 (0.0, −6.6…+3.2)** | **91.9 (+1.9, −3.3…+8.8)** | **82.9 (+2.9, −5.6…+16.0)** | 82.0 (+1.4) | 5.55 | 0 | 84 | 172k / 54k / 20k | $0.048 | **pass** |
| gpt-5-nano (minimal) | 42.6 (**−23.6**, −32.0…−8.3) | 84.6 (−5.4) | 60.0 (−20.0) | 76.0 | 3.65 | 0 (1 label) | 90 | 176k / 31k / 0 | $0.021 | fail |
| nemotron-3.5-lightning | 52.3 (**−14.0**, −20.4…−2.4) | 85.4 (−4.6) | 68.6 (−11.4) | 76.0 | 4.47 | 2 unparseable | 90 | 204k / 37k / 0 | $0.017 | fail |
| qwen3.7-flash | 47.3 (−19.0, −27.9…0.0) | 83.2 (−6.8) | 51.4 (**−28.6**, −50.0…−6.2) | 83.4 | 3.77 | 1 unparseable | 83 | 190k / 37k / 0 | $0.010 | fail |
| glm-4.7-flash | 51.6 (**−14.7**, −24.6…−4.7) | 81.8 (−8.3) | 60.0 (−20.0) | 75.8 | 4.45 | 0 (9 retries) | 91 | 185k / 33k / 0 | $0.026 | fail |

The weak arms lose mostly on zod 4.5.0, the one long note: zod recall is 26–40% against Luna's 58%. They tie on the short
PyPI notes.

## H2: upgrade guides and major notes (7 documents, 221 required excl. unsure, 280 breaking)

The baseline is Luna r1 (pre-registered); the CI is the section bootstrap from `score.py compare`, with r2 in brackets.
Results are in `out/slice3b/cmp-h2-*.json` and `h2-table.json`.

| Arm | Required excl. unsure | Breaking | Group recall | Precision | Records/doc | Guide / notes required | Failed chunks | Input / output / reasoning | $ run | Floor | Nits |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Luna 5.6 r1 (baseline) | 63.8 | 64.6 | 56.7 | 80.2 | 52.0 | 61.5 / 65.8 | 0 (1 retry) | 298k harness / 63k / 8k | plan ($0.11 list) | — | — |
| Luna 5.6 r2 | 69.7 | 70.0 | 61.6 | 82.9 | 55.3 | 75.0 / 65.0 | 0 | 273k / 62k / 7k | plan ($0.10) | — | — |
| **gpt-6-luna (low)** | **88.7** (+24.9, +13.7…+38.1) [+19.0] | **86.4** (+21.8, +11.8…+34.2) [+16.4] | 71.6 | 84.8 (+4.6) | 63.0 | 91.3 / 86.3 | 0 | 114k / 69k / 3k | $0.048 | **pass** | **pass** |
| gpt-6-luna (low), replicate* | 85.1 (+21.3, +11.9…+34.0) | 83.9 | 69.2 | 83.7 | 61.4 | 81.7 / 88.0 | 0 (1 retry) | 125k / 69k / 3k | $0.045 | | |
| gpt-6-luna (medium) | 89.6 (+0.9 vs low, −3.1…+4.7) | 90.0 (+3.6 vs low) | 76.5 | 86.5 | 66.9 | 87.5 / 91.5 | 0 | 117k / 99k / 24k | $0.064 | | |
| qwen3.8-flash | 62.0 (−1.8, −14.1…+6.5) [**−7.7**, −18.3…+0.6] | 61.8 (−2.9, −13.9…+6.2) [**−8.2**, −18.4…−0.2] | 52.4 | 76.5 (−3.7) [−6.5] | 51.0 | 63.5 / 60.7 | 0 | 117k / 69k / 0 | $0.050 | pass (r1) / fail (r2) | pass |
| qwen3.7-flash | 62.4 (−1.4, −18.1…+14.1) | 60.7 (−3.9) | 50.0 | 66.2 (**−14.1**) | 57.0 | 48.1 / 75.2 | 0 (3 retries) | 142k / 103k / 0 | $0.017 | pass | **fail** |
| nemotron-3.5-lightning | 47.5 (**−16.3**, −30.3…+0.5) | 45.4 (−19.3) | 36.3 | 69.5 (−10.7) | 38.9 | 52.9 / 42.7 | 0 (2 retries) | 120k / 56k / 0 | $0.017 | fail | |
| glm-4.7-flash | 29.0 (**−34.8**) | 27.5 (−37.1) | 21.8 | 82.8 | 19.1 | 30.8 / 27.4 | 0 | 92k / 31k / 0 | $0.019 | fail | |
| gpt-5-nano (minimal) | 19.9 (**−43.9**) | 19.3 (−45.4) | 13.9 | 75.5 | 13.4 | 16.3 / 23.1 | 0 (3 retries) | 107k / 18k / 0 | $0.012 | fail | |

\* Not pre-registered. It was run to measure gpt-6-luna's own spread: −3.6 on required recall (CI −9.9…+1.5) against its
first run.

**Per technology** (required recall excluding unsure: kit / msw / mypy / transformers):

| Arm | kit | msw | mypy | transformers |
|---|---|---|---|---|
| Luna r1 | 65.2 | 100 | 50 | 53.1 |
| Luna r2 | 83.9 | 95.5 | 50 | 44.4 |
| gpt-6-luna | **92.9** | 90.9 | 50 | **85.2** |
| qwen3.8 | 73.2 | 90.9 | 50 | 39.5 |
| qwen3.7 | 66.1 | 72.7 | 66.7 | 54.3 |
| nemotron | 39.3 | 77.3 | 66.7 | 49.4 |
| glm | 25.0 | 77.3 | 50 | 19.8 |
| nano | 19.6 | 77.3 | 33.3 | 3.7 |

mypy has only a few required groups, so its 50% is noise. gpt-6-luna's gain is on the two 30k-character chunks: the kit
guide (92.6 against 52.9 and 73.5) and the transformers notes (81.5 against 44.4 and 29.6). Its quotes are no longer than
Luna's (median 81 against 78 characters, maximum 219). 96.6% of its quotes are grounded, against 88.5–90.4% for Luna.

### Noise floor: Luna r2 − r1 on H2

| Metric | Difference | 95% CI (section bootstrap) | McNemar p |
|---|---|---|---|
| Required excl. unsure | +5.9 | −3.6…+13.9 | 0.053 |
| Breaking | +5.4 | −3.3…+14.0 | 0.044 |
| Group recall excl. unsure | +7.2 | **+1.1…+14.4** | 0.0005 |
| Guides | +12.4 | +3.9…+22.1 | 0.0002 |
| Precision | +2.7 | −2.1…+8.5 | |

**Luna's run-to-run spread on H2 is as large as the 5-point margin,** and on guides and pooled recall it is "significant" by
the same bootstrap. Both effects come from single 30k chunks answered differently. Against this, gpt-6-luna's own spread is
smaller (−3.6 on required recall). gpt-6-luna's lead over Luna (+19 to +25) is beyond both runs. Qwen3.8's −1.8 / −7.7 lies
inside the spread.

## Worst-case cost per technology-year (`cost3.py`, list price, input uncached, the larger of the H1- and H2-based figures)

| Arm | Mean technology | Largest technology | 10k / 50k / 200k | Output tokens/record incl. reasoning (H1 / H2) | Attempt factor (H1 / H2) | Records vs Luna (H1 / H2) |
|---|---|---|---|---|---|---|
| Luna 5.6 (prompt only) | $0.0481 | $0.62 | $481 / $2,405 / $9,620 | 272 / 174 | 1.00 / 1.07 | 1 / 1 |
| **gpt-6-luna (low)** | **$0.0192** | **$0.265** | **$192 / $960 / $3,840** | 242 / 155 | 1.00 / 1.00 | 1.00 / 1.21 |
| gpt-6-luna (medium, H2 only) | $0.0210 | $0.282 | $210 / $1,049 / $4,198 | — / 213 | — / 1.00 | — / 1.29 |
| qwen3.8-flash | $0.0186 | $0.302 | $186 / $932 / $3,727 | 198 / 193 | 1.01 / 1.00 | 0.98 / 0.98 |
| glm-4.7-flash (fails) | $0.0117 | $0.175 | $117 / $585 / $2,338 | 185 / 230 | 1.11 / 1.07 | 0.80 / 0.37 |
| gpt-5-nano (fails) | $0.0095 | $0.134 | $95 / $475 / $1,900 | 213 / 196 | 1.05 / 1.21 | 0.66 / 0.26 |
| nemotron-3.5-lightning (fails) | $0.0074 | $0.117 | $74 / $370 / $1,480 | 209 / 206 | 1.13 / 1.14 | 0.81 / 0.75 |
| qwen3.7-flash (fails) | $0.0071 | $0.097 | $71 / $353 / $1,412 | 244 / 258 | 1.05 / 1.21 | 0.68 / 1.10 |

On the H2 replicate, gpt-6-luna costs $0.0174 against $0.0161 for the first run. That 8% spread is larger than the gap to
Qwen3.8 at the mean technology. Because gpt-6-luna writes more records (R × 1.21 on H2), its cost bound rises with its
recall. One call would cost $0.0113 (gpt-6-luna) and $0.0137 (Qwen3.8), but it fails on recall.

## One call on H2 (passers only; report only)

| Arm | Required excl. unsure | Breaking | Precision | Records/doc | Failures | $ |
|---|---|---|---|---|---|---|
| gpt-6-luna, one call | 69.2 (−19.5 vs its two calls, CI −35.6…−6.8; +5.4 vs Luna r1) | 68.9 (−17.5) | 89.0 | 46.9 | 0 | $0.031 |
| qwen3.8, one call | 63.3 (−0.5 vs Luna r1) | 62.5 | 79.7 | 48.6 | 0 | $0.035 |

Folding the label fields into the extraction call costs gpt-6-luna a quarter of its records on long documents. This
agrees with slice 3's Qwen3.8 one-call loss on H1. Keep two calls.

## Gate (gpt-6-luna, two calls; not technology-disjoint)

Rebuilt from scratch into `.store/slice3b-gpt-6-luna` (+ `-catalog`) with slice 2/3's seeding and command
(`npm run pipeline -- --tech <t> --offline --no-docs --no-sample`, central/src unchanged). `codex-shim.mjs` routed only
the extraction and label prompts to `openai/gpt-6-luna` (`low`). The rebuild made 295 calls for $0.21, with no truncated
answer and no failed chunk. Scored with `GATE_K=0 run_gate.sh`.

| Required key changes | Luna T-cached | Luna T-fresh | Luna one call | Qwen3.8 (slice 3) | **gpt-6-luna** |
|---|---|---|---|---|---|
| Extraction set: all fetched (of 96) / required fetched (of 61) | 90 / 57 | 89 / 59 | — / 60 | 77 / 50 | **87 / 59** |
| Gate DEV: covered / in queue / first 16 (of 72) | 52 / 44 / 26 | 51 / 43 / 30 | 52 / 47 / 28 | 46 / 44 / 36 | **49 / 45 / 35** |
| Gate HELD-OUT: covered / in queue / first 16 (of 22) | 11 / 11 / 6 | 11 / 10 / 6 | 12 / 12 / 8 | 11 / 10 / 7 | **11 / 11 / 7** |
| Records | 1,349 | 1,356 | 1,214 | 914 | **1,205** |
| Grounded / terms per record | 96.4% / 4.4 | 95.1% / 4.6 | 93.1% / 2.9 | 89.7% / 3.8 | **97.8% / 4.1** |
| Replaces / requires / conditions | 15.0 / 15.9 / 10.9% | 14.6 / 12.5 / 12.3% | 13.1 / 15.0 / 11.0% | 18.1 / 10.1 / 3.4% | **15.7 / 14.2 / 5.9%** |

- **Coverage is at Luna's level, minus about 2.** Of the required changes both Luna rebuilds cover, gpt-6-luna misses one:
  invoicerr-prisma7 K4, "Prisma ORM now ships as an ES module", which Qwen3.8 misses too. The other gaps against T-cached
  are also misses for T-fresh, so they are Luna's own run-to-run spread. Qwen3.8 is 5–6 below Luna.
- **First 16 is higher than Luna's (35 against 26–30)** and close to Qwen3.8's 36, from about 11% fewer records competing
  in the queue. In queue (45) is at least Luna's.
- **Label fields:**
  - `requires` (14.2%) is in Luna's range (12.5–15.9%).
  - `conditions` (5.9%) is half of Luna's 11–12% (Qwen3.8: 3.4%).
  - Grounding is the best of any arm.
  - No set scores label correctness. `conditions` qualifies an obligation ("only if you use X"); having fewer of them is
    not shown to be worse.
- Jev for the rebuild: 2,264 uncached calls, 5.79M input tokens, about $0.24.

## Spend

| Provider | Calls | Tokens (input / output / reasoning) | $ |
|---|---|---|---|
| **Gateway, this slice** | 908 | | **$0.682 of the $2.50 cap** |
| ↳ gpt-6-luna, evals (H1, H2 ×2, medium, one call, smoke) | 141 | 579k / 348k / 53k | $0.240 |
| ↳ gpt-6-luna, gate rebuild | 295 | 673k / 265k / 78k | $0.212 |
| ↳ qwen3.8-flash (H2, one call) | 21 | 161k / 129k / 0 | $0.085 |
| ↳ glm-4.7-flash | 115 | | $0.050 |
| ↳ nemotron-3.5-lightning | 114 | | $0.035 |
| ↳ gpt-5-nano | 115 | | $0.034 |
| ↳ qwen3.7-flash | 107 | | $0.028 |
| ↳ (the 20 effort-probe calls, < $0.001, are included above) | | | |
| Codex (Luna 5.6, plan) | 29 extraction and label calls (H2 ×2); 30 gate match calls | H2: 571k input with the harness / 126k output / 15k reasoning; gate: 711k input | plan; H2 $0.21 at list (prompt only) |
| Jev (gate rebuild classifier) | 2,264 uncached | 5.79M input | about $0.24 (cap $0.30) |

The live gateway balance was $7.59 at the start of the slice. Other slices were running at the same time.

## Evalism concerns

1. **The baseline is noisy.** Luna's two H2 runs differ by about 6 points on the floor metrics. The pre-registered baseline
   (r1) is the lower run, so it favours candidates: Qwen3.8 passes against r1 and fails against r2. gpt-6-luna clears both
   by more than 15 points, so its verdict does not depend on the choice.
2. **H2 is small.** It has 7 documents, 4 technologies and 68 sections. The section bootstrap treats sections as independent,
   and CIs run ±10–17 points. Two documents (the kit guide and the transformers notes, each one 30k chunk) carry most of the
   differences.
3. **Luna 5.6 and gpt-6-luna ran on different paths.** Luna ran through `codex exec`: harness system prompt, default effort,
   no max_tokens. gpt-6-luna ran through chat completions with `low` effort and max_tokens 16k. Part of Luna 5.6's
   long-document deficit may come from the harness rather than the model. Luna 5.6 through the API was not run (list price
   2× gpt-6-luna). The decision does not need it, since gpt-6-luna is cheaper either way.
4. **Label fields are unscored on both held-out sets.** They are measured only at the gate, which is the dev technologies.
5. **Not pre-registered:** the gpt-6-luna replicate (descriptive only) and the H2 comparisons against r2 (sensitivity). The
   H2 per-technology tables are descriptive; n per cell is small.
6. **Effort settings were found by probe.**
   - gpt-5-nano ignores `none` and reasons anyway, so it ran at `minimal`.
   - gpt-6-luna at `low` reasons on most prompts: 20k reasoning tokens on H1, 78k in the rebuild. That is counted in the cost.
   - A cheap arm's failure at its lowest effort does not show what it would do with more effort.
7. **GLM's label answers use `prerequisites: {}`,** which the pipeline's `Labels` schema rejects, so those records get no
   label fields. That is a format failure, counted as in production.
8. **The precision credit counts only adjudicated anchors.** gpt-6-luna's extra records on H2 still earn higher precision
   (84.8 against 80.2), so they are mostly labelled changes, not nits.

## Files

- `PREREG.md` § "Slice 3b": the pre-registration.
- `run3.mts`: now takes `--out slice3b --cap 2.5`, `--split heldout2|smoke3b` and `--effort`. Without them it behaves as in
  slice 3.
- `stats3b.py`: the H2 table and `compare`, wrapping score.py.
- `cost3.py`: adds the new prices and `--out`.
- `codex-shim.mjs`: takes `SHIM_OUT` and `SHIM_CAP` and the new models' effort settings.
- Runs: `eval/select/out/slice3b/runs/*`, `usage.jsonl`, `cmp-h1-*.json`, `cmp-h2-*.json`, `h1-table.json`,
  `h2-table.json`, `h2-followups-table.json`, `cost-h1.json`, `cost-h2.json`, `cost-h2-followups.json`.
- Gate: `.store/slice3b-gpt-6-luna` (+ `-catalog`) and `eval/gate/results/slice3b-gpt-6-luna.{md,json,summary.json}`.

## Grading check: strict quote matching against lenient matching (H2, added 16 October 2026)

`lenient_h2.py` reproduces the strict scores exactly. It then also credits a group when a record names every
backticked identifier of the anchor (or shares at least 60% of its content words). Required groups, unsure excluded
(n = 221):

| Model | Grounded quotes | Strict required recall | Lenient required recall |
|---|---|---|---|
| Luna 5.6 r1 / r2 | 88.5% / 90.4% | 63.8 / 69.7 | 74.7 / 77.4 |
| gpt-6-luna | 96.6% | 88.7 | 92.8 |
| qwen3.8-flash | 87.7% | 62.0 | 75.1 |
| qwen3.7-flash | 87.7% | 62.4 | 75.6 |
| nemotron-3.5-lightning | 68.0% | 47.5 | 62.0 |
| glm-4.7-flash | 73.1% | 29.0 | 37.6 |
| gpt-5-nano | 79.8% | 19.9 | 25.3 |

- **Quote matching costs Luna 5.6 and the Qwen models 8–13 points** of changes they did find. Leniently, Qwen equals
  Luna 5.6 on guides and major notes, as it already did on H1.
- **gpt-6-luna's lead holds:** it is +15 to +18 over both. It quotes verbatim most often and finds more.
- **Nemotron, GLM and nano still fail.** Nemotron's 68% grounding hides some finds, but too few.
- **The verdict stands:** gpt-6-luna is best, and with flex it is also the cheapest. Do not read the strict gap as
  open-weight models understanding less than Luna 5.6.
