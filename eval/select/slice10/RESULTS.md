# Slice 10 results: free and cheap gateway models for extraction (steps A+B)

20 October 2026. Pre-registration: `PREREG.md` (committed and pushed, 6a7a35b, before any DEV or held-out output).
Runner `slice3/run3.mts --out slice10 --cap 3`, production's prompts unchanged (`prompt_sha` extract `68e134fe…`, label
`e654eae8…`), two calls.

## Decision

**No candidate passes. Keep `vercel:openai/gpt-6-luna`, `low`, two calls, flex.** Nothing in `central/src` changes.

- Four of five candidates fail the DEV gate. MiniMax M3.1 Flash and Beam (both free) come closest: 55/61 and 54/61 required,
  against a gate of 56.
- Mercury 2.5 passes DEV exactly at the gate (56/61, 83/96). It then fails both held-out sets by wide margins:
  H1 pooled −18.2, H2 required −38.9, with every CI wholly below 0. It also fails the H2 precision gate (−13.3).
- No free model reached held-out, so the load probe (Step 4) did not run. Its terms and observed rates are recorded below.

## DEV (gate: required fetched ≥ 56/61, in fetched sources ≥ 83/96, ≤ 1/12 failed chunks)

| Arm | Reasoning | Required fetched | In fetched sources | Failed chunks | Records | Ungrounded quotes | $ DEV (provider) | Wall | 429s | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| gpt-6-luna `low` (3b rebuild, baseline) | low | 59 | 87 | 0 | — | 2.2% | — | — | — | incumbent |
| gpt-6-luna `none` (3c, reference) | none | 56 | 84 | 0 | 338 | 4.4% | $0.040 list, ≈ $0.020 flex | — | — | — |
| **MM** minimax-m3.1-flash (free) | low | **55** | 86 | 0 | 441 | 6.8% | $0 | 237 s | 0 | **fail** (−1 group) |
| **BF** reflection/beam-free (free) | low | **54** | 83 | 0 | 191 | 6.3% | $0 | 36 s | 0 | **fail** |
| **LG** inclusionai/ling-3.0-flash | default (on) | **4** | **5** | **8** (truncated) | 32 | 25% | $0.012 | 160 s | 0 | **fail** |
| **MC** inception/mercury-2.5 | low | 56 | 83 | 0 | 236 | 17.8% | $0.013 | 29 s | 0 | pass (at the gate) |
| **MN** mistral/mistral-nemo | n/a | **44** | **70** | 0 (2 unparseable, retried) | 111 | 66% | $0.005 | 390 s | 0 | **fail** |

- **MM and BF** both miss Prisma 7's ES-module change. MM also misses the client import change and Next 16's custom-webpack
  build. BF misses `revalidateTag`'s new argument.
- **LG** reasons without bound: 163k reasoning tokens in 16 calls. Eight of twelve extract calls ran out of the 16,000 cap.
- **MN** quotes are mostly not verbatim (66%).

## Held-out, one look (MC only), against gpt-6-luna `low`

| Metric (baseline) | Mercury 2.5 − baseline, 95% CI | Margin |
|---|---|---|
| H1 pooled excl. unsure (66.3) | **−18.2** (−25.6…−5.9) | ≥ −5 |
| H1 macro excl. unsure (91.9) | **−31.5** (−46.4…−16.7) | ≥ −5 |
| H1 breaking (82.9, n 35) | **−31.4** (−48.0…−22.5) | ≥ −5 |
| H1 precision (82.0) | −2.1 | ≥ −10 |
| H2 required excl. unsure (88.7) | **−38.9** (−56.3…−24.4) | ≥ −5 |
| H2 breaking (86.4) | **−36.8** (−52.2…−23.6) | ≥ −5 |
| H2 precision (84.8) | **−13.3** (−24.4…−6.3) | ≥ −10 |
| Records H1 / H2 (baseline 222 / 441) | 159 / 281 | — |
| Ungrounded H1 / H2 (baseline 0.9% / 3.4%) | 12% / 22% | reported |

**Verdict: fail on both sets.** It under-enumerates, like every small model since slice 3. The losses are largest on guides
(−42.0).

## Cost per run against gpt-6-luna flex

gpt-6-luna flex is the baseline runs' tokens at flex: H1 $0.0239 and H2 $0.0241, $0.048 together.

| Arm | DEV | H1 | H2 | H1+H2 vs Luna flex | $/yr at 20k technologies if it had passed (replay / worst case) |
|---|---|---|---|---|---|
| gpt-6-luna flex | ≈ $0.020 (`none`; `low` is higher) | $0.0239 | $0.0241 | 1.00 | **$102 / $192** (incumbent) |
| Mercury 2.5 | $0.0127 | $0.0157 | $0.0124 | 0.59 | $60 / $112. Moot: it fails held-out. |
| Ling 3.0 Flash | $0.0122 (8 chunks truncated) | — | — | — | — |
| Mistral Nemo | $0.0046 | — | — | — | — |
| MiniMax M3.1 Flash, Beam (free) | $0 | — | — | — | $0 for the share served. Moot: both fail DEV. |

Slice spend: **$0.058** of the $3.00 cap, from `out/slice10/usage.jsonl`. About $0.0001 more went on one-word probes.

## Free models: terms and load (descriptive; Step 4 did not trigger)

| Model | Terms (gateway listing) | Observed (DEV, concurrency 4) | Sustains ≈ 39 calls/min at 20k technologies? |
|---|---|---|---|
| minimax/minimax-m3.1-flash | `zdr` none, `no_training` none (retention and training possible) | 0 × 429; ~75 tokens/s per stream; 24 calls in 237 s (≈ 6/min) | **Not shown.** About 52 s per extract call at 75 tokens/s means it would need ~35 concurrent streams. The limits are unpublished. It would need a gpt-6-luna fallback. |
| reflection/beam-free | `zdr` none, `no_training` none | 0 × 429; 24 calls in 36 s | **Not shown.** A burst of 24 is no evidence for 56k calls a day. It would need a gpt-6-luna fallback. |
| stealth/glyph-cluster | "prompts and outputs may be retained" | refused: needs a Pro plan with purchased credits (an account change) | not run |
| poolside/laguna-s-2.1-free | `zdr` none, `no_training` none | `deprecated_at` 2026-10-31 | not run |
| nvidia/nemotron-3.5-lightning-free | provider may retain for model improvement | same weights as the rejected paid model | not run |

The gateway's rate-limit page publishes no per-model numbers. It says the paid tier has no gateway limits and that a 429
may come from the upstream provider. Free endpoints are provider-subsidised, so their ceilings are the providers'.

Production load: about 37,000 extraction calls in 5 days for about 2,620 technologies. At 20,000 technologies that is
about 56,000 calls a day during onboarding (≈ 39 a minute) and about 700,000 calls a year at steady state.

## Rejected without a run (price; PREREG.md)

- `deepseek/deepseek-v4.1-flash` ($0.075 / $0.30, ×2 at peak) and `inception/mercury-3` ($0.10 / $0.35) are above
  gpt-6-luna flex on input and output.
- `reflection/beam`'s paid endpoints are above it on output.

## Files

`run3.mts` gained the five arms' reasoning settings and a 429 counter (`rate_limited`). `prices.json` was refreshed from
the gateway on 20 October 2026. The runs are in `out/slice10/runs/` and the H2 comparison is in
`out/slice10/cmp-h2-mercury.json` (gitignored).
