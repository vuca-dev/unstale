# Port parity: pre-registration

Written 11 November 2026, before any paid call. The model steps (extraction of changes from release notes, labels on
each record, the same-or-new judge that merges duplicates) now also run in the Rust client
(`local/cli/src/pipeline/`). The sprint holds this line: **the client's steps reproduce central's numbers for the same
model within run-to-run noise.** Request bytes were proven identical only for snapshot cases; this run checks the real
evaluation sets. Client under test: `origin/main` at `8835d5c`, `unstale internal run-step`.

## Sets (central's own inputs, unchanged)

| Name here | What it is | Source |
|---|---|---|
| Short notes | 40 release notes of posthog-js, typer, uvicorn, zod (43 chunks) | `eval/select/holdout/extraction` |
| Guides | 7 upgrade guides and major-version notes of SvelteKit, msw, mypy, transformers (7 chunks) | `eval/select/holdout-majors/extraction` |
| Label set 1 | 233 records with adjudicated labels | `eval/select/holdout/classify` |
| Label set 2 | 347 records extracted from the guides set, breaking or not known per record | central's `out/slice4/h2-units.json` |
| Matching set | 236 judge requests (a Nuxt replay and the Next.js upgrade guide), 197 with a true match, verdicts audited | central's `out/slice5/units.json` |

`build_inputs.mts` writes them in the shape `run-step` reads, using central's own code for every conversion (`eventOf`
for change events, `recordState` for label states, `retrieve` and `matchRequest` for judge requests, `shardLine` for
candidate records), and writes what central would send for each item. `inputs-manifest.json` holds counts and hashes.

The workstream document calls these "slice 4's H1 and H2 and slice 5's held-out set". Extraction's two sets are slice
3's; slice 4 (labels) reuses their records.

## Cells

| # | Step | Route | Set | How it runs |
|---|---|---|---|---|
| 1 | Extraction | `gpt-6-luna` through the OpenAI-compatible gateway | Short notes | live |
| 2 | Extraction | same | Guides | live |
| 3 | Labels | labelling service | Label set 1 | central's stored answers replayed, plus a live sample of 25 |
| 4 | Labels | labelling service | Label set 2 | replayed, plus a live sample of 25 |
| 5 | Labels | `gpt-6-luna` by choice | Label set 1 | live |
| 6 | Labels | `gpt-6-luna` by choice | Label set 2 | live |
| 7 | Matching | labelling service | Matching set | replayed, plus a live sample of 25 |
| 8 | Matching | `gpt-6-luna` by choice, central's production rule | Matching set | live |
| 9 | Extraction | Codex, batched 8 chunks per call | Short notes | live, on the Codex plan (`codex login status`: logged in) |

Not run: an Anthropic key alone (out of scope: no Anthropic key is used); OpenRouter (cut by the sprint).

**Why the labelling-service cells replay.** Central's stored baselines for labels were answered by service version
1.13.0. The service has since moved to 1.14, and central's own results record that the update changed the labels of
40 of the 233 records at the 0.5 threshold. A live run today would compare two model versions, not two ports. So the
client is given central's stored answer for each request, through a loopback stand-in (`recorder.py`) that answers
**only a request whose bytes equal central's**. That tests everything the port owns: the request, reading the answer,
the thresholds, the guards. The live sample of 25 per cell shows the real route answers; it is reported with the
version that served it and is not part of the pass rule.

**Free checks already run (no paid call; outcomes known when this was written).** The client was pointed at the
loopback stand-in for every cell:
- Labelling-service requests: 815 of 815 byte-identical to central's (233 + 347 label requests, 235 judge requests;
  one judge request has no candidate above the question floor and is not sent by either side).
- Chat prompts for labels and for the judge: 815 of 815 identical to central's `ChatClassifier` prompt. The request
  around the prompt is the client's production body (`max_tokens` 16,000, reasoning effort low, the gateway's flex
  tier); central's evaluation runs sent `max_tokens` 4,000 and no tier, so no stored chat answer is for a
  byte-identical request and cells 5, 6 and 8 are live.
- Extraction, first call: 49 of 49 prompts identical to central's (one chunk has no content and is sent by neither).
  Central's evaluation harness sent no tier field, so cells 1 and 2 are live too.
- Central's production `matchRequest` reproduces all 235 requests of central's stored production-wording run.
- Cells 3, 4 and 7 replayed: results are in RESULTS.md with the paid cells.

## Metrics, central's reference numbers, bands

Scorers are central's own, unchanged (`eval/select/holdout/score.py`, `slice3/stats.py`, `slice3/stats3b.py`,
`slice4/analyze.py`, `slice4/analyze_h2.py`); matching follows `slice5/score5.mts`. `score.py` here reproduces every
reference number below from central's stored runs before any client run is scored.

Sources: PM = `eval/provider-matrix/RESULTS.md` on branch `eval/provider-matrix`; S3b = `eval/select/slice3/RESULTS-3b.md`;
S4 = `eval/select/slice4/RESULTS.md`; S5 = `eval/select/slice5/RESULTS.md`.

| Cell | Metric | Central | Source | Central's own run-to-run record |
|---|---|---|---|---|
| 1 | Recall of labelled changes, pooled, unsure excluded | 66.3 | PM, "A+B" table, baseline row | replicate 67.4 (+1.2); direct OpenAI route 66.3 |
| 1 | Recall, mean per technology | 91.9 | same | 91.7; 92.5 |
| 1 | Recall of breaking changes (35 groups) | 82.9 | same | 85.7 (+2.9, 7 discordant groups); direct route 74.3 (−8.6) |
| 1 | Precision of records | 82.0 | same | 81.1; 83.2 |
| 2 | Recall of required changes, unsure excluded | 88.7 | PM same table; S3b guides table | replicate 85.1 (−3.6, CI −9.9…+1.5) |
| 2 | Recall of breaking changes | 86.4 | same | 83.9 |
| 2 | Precision | 84.8 | same | 83.7 |
| 3 | Breaking / benefit / actionable recall, change-type accuracy at 0.5 | 82.8 / 85.1 / 84.9 / 82.0 | PM, "D" table, "At 0.5" and change_type columns | two fresh runs differ by at most 0.8 points (S4, "Jev repeatability") |
| 4 | Breaking recall / precision at 0.5 | 90.0 / 94.5 | PM, paragraph under the "D" table | same |
| 5 | Breaking recall, benefit recall, actionable recall, change-type accuracy | 86.2 / 96.7 / 89.0 / 85.0 | PM addendum 1, column "CH, fresh run" | none recorded for this prompt. An earlier run on another prompt, read on its choices: 86.2 / 97.5 / 87.7 / 85.0 |
| 6 | Breaking recall / precision | 92.6 / 92.2 | PM addendum 1 | none recorded. Earlier run, other prompt: 92.6 / 93.0 |
| 7 | Merge recall; false merges per 100 merges | 171/197 = 86.8%; 1.4 | PM, "E" table, row "Jev 1.14 Q8 at production's C′" | two fresh runs on the older wording: 175 and 171 recalled, 0.8 and 0.6 false per 100 (S5, "Jev repeatability") |
| 8 | Merge recall; false merges per 100 merges | 142/197 = 72.1%; 0.0 | PM, "E" table, column "Fallback rule", row gpt-6-luna | none recorded |

Notes on references:
- **Cell 7** is compared with central's run on production's wording, question floor and bars (0.82 / 0.91 / 0.99),
  because that is what the client implements (`schema/prompts/thresholds.json`). Slice 5's older-wording run (175/197,
  0.8) is another request and is shown for scale only.
- **Cell 8.** The sprint's decision row (corrected 11 November on the tracker branch; `main` still carries the earlier
  text) says: no false merges measured, about 4 more duplicate records per technology-year. The measured figure
  behind it is 142/197 recalled against the labelling service's 175/197: 33 more missed merges over 867 records, 3.8
  per 100 records, 4.4 per mean technology-year of 114.6 records. Central measured it by re-reading answers to a
  different request (the older wording, all 8 candidates, a prompt that also asks for probabilities) with the rule
  "merge only on a near-identical quote of the same kind". The client sends production's wording, asks only candidates
  above the question floor, and asks for choices only. No stored central run uses the client's request, so this is the
  only reference; a gap may come from the request rather than the port, and the diagnosis pass would say which.
- **Cells 3 and 4** use the service's production threshold, 0.5, which is the client's (`breaking_p`, `benefit_p`).
  Central's results also quote the service at a dev-fitted 0.05; the client does not run that.

**Band and pass rule.**
- Replayed cells (3, 4, 7): the answers are central's, so there is no noise. Pass = every request byte-identical, and
  every record's labels (3, 4) or every item's decision (7) equal to central's, so every metric is equal.
- Live cells (1, 2, 5, 6, 8): the results files record at most one replicate per metric, which is one observed
  difference, not a band. Band used: the 95% interval of the paired difference, client minus central's reference run,
  from central's own comparison code (bootstrap over whole notes for cell 1, over document sections for cells 2 and
  6, over records for cell 5, over items for cell 8 with exact McNemar for false merges). **A metric passes when that
  interval includes 0** (for false merges: McNemar p ≥ 0.05). Central's own replicate differences are printed beside
  each result for scale. A cell passes when all its metrics pass; parity passes when every cell run passes.
- 15 intervals are read on the live cells, so about one may exclude 0 by chance. That is what the diagnosis pass is for.
- Cell 9 has no central number. It reports recall and precision against the direct route (cell 1's client run and
  central's three runs) with the same paired interval. "No measurable loss" = every interval includes 0.

**Stopping rule.** One run per cell. If a cell fails, one diagnosis pass to find the cause (a port difference or
noise), reported with a failing input; then stop. No tuning, no product code change, no second run to get a pass.

## Cost per technology-year

Central's volume for a mean technology-year (`slice3/cost3.py`, `cost.mts`): 6,460 note tokens in 17.5 chunks, 114.6
records. Extraction uses `cost3.py`'s formula with the client's measured output per record and attempts per call;
labels use measured tokens per record × 114.6; matching uses measured tokens per request × 114.6 (every record asks
once: an upper bound). Dollars at the gateway's list price for `gpt-6-luna` ($0.10 in, $0.01 cached in, $0.50 out per
million) and at flex (half); the labelling service at $0.042 per million input. For replayed cells the tokens are
central's logged ones for the same requests, and the live sample checks them. Codex is reported in plan tokens
(harness included) with the list-price equivalent.

## Spend

Estimate from central's token counts for the same sets, list price:

| Cells | Calls | Tokens in / out | $ |
|---|---|---|---|
| 1, 2 extraction | about 100 | 290k / 125k | 0.10 |
| 5, 6 labels by choice | 580 | 950k / 85k | 0.14 |
| 8 matching by choice | 235 | 420k / 40k | 0.06 |
| 3, 4, 7 live samples | 75 | 140k / 0 | 0.01 |
| 9 Codex | about 50 | about 450k plan tokens | 0 (plan) |
| **Total** | | | **about $0.31** (flex bills about half of the gateway part) |

The earlier estimate was about $0.60; replaying the labelling-service cells removes most of its labels and matching
share. Worst case (every call retried three times at full output) stays under $1. **Hard cap: $3**; the gateway
balance is read before and after each cell, and the run stops if the running total passes the cap.

Keys: the gateway key and the labelling-service key are read from the key files central's own code names
(`central/src/pipeline/llm.ts`, `classify/adapter.ts`), one variable each, into the client process only. Each cell
runs with a temporary home, config directory and cache directory; the monthly token limit is set high in that
temporary config so no cell stops midway; caches are kept until the end so an interruption resumes without paying
twice.

## Addendum 1: re-measurement after two fixes (written 11 November 2026, before any call for it)

PR #237 (head `1494730`) changes two things this run found: a choice answer that gives an option's text is read as
that option (central and client), and Codex extraction batches by length (a chunk above 6,000 characters goes alone; a
batch holds at most 12,000 characters and 8 chunks). The client is rebuilt at `1494730` in its own worktree. Two cells
are run again, with the same inputs, scorers, metrics and bands as above.

| Cell | What runs | Metrics and band | Reference |
|---|---|---|---|
| 8b | Matching on `gpt-6-luna` by choice, production rule, matching set | Merge recall (95% interval of the paired difference includes 0); false merges per 100 merges (McNemar p ≥ 0.05) | Central: 142/197 = 72.1%, 0.0 |
| 9b | Extraction through Codex with the new batching, short notes | Recall pooled, mean per technology, breaking; precision; paired interval as before | The client's direct run (cell 1: 75.6 / 90.4 / 74.3 / 78.8), central's three direct runs, and the old batching (cell 9: 53.5) |

- **Cell 8b reuses cell 8's answer cache.** The prompt data is unchanged between the two builds, so request bytes and
  cache keys are the same. The 213 requests answered in cell 8 are read from a copy of its cache and cost nothing.
  The 23 requests stored as unreadable hold no answer text (the cache keeps only the failure), so their entries are
  removed from the copy and they are asked again, up to three attempts each as before. Known limit: the 213 cached
  answers are ones the old reading accepted, some on a second or third attempt; the new reading would have accepted
  an option-text answer on the first.
- **Labels by choice (cells 5 and 6) are re-read from their caches** with the new build; expected calls: none.
  Reported: whether any record's label changes.
- **Cell 9b runs on an empty cache** (the batch form changed), on the Codex plan, after `codex login status`. Also
  reported: plan tokens per technology-year under the new batching (the 152k figure was the old batching's).
- **Rule: one run each, no further revision whatever the outcome.** A cell that fails stays failed in the results.
- **Verdict.** The pre-registered verdict above stands as it was recorded. The addendum adds a second verdict: parity
  under the fixed build = cells 1 to 7 as run, with 8b in place of 8.
- **Spend.** Estimate: at most 69 gateway calls of about 1,700 input tokens, under $0.02; Codex about 350k plan
  tokens. Cap for this step: $0.50 of API spend. Keys as before: only the two named variables, read from the key
  files central's code names, passed to the client process, never printed.

## Addendum 3: labels, several records to a call on a key (written 11 November 2026, before any call for it)

On a route that writes text the client now asks for the labels of up to eight records in one call, answered by record
id (`schema/prompts/choice.json`'s `batch` form, unchanged; `Chooser::prefetch`, until now used through Codex only).
A record a batch does not answer readably is asked alone, as before. No prompt, question or threshold changes.

| Cell | What runs | Metrics and band | Reference |
|---|---|---|---|
| 5c | Labels on `gpt-6-luna` by choice, eight records to a call, label set 1 (233 records) | Every paired interval `score.py labels h1` reports (breaking, benefit, change type, actionable, removal and deprecation): the 95% interval of batched minus reference includes 0 | The client's own run of cell 5 (one record a call), given to the scorer through `batch_reference.py` |
| 6c | The same, label set 2 (347 records) | Breaking recall and breaking precision, the same band | The client's own run of cell 6 |

- **Batches** are the input file's records in order, eight to a call (one shard), so a batch mixes technologies only
  where the file does.
- **Pass rule:** every interval in both cells includes 0, and no record is left without labels once the records a
  batch did not answer have been asked alone. Also reported, not part of the rule: the metrics against the audited
  labels beside the reference run's, records whose labels differ from the reference run's, records that fell back to a
  call of their own, and input and output tokens per record.
- **Stopping rule:** one run. If it fails, one revision, four records to a call (the constant only), one run; then
  stop, whatever the outcome. A failed result closes the change.
- **Spend.** Estimate: 74 calls of about 2,200 input tokens (165k) and about 75k output tokens with reasoning, about
  $0.05 at list price. Cap for this step: $0.15, the revision included. Every answer is cached per record, so a rerun
  after an interruption pays only for what is missing.
