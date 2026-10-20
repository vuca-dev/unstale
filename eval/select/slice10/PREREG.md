# Slice 10 pre-registration: a cheaper extraction model (steps A+B), free and cheap gateway models

20 October 2026. Written before any slice 10 model output exists on DEV, H1 or H2. The only calls made so far are one-word
probes ("Reply with the single word: ok") to learn which reasoning settings each model accepts and whether it is reachable.

Question: is there a gateway model that extracts as well as production's `vercel:openai/gpt-6-luna`, reasoning `low`, two
calls, flex tier ($0.05 / $0.005 cached / $0.25 per M), and costs less at the production mix?

## Candidates (ids and prices from `GET https://ai-gateway.vercel.sh/v1/models`, 20 October 2026; `prices.json` refreshed)

| Id | Model | $/M in / out | Max out | Reasoning in this slice | Runs |
|---|---|---|---|---|---|
| **MM** | `minimax/minimax-m3.1-flash` | free | 524k | `low` (production's; lowest listed) | DEV, then H1+H2 if DEV passes |
| **BF** | `reflection/beam-free` | free | 131k | `low` (production's; lowest listed) | same |
| **LG** | `inclusionai/ling-3.0-flash` | 0.021 / 0.063 | 32k | default (toggle model; reasoning on) | same |
| **MC** | `inception/mercury-2.5` | 0.04 / 0.15 | 65k | `low` | same |
| **MN** | `mistral/mistral-nemo` | 0.029 / 0.03 | 131k | none (not a reasoning model) | same |

Not run, with the reason fixed now:

- `stealth/glyph-cluster` (free): the gateway refuses it for this team ("requires an active Pro plan with purchased AI
  Gateway credits, or an Enterprise plan"). Enabling it is an account change, which this slice does not make.
- `poolside/laguna-s-2.1-free` (free): the gateway lists `deprecated_at` 2026-10-31, eleven days from now. Not usable in
  production.
- `nvidia/nemotron-3.5-lightning-free`: the same weights as `nvidia/nemotron-3.5-lightning`, which failed H1 in slice 3b
  (pooled −14.0, CI below 0). Its endpoint differs only in price and max output (65k).
- `reflection/beam` (paid id): its `reflection` endpoint is the free one (BF); the other endpoints (Baseten, Nebius,
  Together) are paid and above gpt-6-luna flex on output. BF stands for both.
- `deepseek/deepseek-v4.1-flash` ($0.075 / $0.30, doubled in two weekday peak windows) and `inception/mercury-3` ($0.10 /
  $0.35): above gpt-6-luna flex on both input and output. On the H1 baseline's own tokens (171.6k in, 53.8k out of which
  20.5k reasoning) a zero-reasoning DeepSeek would cost at most 4% less off-peak and twice as much at peak; Mercury 3 costs
  more at any output count. Neither can be a clear saving, so neither is run. `inception/mercury-2.5` (MC) is the cheaper
  Mercury and runs instead.

## Runner and failures

`run3.mts --cand vercel:<model> --out slice10 --cap 3`, two calls in pipeline order, production's prompts byte for byte
(`prompt_sha` extract `68e134fe…`, label `e654eae8…`, the same as the slice 3b baselines), max_tokens 16,000 per call
(clamped to max output), default tier (none of the candidates lists a flex tier). As slice 3b: up to 3 attempts on an
unparseable answer; a truncated answer (`finish_reason` = `length`) fails its chunk with zero records; HTTP 429/5xx are
retried with backoff (4 retries, honouring `retry-after`) and a call that exhausts them fails its chunk. Failed chunks are
never dropped. 429 responses are counted per run (`meta.json` `rate_limited`).

## Step 1: DEV gate (slice 3e/3f's, unchanged)

`eval/sets/score.py extraction` on the run's catalog (9 documents, 12 chunks). Pass: required fetched **≥ 56 of 61** AND in
fetched sources **≥ 83 of 96** AND **at most 1 of 12 chunks failed**. Baseline gpt-6-luna `low` (3b gate rebuild) 59/61,
87/96; reference gpt-6-luna `none` (3c) 56/61, 84/96. Only DEV passers see held-out.

## Step 2: held-out, one look per DEV passer (slice 3b's rule, unchanged)

Baselines: the slice 3b gpt-6-luna `low` two-call runs, `out/slice3b/runs/vercel_openai_gpt-6-luna-two-call-heldout` (H1)
and `…-heldout2` (H2); noise references `out/slice3c/runs/…-heldout-rep2` (H1) and `out/slice3b/runs/…-heldout2-rep2` (H2).

1. **Floor**, each set: H1 (`stats.py compare`, note bootstrap) pooled and macro group recall excluding unsure, and
   breaking-group recall; H2 (`stats3b.py compare`, section bootstrap) required-group recall excluding unsure, and
   breaking-group recall. Each no more than **5 points** below the baseline AND the 95% CI of candidate − baseline not
   entirely below 0.
2. **Precision not down:** precision no more than **10 points** below the baseline on each set (slice 3b's nits gate).
3. Pass = both on H1 AND H2. Ungrounded-quote share is reported, not a gate.

## Step 3: cost (decides adoption among passers)

- **Per run:** the run's provider-reported $ for H1 + H2 (and DEV), against gpt-6-luna flex on the same documents: the
  baseline runs' tokens priced at flex (H1 $0.0239, H2 $0.0241; half the list $ they reported).
- **$/yr at 20,000 technologies:** candidate $ ÷ gpt-6-luna flex $ (H1 + H2 summed) × gpt-6-luna flex's $/technology-year,
  both the slice 3d production replay ($0.0051, $102/yr) and the 3b worst case at flex ($0.0096, $192/yr). A failed or
  truncated chunk is charged as a gpt-6-luna flex fallback call.
- A paid passer is adopted only if cheaper than gpt-6-luna flex by more than the baseline's own H2 run-to-run spread (8%).
  The cheapest passer wins.

## Step 4: free models, load and terms (only for a free model that passes held-out)

- **Terms** (recorded from the gateway's model and endpoint listings): `zdr` and `no_training` flags, the provider's
  retention note. Retention or training use is acceptable: inputs are public release notes and documentation.
- **Load needed:** production made about 37,000 extraction calls in 5 days for about 2,620 technologies (the catalog
  state's members, 20 October 2026). At 20,000 technologies that is about 282,000 calls per 5 days, **≈ 56,000 calls/day,
  ≈ 39 calls/minute** sustained during onboarding; steady state about 2 × 17.5 chunks × 20,000 = 700,000 calls/yr
  (≈ 1,900/day).
- **Rate probe** (free, no held-out text): the 12 DEV extract prompts replayed without cache, 120 calls at concurrency 5
  (production's limit), recording 429s, retry-after, calls/minute achieved and p50/p95 latency.
- **Verdict:** "sustains the load" only if the probe and the held-out runs show at most 1% of calls exhausting retries
  and the probe achieves ≥ 39 calls/minute. A free model that does not is only usable with gpt-6-luna as the fallback
  for 429s and errors, and its saving is then the share it actually serves.

## Step 5: production (only if a candidate passes Steps 2 and 3)

`central/src/pipeline/llm.ts`: the passer becomes the primary extraction model; gpt-6-luna `low` flex stays as the
fallback for HTTP errors, exhausted 429s, truncation and unparseable answers. Unit tests with mocked fetch. Otherwise
the slice is eval only.

## Budget

Vercel spend cap **$3.00** for the slice, from `out/slice10/usage.jsonl` (provider-reported cost; every call refused at
the cap, and a run refused when its worst case exceeds what remains or the live balance minus $1). Dry-run worst cases
are printed before each run. No Jev, OpenAI or Codex spend.

## Known limits

- H1/H2 have been looked at many times since slice 3b; no prompt is changed here, so a model swap is not fitted to them.
- One run per arm; gpt-6-luna's replicate spread (H1 breaking ±3 points, H2 required −3.6; DEV 56–59) is the noise
  reference.
- Free endpoints' limits are not published (the gateway's rate-limit page gives no numbers), so load is measured, once,
  on one afternoon.
