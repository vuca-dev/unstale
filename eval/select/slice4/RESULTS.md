# Slice 4 results: the record-label classifier (step D)

Run on 16 October 2026 under `PREREG.md`. Held-out: 233 records (posthog-js, zod, uvicorn, typer). Reference:
`classify/labels/adjudicated.json` (breaking 29, benefit 121, actionable 73, removal or deprecation 12).

## Decision

- **Keep Jev.** Under the pre-registered rule, Qwen3.8 Flash, DeepSeek V4 Flash and Luna pass the floor. Jev,
  the baseline, is cheaper than all three: $0.0108 per mean technology-year, against $0.041 to $0.107. None of them is
  significantly better than Jev on a floor metric, so there is no trade-off to present at the fitted thresholds.
- **Clef Flash is the only candidate cheaper than Jev, and it fails** on actionable recall: 69.9 against 83.6
  (−13.7 pts, CI −24.7 to −4.1). Its change_type accuracy is also 12.4 pts lower.
- **gpt-oss-20b and gpt-oss-120b fail** on benefit recall and actionable recall. The encoder fails on actionable
  recall. Batched Qwen (b = 10) fails at its fitted thresholds; see the threshold caveat below.
- **Trade-off at the pipeline's live thresholds (0.5, sensitivity only):** Qwen (+10.7 pts, CI +5.0 to +17.4) and
  Luna (+7.4, CI +1.7 to +14.0) beat Jev on benefit-vs-none recall. Jev closes that gap by moving its own threshold:
  at `BENEFIT_P` 0.10 it reaches 99.2% recall with 70.2% precision, and Qwen at its fitted threshold has 63.5%
  precision. **It is a threshold question, not a reason to change model.**
- **Do not ship the fitted thresholds as they are.** F2 on the dev sets moves `BREAKING_P` to 0.05 for Jev, which cuts
  held-out breaking precision from 77% to 36%: a flood of tier-1 nits. Any threshold change needs a fit that caps
  precision on a dev set with natural prevalence (see evalism, point 1).
- **Power:** the held-out set cannot separate Jev, Luna, Qwen and DeepSeek on the floor. With n = 29, each breaking
  miss is 3.4 pts, and the CIs span about ±10 pts. It does separate the failures above.

## Candidates (held-out, at the thresholds fitted on dev)

The first three metric columns are the floor; the next four are secondary. Cost is per record as measured on this
held-out run, with retries and reasoning tokens included. Cost per technology-year uses R = 114.6 records for the mean
technology and R = 1,092 for the largest (`cost.mts`). Fleet figures are the mean technology times 10k, 50k and 200k
technologies.

| Candidate | Fitted B/Bn P | Breaking R | Benefit R | Actionable R | Breaking P | Benefit P | change_type acc. | Rem.+dep. R (n 12) | Parse (dev / held-out) | Spend this run (held-out) | $/record | $/tech-yr (mean / max) | 10k / 50k / 200k | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Jev J1 (baseline)** | 0.05 / 0.10 | 93.1 | 99.2 | 83.6 | 36.0 | 70.2 | 81.1 | 91.7 | 100 / 100 | $0.022 | 0.000094 | **0.0108** / 0.103 | $108 / $539 / $2,158 | baseline, cheapest passer |
| Jev J2 | same | 93.1 | 98.3 | 83.6 | 35.5 | 69.6 | 81.1 | 91.7 | — / 100 | $0.022 | 0.000094 | same | same | (repeat) |
| Clef Flash | 0.10 / 0.10 | 96.6 | 96.7 | **69.9** | 32.6 | 58.8 | 68.7 | 91.7 | 100 / 100 | $0.019 (free tier) | 0.000081 (input only) | 0.0093 / 0.089 | $93 / $466 / $1,864 | **FAIL** (actionable) |
| gpt-oss-20b (low) | 0.05 / 0.05 | 100 | **91.7** | **64.4** | 16.8 | 59.0 | 57.1 | 100 | 100 / 100 | $0.027 | 0.000115 | 0.0132 / 0.126 | $132 / $661 / $2,645 | **FAIL** (benefit, actionable) |
| gpt-oss-120b (low) | 0.05 / 0.10 | 89.7 | **90.1** | **72.6** | 21.7 | 65.3 | 59.2 | 91.7 | 99.3 / 100 | $0.128 | 0.000551 | 0.0631 / 0.602 | $631 / $3,157 / $12,630 | **FAIL** (benefit, actionable) |
| Qwen3.8 Flash (no thinking) | 0.10 / 0.10 | 89.7 | 99.2 | 87.7 | 23.6 | 63.5 | 80.3 | 100 | 99.5 / 100 | $0.128 | 0.000550 | 0.0630 / 0.601 | $630 / $3,152 / $12,606 | pass, 5.8× Jev |
| DeepSeek V4 Flash (no thinking) | 0.10 / 0.10 | 96.6 | 95.9 | 83.6 | 21.2 | 64.4 | 67.8 | 100 | 100 / 100 | $0.083 | 0.000358 | 0.0410 / 0.390 | $410 / $2,049 / $8,195 | pass, 3.8× Jev |
| Luna via Codex (prompt-only, list price) | 0.05 / 0.15 | 96.6 | 96.7 | 83.6 | 40.0 | 70.9 | 82.0 | 100 | **98.1** / 100 | $0.217 (plan) | 0.000932 | 0.1068 / 1.018 | $1,068 / $5,339 / $21,357 | pass, 9.9× Jev |
| Qwen b = 10 | 0.20 / 0.65 | **82.8** | 94.2 | 87.7 | 57.1 | 79.2 | 76.8 | 100 | 100 / 100 | $0.073 | 0.000315 | 0.0361 / 0.344 | $361 / $1,806 / $7,223 | **FAIL** (breaking −10.3; benefit CI below 0) |
| Encoder (ModernBERT-base) | 0.10 / 0.05 | 96.6 | 99.2 | **69.9** | 33.7 | 62.2 | 68.2 | 75.0 | 100 / 100 | $0 | 0 (CPU, 46 rec/s) | 0 | $0 + runner | **FAIL** (actionable) |

Held-out at 0.5 (the pipeline's live thresholds; sensitivity):

| | Breaking R | Benefit R | Actionable R | Breaking P | Benefit P | change_type |
|---|---|---|---|---|---|---|
| Jev J1 | 82.8 | 86.8 | 83.6 | 77.4 | 84.0 | 81.1 |
| Clef Flash | 69.0 | 66.1 | 69.9 | 100 | 89.9 | 68.7 |
| gpt-oss-20b | 86.2 | 83.5 | 64.4 | 51.0 | 66.9 | 57.1 |
| gpt-oss-120b | 86.2 | 84.3 | 72.6 | 69.4 | 69.9 | 59.2 |
| Qwen3.8 Flash | 82.8 | **97.5** | 87.7 | 80.0 | 81.9 | 80.3 |
| DeepSeek V4 Flash | 69.0 | 80.2 | 83.6 | 90.9 | 78.2 | 67.8 |
| Luna | 86.2 | **94.2** | 83.6 | 61.0 | 78.1 | 82.0 |
| Qwen b = 10 | 82.8 | **95.9** | 87.7 | 82.8 | 77.3 | 76.8 |
| Encoder | 44.8 | 88.4 | 69.9 | 65.0 | 78.7 | 68.2 |

The paired comparisons are in `out/slice4/compare.txt` and `out/slice4/report.json` (against J1 and J2, at the fitted
thresholds and at 0.5). The verdicts are the same against J2.

## Jev repeatability (two fresh held-out runs, empty caches)

15 of the 233 records (6.4%) change in some field between runs. Breaking never flips at 0.5 (mean |Δp| 0.006).
Benefit-vs-none flips on 2 records and correctness on 2. change_type changes on 4 and surface on 8 (actionable on 4).
At the fitted thresholds, J2 against J1 differs by −0.8 pts at most on any floor metric. Jev's run-to-run noise is
far below the held-out set's power.

## Clef Flash feasibility

- **It works.** The model id is `@cf/cloudflare/clef-flash`. It takes `POST /accounts/{id}/ai/run/@cf/cloudflare/clef-flash`
  with body `{model: "clef-flash", state, questions: {id: {type: "choice", instructions, criteria}}}`, which is the
  System One shape, and it answers `{choice, probabilities, confidence}` per question. The answer sits in `result`.
  The pipeline's `Jev` class runs it unchanged with a fetch that only re-targets the URL.
- **Limits:** up to 64 questions and a 24,576-token context. The listed price is $0.038/M input; there is no output
  price and the API reports 0 output tokens.
- **Use:** 1.40M input tokens over 644 calls, about 4,800 neurons at $0.011/1k neurons. That is inside the 10,000/day
  free tier.
- **Calibration:** its probabilities are flatter than Jev's (p ≤ 0.4 is common). At 0.5 its recall collapses
  (benefit 66.1). It fails anyway on actionable recall and change_type.

## Batching (b = 10, Qwen3.8 Flash, picked by best dev recall among the chat models)

- **Input per record falls from 1,914 to 278 tokens (−85%)**, as O(R·s + (R/b)·Q) predicts.
- **Cost per record falls only 43%** ($0.00055 → $0.000315): output (about 570 tokens per record of choices and
  probabilities) is unchanged and dominates a chat model's bill. No record had to be retried alone.
- **Accuracy holds at 0.5:** breaking recall 82.8 against 82.8 single, benefit 95.9 against 97.5, actionable 87.7
  against 87.7, change_type 76.8 against 80.3.
- **At its fitted thresholds it fails.** The dev fit picked `BENEFIT_P` 0.65 and `BREAKING_P` 0.20, and lost
  breaking recall (24/29). This is a weakness of the threshold fit (point 1), not clear evidence against batching.
- **Batching does not help Jev,** whose output is free and which takes one state per request. It matters only for a
  chat model.

## Encoder (distilled from Jev; ceiling = Jev)

- **Model:** ModernBERT-base, with mean pooling and heads for change_type (12 options), surface (9) and 6 sigmoids.
  Loss is soft cross-entropy and BCE on Jev's probabilities.
- **Why ModernBERT over DeBERTa-v3-small:** it was pre-trained on code and text, which suits identifier-heavy
  changelog states. It also runs cleanly on MPS with SDPA, whereas DeBERTa-v3 is known to be slow and to have fp16
  issues on Apple GPUs.
- **Data:** 7,818 records from 76 technologies, rebuilt from the store's Codex cache. These are the pipeline's exact
  states: 94% of chunks hit the cache, and 90% of records hit a Jev answer. Excluded: any id containing posthog, zod,
  uvicorn, typer, next, prisma, nestjs, nuxt or laravel. Split: 5,971 train and 1,847 validation records (7
  technologies held out by hash).
- **Training:** 3 epochs in 21.5 min on the M1 Pro. Validation loss was still falling (2.55 → 2.33 → 2.27), so the
  45-minute box was not used up.
- **Agreement with Jev on the validation technologies:** breaking 91%, benefit-any 89%, change_type 83%,
  runtime_internal 80%.
- **Inference:** 46 records/s on CPU with 4 threads, so a 1,092-record technology takes about 24 s on a free runner.
- **Held-out:** breaking and benefit recall match Jev at the fitted thresholds. **Actionable recall is 69.9 (−13.7,
  significant) and change_type accuracy 68.2:** the imitation error on surface adds to Jev's own error. At 0.5 its
  breaking recall is 44.8 (its probabilities are shrunk).
- **Verdict:** not adoptable now. A longer run is the next step, scored on a fresh held-out set, not this one again.

## Spend (this slice, `out/slice4/usage.jsonl` and `chat-usage.jsonl`)

| Provider | Spend | Cap |
|---|---|---|
| AI Gateway | **$1.24** (4 models × dev + held-out, smokes, b = 10). The live balance went $9.74 → $7.59; the other $0.91 is another slice. | $3.00 |
| Jev | **$0.083** (smoke, dev, 2 × held-out) | $0.50 |
| Cloudflare | About 4,800 neurons, inside the free tier ($0.053 at the input list price) | free tier |
| Codex (Luna) | Billed to the plan. List-price equivalent: $0.61 prompt-only, $0.93 including the harness (13.6k input tokens per call) | plan |

Every candidate's projected cost for dev plus held-out was under $0.80; the highest was gpt-oss-120b at $0.58. No
run was aborted.

## Evalism concerns

1. **The pre-registered threshold fit is degenerate.** On the 241 breaking items, 59% are breaking, against 12% on the
   held-out set. F2 therefore pushes `BREAKING_P` to 0.05–0.10 for almost every model. Floor recalls saturate at
   90–100% and stop discriminating, and precision collapses (Jev's breaking precision: 77% at 0.5, 36% fitted). The
   rule still picks Jev, and the 0.5 view agrees on the ordering of failures. Next time, fit at a capped precision or
   a recall target, on dev data with natural prevalence.
2. **The reference labels come from Claude labelers plus adjudication,** and the adjudicator is from the same model
   family as labeler A. Luna's high benefit precision might partly reflect a shared style; this cannot be checked.
3. **The breaking dev states are synthesised** (Slice 2 items, without introduces or replaces), so thresholds fitted
   on them are fitted on a distribution the pipeline never asks.
4. **The prompts are not equal.** Jev and Clef get System One questions. The chat models get the pipeline's Codex
   fallback prompt, unchanged, which was never tuned for them, so their numbers are lower bounds.
5. **Luna refuses security records.** It failed 8 of 411 dev records, 5 of them Next.js "WebSocket upgrades" SSRF
   fixes, plus the image-optimisation and Server Actions security notes. gpt-oss-120b failed the same SSRF record
   once in the smoke test. As the production Codex fallback, Luna would drop security advisories, the records that
   matter most.
6. **Power:** breaking recall has n = 29 and removal+deprecation n = 12, so the secondary obligation recall
   (75–100%) is descriptive only. Per-ecosystem slices were not compared (n ≤ 160; `POWER.md`).
7. **`score.py` cannot read `adjudicated.json`.** It now holds an `overrides` list (1 entry) beside the 233 records,
   and `score.py classify` raises `ValueError`. Scoring used a records-only copy (`out/slice4/adjudicated-records.json`).
   The scorer or the file needs a fix; it was not edited here.
8. **The earlier cost projection for Jev understates step D.** "Jev about $15 at 10k technologies" assumed 35k Jev tokens
   per technology. The measured R·S for D alone is about 257k tokens per technology-year: $108 at 10k, $2,158 at 200k.
9. **Encoder:** the in-domain agreement (validation technologies) is optimistic. The cached Jev answers are the first
   answer to each request, not a fresh one.

## SubQ Snap (17 October 2026)

**Snap 1.1 (22 October 2026): also rejected for both steps.** See `../slice14/RESULTS.md`.

**Verdict: Jev stays.** Snap (`subq-snap-preview`, Subquadratic's decision model: Jev's systemone request and answer
shape, $0.05 per M input, output free in public preview) passes step D on H1 but fails at its own fitted threshold on
H2, and fails step E (slice 5, `RESULTS-judge2.md` § "SubQ Snap"). Together it is about 2% cheaper than Jev, so the
pre-registered switch rule (slice 5 `PREREG.md`) keeps Jev. Runner `run4.mts --cand subq` (eval-only
`eval/select/subq.ts`), on the pipeline's own wording (v1 since f99833e).

| Held-out | Snap | Jev | Paired difference (95% CI) |
|---|---|---|---|
| H1 at fitted thresholds (Snap 0.20 / 0.10, J1 as above): breaking R | 96.6 | 93.1 | +3.4 [0, +10.3] |
| H1 benefit-vs-none R | 96.7 | 99.2 | −2.5 [−5.8, 0] |
| H1 actionable R | 84.9 | 83.6 | +1.4 [−5.5, +8.2] |
| H1 breaking P / accuracy | 51.9 / 88.4 | 36.0 / 78.5 | accuracy **+9.9 [+5.2, +14.6]** |
| H2 breaking R / P at 0.5 (vs J1) | 95.7 / 93.2 | 90.0 / 94.5 | R **+5.7 [+2.8, +8.2]**; P −1.3 [−4.4, +2.0] |
| H2 at Snap's fitted 0.20 | 98.7 / 89.7 | 90.0 / 94.5 | P **−4.8 [−8.8, −1.9]**: fails |
| H2 removal + deprecation R (descriptive) | 80.7 | 85.6 | **−5.0 [−9.0, −0.6]** |
| Input tokens per record (same wording as Jev v1) | 1,663 | 2,074 | Snap's tokenizer counts about 20% fewer |
| **$ per technology-year, step D** | **0.0095** | 0.0100 (v1) | −5% (−12% against J1's older wording) |

- **H1 passes** the slice 4 floor, the cheapest passer there. At the live 0.5 Snap's benefit recall drops to 73.6, so it
  needs its own BENEFIT_P (0.10).
- **H2 fails** at the threshold fitted on dev, which is the threshold the switch rule names (slice 5 `PREREG.md`). The
  low BREAKING_P that H1's sparse breaking set rewards over-flags on guides and major notes. At 0.5, H2's own
  pre-registered threshold, it passes. No single threshold passes both sets: at 0.5 Snap's H1 benefit recall falls to 73.6.
- **Repeatability:** a second held-out run (`subq-heldout-run2`) returned identical probabilities on all 233 records.
  Jev changes 15 records between its two runs. Snap is deterministic; that is its clearest operational advantage.
- **Spend:** SubQ $0.137 (2.74M input tokens) across slices 4 and 5, on the free preview credit.
- **Revisit** if Snap's judge improves (the step-E gap is calibration on DIFFERENT pairs, not cost), or if its price
  falls: at today's prices even a pass on both steps saves about 2%.

## Files

`PREREG.md`; `run4.mts` (runner: Jev, Clef via the `Jev` class, SubQ Snap, gateway chat, Codex, b = 10); `analyze.py` (dev fit,
held-out mapping, `score.py` metrics and `compare`, cost); `repeat.py` (Jev flips); `encoder-data.mts`,
`dump-units.mts`, `train_encoder.py` (encoder). Outputs: `eval/select/out/slice4/` (runs, `report.json`,
`compare.txt`, `fits.json`, logs, `encoder/meta.json`). Reproduce the tables with `python3 eval/select/slice4/analyze.py`.
