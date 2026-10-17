# Slice 3 pre-registration: the generative model for steps A (+B)

Written 16 October 2026, before any candidate (or a fresh Luna run) was scored on the held-out extraction set.
Question: which text-generation model should extract change records from release
notes (`EXTRACT_PROMPT`) and write their label fields (`LABEL_PROMPT`, or both in one call, `ONE_CALL_PROMPT`)?
Slice 2 decides one call against two on Luna and owns `UNSTALE_EXTRACT_STRUCTURE`; this slice does not edit
`central/src` and runs everything through `eval/select/slice3/run3.mts` (the pipeline's prompts, `chunk`, parsers and
`toIncoming`, call for call as `extract.ts extractRelease`).

## Sets

| Role | Set | Use |
|---|---|---|
| **HELD-OUT (decision)** | `eval/select/holdout/extraction/`: 40 notes (posthog-js, zod [npm]; uvicorn, typer [PyPI]), `labels/adjudicated.json` (270 groups; zod 4.5.0 ≈ 38% of groups) | Scored once per arm with `holdout/score.py extraction` on the run's `incoming.json` |
| DEV | `eval/sets/extraction-recall.json` over its 9 cited documents (Luna published 96/100) | Smoke (2 documents) and a full dev sanity run per candidate. Never used to tune prompts; no prompt is changed in this slice |

## Arms

| Id | Model | Path | Settings |
|---|---|---|---|
| L-fresh | Luna `gpt-5.6-luna` | `codex exec` (pipeline flags) on the user's plan, **own empty cache** (`out/slice3/cache/`), never the store's | Pipeline default reasoning (codex exec, `--ignore-user-config`) |
| L-cached | Luna | the stored Codex answers only (`.store/central/cache/codex`, `out/central/cache/codex` for PyPI); no calls | covers 32 of 40 notes |
| G20 | `openai/gpt-oss-20b` | AI Gateway chat completions | `reasoning_effort: low` (lowest accepted); max output 8,192 incl. reasoning |
| G120 | `openai/gpt-oss-120b` | same | `reasoning_effort: low` |
| Q | `alibaba/qwen3.8-flash` | same | `reasoning_effort: none` |
| DS | `deepseek/deepseek-v4-flash` | same | `reasoning_effort: none` |

Not run: `google/gemini-3.1-flash-lite` (gateway list $0.25 / $1.50 per M, above Luna's $0.20 / $1.20; its batch
listing is not reachable through synchronous chat completions).

Structure: every arm runs **two-call** (pipeline order) on held-out. **One-call** (`ONE_CALL_PROMPT`) is run on
held-out only for candidates that pass the floor in two-call; its label fields cannot be scored on this set, so it is
reported on parse rate, extraction recall and precision against the same candidate's two-call run and L-fresh.

Calls: up to 3 attempts per call on an unparseable answer (as `codex.ts`). **A truncated answer (`finish_reason` =
`length`) is a failure: the chunk yields zero records, it is not retried, and it is never dropped from scoring.** HTTP
429/5xx are retried with backoff (not counted as failures unless they exhaust). A failed label call keeps the records
(as the pipeline). max_tokens: extraction and label 16,000, one call 24,000, clamped to the model's `max_output`.

## Metrics (held-out, `score.py extraction`)

- **Floor metrics:** (1) group recall excluding unsure, pooled; (2) the same, macro-averaged per note; (3)
  breaking-group recall (pooled, all breaking groups).
- **Nits gate:** precision (credited records / records).
- Reported: records per note, recall incl. unsure, per technology and per ecosystem (descriptive; n too small to
  separate), parse failures and truncations (chunks), attempts, tokens (input, cached, output, reasoning), $ for the
  run (provider-reported cost), wall time.
- **Paired comparison:** `slice3/stats.py` (score.py's own `paired`: exact McNemar on groups and a 2,000-resample
  bootstrap resampling whole notes, seed 20261016) for each floor metric and precision, candidate − L-fresh.
  "Significantly worse" = the bootstrap 95% CI of the difference lies entirely below 0.
- **Noise floor:** L-fresh − L-cached on the 32 notes the cache covers (same statistics), reported beside every
  comparison.

## Decision rule (as given; fixed before running)

1. **Floor.** A candidate passes if, on each of the three floor metrics, it is no more than 5 points below L-fresh
   AND the note-level bootstrap does not show it significantly worse. Luna's fresh-vs-cached difference is reported
   as the noise floor.
2. **Nits gate.** Then its precision must be no more than 10 points below L-fresh.
3. **Cost.** Among passers, the lowest worst-case cost per technology-year wins: the structure's formula
   (two-call: input 2N + R·o_A·1.5 + c·(P_A + P_B); one call: N + c·P_1; N, c, R, P from `cost.mts`), output = R ×
   the run's measured output tokens per record **including reasoning**, R scaled by the candidate's records relative
   to L-fresh on held-out, multiplied by the production attempt factor (attempts per chunk-call, a truncated or
   failed chunk counted as 3 attempts at full max output). Priced at the gateway list price. Reported for the mean
   technology, the largest technology (N 204k, c 531, R 1,092) and at 10k / 50k / 200k technologies.
4. If a costlier model is significantly better than the winner on a floor metric, the trade-off is presented.
5. If the held-out set cannot separate candidates (CIs wider than the 5-point margin), the report says so.

Speed is only the final tie-break.

## Process and budget

1. Smoke each gateway candidate on 2 dev documents (fixed: the two smallest of the 9); eyeball subject literals,
   summary faithfulness, verbatim evidence, plausible label fields.
2. Projection: the smoke's measured $ per input character × (held-out + dev characters) × 1.5. **A candidate
   projected above $0.60 for its held-out + dev runs is aborted.**
3. Dev sanity run (9 documents) per candidate, then **one** held-out run per arm.
4. Gateway spend for the slice ≤ **$4.00**, from this slice's own usage log (`out/slice3/usage.jsonl`, the gateway's
   reported cost per call). Every call is refused once the log reaches $4.00, and a run is refused when its worst
   case (input chars/3, max_tokens per call) exceeds what remains of the cap or the live balance minus $1.
5. **Finalists' label fields** (only if ≥ $1.50 remains and at most 2 finalists): the gate (`eval/gate`, `GATE_K=0`,
   next/prisma/nestjs — not technology-disjoint) on side stores rebuilt with the cheapest passer in the structure
   slice 2 recommends (two-call if slice 2 has not concluded), using slice 2's side-store machinery if it exists;
   otherwise reported as the open step.

## Known limits

- One fresh Luna run and one cached run give one noise pair; the 5-point margin is the brief's, not derived from
  noise.
- Precision credits records that overlap an adjudicated anchor; a real change the labelers left out counts as a nit.
- L-fresh runs through `codex exec`; gateway candidates through chat completions. The harness system prompt differs;
  the user prompt is identical.

---

# Slice 3b pre-registration: the extraction model on BOTH held-out sets

Written 16 October 2026, before any model output on held-out set 2 exists (no run of any arm on it; its labels were
read only for counts: 510 groups, 221 required excluding unsure, 280 breaking). Why: slice 3's Qwen passed the
short-notes set (H1) but lost required changes on guides and major notes in dev and the gate (`RESULTS.md`). The
holdout-majors Addendum makes a pass on both sets the rule. Runner: `run3.mts` with `--out slice3b --cap 2.5`
(prompts unchanged since slice 3: same `prompt_sha` as its runs), two calls in pipeline order.

## Sets

| Set | What | Scorer | Bootstrap unit |
|---|---|---|---|
| **H1** | `holdout/extraction/`, 40 short and long release notes, 270 groups | `stats.py` (score.py `paired`) | note |
| **H2** | `holdout-majors/extraction/`, 7 documents (3 guides, 4 major notes), 510 groups, 221 required excl. unsure, 280 breaking | `score.py compare` (auto = top-level section, Addendum) | section |

## Arms

| Id | Model | Reasoning | H1 | H2 |
|---|---|---|---|---|
| L-fresh | `gpt-5.6-luna`, `codex exec`, plan | pipeline default | slice 3's run (reused) | **two fresh runs, `r1` and `r2`**, own empty caches |
| Q8 | `alibaba/qwen3.8-flash` | none | slice 3's run (reused) | new |
| L6 | `openai/gpt-6-luna` | low (as briefed) | new | new; **medium on H2 once, only if low passes both sets** (report only) |
| N5 | `openai/gpt-5-nano` | minimal (`none` still reasons: probe) | new | new |
| NM | `nvidia/nemotron-3.5-lightning` | none | new | new |
| Q7 | `alibaba/qwen3.7-flash` | none | new | new |
| G47 | `zai/glm-4.7-flash` | none | new | new |

Slice 3's failed arms (DeepSeek V4 Flash, gpt-oss-20b/120b) are not rerun; they already fail H1.

## Decision rule (fixed before any H2 output)

1. **Baseline on H2 is L-fresh `r1`.** `r2 − r1` is the noise floor, reported beside every H2 comparison (same
   statistics). On H1 the baseline is slice 3's L-fresh, its noise floor slice 3's fresh − cached.
2. **Floor**, on each set: every floor metric no more than 5 points below the baseline AND the set's bootstrap does
   not show it significantly worse (95% CI of candidate − baseline entirely below 0).
   - H1: group recall excluding unsure pooled, the same macro per note, breaking-group recall.
   - H2: required-group recall excluding unsure (pooled), breaking-group recall (pooled).
   A candidate must pass on H1 AND H2.
3. **Nits gate:** precision no more than 10 points below the baseline, on each set.
4. **Cost:** among passers, the lowest worst-case $/technology-year wins (`cost3.py`, the slice 3 formula; output =
   R × measured completion tokens per record including reasoning; R scaled by records relative to L-fresh on the same
   set; attempt factor with a failed or truncated chunk counted as 3 attempts). It is computed from the H1 run and the
   H2 run separately, and **the larger of the two** is the candidate's worst case. Gateway list price. Mean
   technology, largest technology, 10k / 50k / 200k technologies. Luna stays the incumbent if no candidate passes.
5. If a costlier model is significantly better than the winner on a floor metric (either set), the trade-off is
   shown. If CIs are wider than the 5-point margin, the report says the set cannot certify it.
6. **One call** runs on H2 only for candidates that pass both sets (two-call): reported on the H2 floor metrics and
   precision against the same model's two-call and L-fresh `r1`. It is not adopted from this slice: its H1 run is
   absent for new arms and its label fields are not scored here.

Failures: a truncated answer (`finish_reason` = `length`) or an empty/unparseable answer after 3 attempts yields zero
records for its chunk and is never dropped. max_tokens 16,000 per call (one call 24,000), as slice 3.

## Process and budget

1. Smoke each new gateway arm (`--split smoke3b`: the shortest H1 note and msw's 3.0 guide); eyeball subjects,
   summaries, verbatim evidence, label fields; record truncations/empties.
2. Projection: smoke $ per input character × (H1 + H2 characters, plus H2 again for L6 medium) × 1.5. **An arm
   projected above $0.50 for its runs is aborted.** The runner's dry-run worst case is also printed.
3. **Gateway cap for the slice: $2.50**, from `out/slice3b/usage.jsonl` (provider-reported cost; every call refused
   at the cap; also never beyond the live balance minus $1).
4. **Gate** (only if an arm other than Luna passes both sets and ≥ $0.80 of the cap remains): rebuild
   next/prisma/nestjs with it (two-call) through `codex-shim.mjs` into `.store/slice3b-<model>/`, `GATE_K=0
   eval/gate/run_gate.sh`, compared with slice 2's Luna rebuilds (T-fresh, T-cached) and slice 3's Qwen on required
   coverage and first-16. Not technology-disjoint; it measures label fields end to end. Jev spend ≤ $0.30.

## Known limits

- H2 has 7 documents and 4 technologies; sections are the bootstrap unit, which assumes sections are roughly
  independent. Required excl. unsure has 221 groups (MDD ≈ 7–8 points at 10% discordance): the 5-point margin may
  not be certifiable.
- Luna runs through `codex exec` without max_tokens; gateway arms are capped at 16,000 output tokens per call. A long
  guide answered at length can truncate for a gateway arm and not for Luna; that counts against the arm, as in
  production through the shim.
- Two Luna H2 runs give one noise pair.

# Slice 3c pre-registration: cutting the cost of the settled extraction setup (gpt-6-luna, low, two calls)

16 October 2026. Written before any 3c output on H1 or H2. Runner `run3.mts --out slice3c --cap 3.5` (new flags are
recorded in each run's meta.json). Model `vercel:openai/gpt-6-luna`, max_tokens as slice 3b.

## Baselines

The slice 3b gpt-6-luna two-call low runs, re-scored unchanged: H1 `out/slice3b/runs/vercel_openai_gpt-6-luna-two-call-heldout`,
H2 `out/slice3b/runs/vercel_openai_gpt-6-luna-two-call-heldout2`. The H2 replicate (`…-heldout2-rep2`) is the noise
reference: its difference from the baseline is reported beside every H2 comparison.

## Experiments, in order (each runs only after the previous one is decided)

1. **Evidence by unit id** (`--evidence ids`, `UNSTALE_EXTRACT_EVIDENCE=ids`): the notes go to the extract call with
   numbered units (a line; a sentence of a line over 240 characters); the record returns a list of 1 to 3 unit numbers
   (amended after the smoke, before any held-out run: the model ignored a range cap and returned ranges of up to 22
   lines); the quote is the named units in reading order. The label call is unchanged (it receives the rebuilt quote).
2. **One call, strict structured output, records first** (`response_format: json_schema`, strict): `{records: [...],
   labels: [{id, ...}]}`. Combined with (1) if (1) is adopted.
3. **Reasoning effort** below `low`, on the adopted structure. Both `none` and `minimal` were accepted at probe (amended
   before any run): `none` runs first; `minimal` runs only if `none` fails.
4. **Output diet** (`#7`): drop extract-call output fields no downstream code reads, and shorten what can be shortened.
   Additionally checked against D: the classifier (Jev) rerun on the variant's H1 records, labels compared with the
   baseline's on records matched by key quote.
5. **Recall hill-climb**, only with budget left: at most 3 prompt variants designed on DEV documents and free analysis of
   misses; one look at H1 + H2.

## Decision rule (per experiment, against the baselines above)

1. **Floor**, as slice 3b rule 2 with the baseline replaced: H1 pooled and macro recall excluding unsure and breaking
   recall; H2 required recall excluding unsure and breaking recall. Each no more than 5 points below the baseline AND
   the 95% CI of variant − baseline not entirely below 0. Both sets.
2. **Nits gate:** precision no more than 10 points below the baseline, each set.
3. **Cost:** adopted only if cheaper. Cost is the run's provider-reported $ on the same documents relative to the
   baseline run's $ (both sets summed), applied to slice 3b's worst-case $/technology-year for gpt-6-luna ($0.0192);
   the result is quoted at 10k / 50k / 200k. A saving smaller than the baseline's own H2 run-to-run cost spread (8%) is
   reported as not shown.
4. A variant that passes on both sets gets a gate rebuild (`GATE_K=0`) before it is recommended; a required change
   that both the baseline rebuild and Luna cover and the variant misses is reported.

## Known limits, stated before running

- **Rebuilt quotes are whole units.** The scorer credits a record when its quote contains an anchor (≥ 25 characters)
  or the reverse, so longer quotes can be credited more easily. Reported for (1): mean and median quote length against
  the baseline, and the share of records whose quote overlaps the anchors of more than one group. If the quote length
  grows by more than 50%, the recall result is labelled as possibly inflated.
- **D and E read the quote**, so quote length changes S. Reported as mean quote characters; the gate rebuild covers E end
  to end.
- **Label fields are not scored** on H1/H2 (as 3b).

### Slice 3c amendment: experiment 4 (output diet), fixed before its runs

Measured on the baseline answers (free): `change_type` and `surface` are 12% of extract-answer characters and are read
by nothing downstream (they become `hint_change_type`/`hint_surface`; the classifier labels both); indentation and
line breaks are 12.5%; summaries average 12 words (cap 40), so a tighter cap would save little and is not tested.
Variant (`--diet`, `UNSTALE_EXTRACT_DIET=1`): drop both fields from the extract record and ask for compact JSON on one
line (amended at the smoke: "one record per line" made the model drop the commas between records). Run on the configuration current when it runs (with effort `none` if that is adopted, compared with
the matching baseline). Floor, nits and cost as above. **D check:** Jev on the variant's H1 records and on the baseline's,
paired by matched quote (exact after whitespace folding); reported: agreement on breaking, change_type, surface and each
benefit; adopted only if breaking agreement is no lower than Jev's own repeat agreement on the same records (Jev rerun
on the baseline records, cached answers excluded).

### Slice 3c amendment: experiment 5 (recall hill-climb), fixed before any of its runs

Free analysis of the baseline's misses: on H1 no required-sure group is missed; 87 sure misses, mostly fixes in zod's
long notes (the prompt skips fixes by design; not targeted, since recovering them raises R and with it D and E).
On H2, 25 required-sure misses, concentrated in removals and raised minimum versions in long lists (transformers major
notes: 10; kit guide: 5; mypy notes: 3). Variant `lists` (`addenda.ts`): one paragraph telling the model that long
notes hold dozens of changes and that each removal, rename or move, changed default, raised minimum version and
deprecation in a list is its own record. Step 1: DEV (9 documents, `eval/sets/score.py extraction`) against a gpt-6-luna
baseline DEV run with the same configuration: proceed only if required fetched does not fall and records do not grow
more than 25%. Step 2: one look at H1 + H2. **Adopted only if** H2 required recall excl. unsure rises with a 95% CI
entirely above 0, the H1 floor holds (as rule 1), and precision passes the nits gate on both sets; its cost change
(records grow R for D and E) is reported per technology-year including D and E at their measured $/record.

### Slice 3c amendment: experiment 4b (compact JSON only), fixed before its runs

The diet arm failed (H2 required −6.8, H1 pooled −6.6, both CIs below 0) with 7–11% fewer records; it changed two things.
Arm 4b keeps every field and changes only the format (JSON on one line, no indentation), at effort `low` against the
slice 3b baselines (`--diet compact`, `UNSTALE_EXTRACT_DIET=compact`). Same floor, nits and cost rules. This is the
seventh look at H1/H2 in this slice; its result is reported with that caveat.
