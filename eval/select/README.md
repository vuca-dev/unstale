# Model selection: slice 1 (infrastructure)

Tools for choosing the cheapest adequate model per central step. No
scorer here makes a model call. The runner calls a model only without `--dry-run`, and only after the budget guard has
passed. Everything it writes goes under `out/`, which is gitignored. `.store` is only read.

| File | What it is |
|---|---|
| `client.ts` | One OpenAI-compatible chat-completions client. Providers: `vercel` (AI Gateway), `cloudflare` (Workers AI), `openai` (disabled unless `--allow-openai`). It retries 429, 5xx and network errors with backoff, honours `Retry-After`, and has a timeout and a concurrency limit. The disk cache is keyed by sha256(provider + model + full body), and only answers that parse are cached. Each real call writes one line to `out/usage.jsonl` with input, cached input, output and reasoning tokens and dollars. Dollars come from the provider's reported cost when the response has one, otherwise from `prices.json`. An unknown price is logged as `null`. |
| `jev.ts` | Classifier candidates behind the pipeline's own `Classifier` interface. **Jev** is the pipeline's `Jev` class (its HTTP, batching and answer checks), with a fetch that copies each response's usage into the same log. A **chat model** gets the pipeline's chat-fallback prompt and parser (`ChatClassifier`, choices only), run through `ChatClient`. |
| `subq.ts` | **SubQ Snap** (`subq-snap-preview`) as a classifier candidate: Jev's request, batching and answer checks at SubQ's systemone endpoint, key in `~/.config/ati/subq.env` (`SUBQ_API_KEY`). Eval only; results in `slice4/RESULTS.md` and `slice5/RESULTS-judge2.md`. |
| `budget.ts` | The budget guard, gateway balance (`GET /v1/credits`) and cumulative spend per provider from `usage.jsonl`. |
| `prices.json`, `prices.mts` | $ per million tokens, each row with `source` and `checked`. The gateway rows (317 models, plus `max_output`) come from `GET https://ai-gateway.vercel.sh/v1/models`; refresh them with `npx tsx ../eval/select/prices.mts`. Hand rows: DeepInfra gpt-oss-20b, Gemini 3.1 Flash-Lite batch, Jev, SubQ Snap, Decisions `gpt-6-luna`, Cloudflare Clef Flash (input only; the output price and model id are TODO). The OpenAI direct rows are TODO (null). `codex/gpt-5.6-luna` is the gateway's list price for `openai/gpt-5.6-luna` ($0.20 / $0.02 cached / $1.20). |
| `prompts.ts` | `ONE_CALL_PROMPT`: `EXTRACT_PROMPT` with the five label fields and `LABEL_PROMPT`'s rules folded in. It is assembled from the pipeline's prompts at load time and throws if a marker moves. |
| `states.ts` | Rebuilds the sets' classifier and judge requests from stored data and proves they are faithful (below). |
| `run.mts` | The runner. |
| `cost.mts` | Worst-case cost per step, with N, c, R and S measured on the store. |
| `splits.json` | Dev and held-out per set, with flags. |
| `client.test.ts` | Mocked-fetch tests: `cd central && npx vitest run --root ../eval/select`. Typecheck: `npx tsc --noEmit -p ../eval/select/tsconfig.json`. |

## Running a step

```
cd central
npx tsx ../eval/select/run.mts --step extract  --provider vercel --model openai/gpt-oss-20b [--structure one-call] --split dev --dry-run
npx tsx ../eval/select/run.mts --step classify --provider jev --split dev [--set benefit|breaking] --limit 50 --seed 1
npx tsx ../eval/select/slice5/judge2.mts --arm M8 --split dev|heldout --cand jev|subq   # step E: slice 5's frozen requests
npx tsx ../eval/select/run.mts --step classify --provider cache --split all     # the pipeline's own answers, no calls
```

- **Providers:**
  - `vercel`, `cloudflare`: chat completions.
  - `openai`: only with `--allow-openai`.
  - `jev`, `subq`: classify only (`run.mts --step judge` stops since f99833e; see below).
  - `codex`: Luna (`gpt-5.6-luna`) through the pipeline's `runCodex` on the user's plan. It reads the store's Codex cache first (read only), then `out/central/cache/codex`. Its usage lines hold the harness-inclusive tokens, plus `prompt_chars` and `prompt_tokens_est` (prompt characters / 4; no tokenizer is installed). They also hold `dollars_prompt_only`, so Luna can be costed at list price without the harness.
  - `cache`: replays the pipeline's stored answers.
- **`--dry-run`** prints the documents or requests, the number of calls, and a worst-case token and dollar figure, without calling anything. Worst case means input is characters / 3 at the uncached rate, and output is the request's `max_tokens` (extract 16k, label 16k, one call 24k, classify 2k, judge 2k, clamped to the model's `max_output`). The figure is also shown ×3, in case every call is retried for an unparseable answer.
- **Budget guard:** a real run is refused when its worst case ×3 exceeds what remains, and when the worst case is unknown because a price is missing.
  - `vercel`: the live gateway balance minus a $1 reserve.
  - `openai`: $2 minus logged OpenAI spend.
  - `jev`, `subq` and `cloudflare`: an explicit `--budget`.
  - `codex`: no dollar budget (it bills the plan).

  Cumulative spend per provider is printed after every run.
- **`--limit N --seed S`** takes a fixed-seed sample (order by sha256(seed:id)).
- **Outputs** go to `out/runs/<run-id>/`, and the existing scorers are run on them:
  - extract: `incoming.json` and `catalog/` (`score.py extraction`).
  - classify: `benefit-labels.json` and `breaking-labels.json` (`score.py benefit|breaking`), plus raw `answers.json`, which holds every probability for re-fitting thresholds on dev.
  - judge: `judge.json` and `guides-pairs.json` (`rule_eval.py`).

## Extraction (A, A+B)

- **Inputs:** the 9 documents that the extraction-recall items cite in fetched sources, read from `.store/central/releases` (cleaned as `fetch.ts` does) and `.store/central/guides`. Each is split with the pipeline's `chunk()`.
- **Two-call** is `extractRelease` itself: `EXTRACT_PROMPT`, then `LABEL_PROMPT` over the record briefs and the same notes, with `toIncoming` post-processing. **One-call** uses `ONE_CALL_PROMPT`.
- **Proof the prompts are the pipeline's:** the rendered extraction prompts hit the pipeline's Codex cache (6 of 6 checked). The runner's `cache` output reproduces the published score:

  | | Score |
  |---|---|
  | ALL | 96/100 |
  | Fetched sources | 96/96 |
  | Required, fetched | 61/61 |
  | DEV | 74/74 |
  | HELD-OUT | 22/26 (fetched 22/22) |

  Restricting to the 9 cited documents loses no hit.
- Extraction-set "splits" are events, not documents. The same 9 documents serve dev and held-out items (see `splits.json`).

## Faithful requests for D and E

**Since f99833e (16 October 2026)** the pipeline asks shorter label and judge text than the stores were built with.
Label faithfulness is proven against the build-time wording (`states.ts` `buildTimeLabelQuestions`; the states did not
change), and a run asks the current `labelQuestions()`. Judge pairs no longer rebuild: `ingest` now asks `shortRules`
and merges at `SAME_P_SHORT`, so `run.mts --step judge` stops. Step E is compared on the requests slice 5 froze while
they were faithful (`out/slice5/units.json`), with `slice5/judge2.mts` (any wording arm, `--cand jev|clef|subq`) and
`slice5/score5.mts`. The table below is as of 16 October 2026, before the change.

A rebuilt request counts only if it is byte-identical to one the pipeline asked. That is proven by a hit in the
pipeline's classifier cache, which is keyed by sha256 of the full request. For judge pairs, the cached answer must also
reproduce the p the audit recorded. Everything else is listed by the runner as not reconstructable and left out. It is
never approximated.

| Set | Source of the state | Faithful | Not reconstructable |
|---|---|---|---|
| Benefit (150 records) | One `recordState` per source extraction in `central-trust` (the catalog the set was drawn from). A record's label is the union of its sources' benefits (`combine`). | 170 of 170 requests | 0 |
| Breaking (241 of 251) | **Synthesised, not reconstructed.** These are Slice 2 records that never went through this pipeline. `recordState` is filled from the item: key → subject, evidence → quote. Facet, section, introduces and replaces are empty because the items do not have them. The published 89.6% (Jev) used the hill-climb's P0 state (no introduces/replaces, breaking asked alone), so runs on these units must be compared with each other, not with 89.6%. | 0 (none exist) | n/a |
| Within-source (83) | A replay of the ingest loop (`pipeline.ts` order) from an empty store over `central-v1` (the first full run), every answer from its cache: 494 of 494 judge requests hit. | 72 | 11. The request is in the cache but the cached p differs from the audit's: Jev answered the same request differently in a later run, 5 of them across `SAME_P` (0.96→0, 0.84→0.60, 0.86→0.40, 0.76→0.49, 0.73→0.68). |
| Guides vs notes (104) | `retrieve` over `central-pre-rematch` plus `matchRequest`, as `eval/guides/audit.mts` did. Guide extractions and labels come from the current store's cache. | 94 | 10. Rebuilt request not in either cache (3 NestJS, 3 Next.js, 4 Prisma). |
| Nuxt held-out (211 pairs) | A replay from empty over `central-trust-nuxt` | 211 | 0 |

The judge summary is ingest's own decision under the run's answers: `pick` (judge at `SAME_P`, then the guards) on the
candidate records as they stood when the request was asked. It uses the working tree's guards. For the guides set, the
published method is `rule_eval.py` (`CROSS_SAME_P`, and an item's guide never merges twice), which the runner also
runs.

## Reproduced numbers (no model calls, 16 October 2026)

| Scorer | Documented | Reproduced |
|---|---|---|
| `score.py extraction` on `.store/catalog` | 96/100, fetched 96/96 | **96/100, fetched 96/96, required 61/61** (and through the runner's `cache` output) |
| `score.py benefit` on `.store/catalog` (current) | 79.3% identical, 86.0% benefit-vs-none | **Does not reproduce: 147 of 150 records, 81.0% / 85.7%.** `next:ssg`, `next:response-bodies` and `next:server-actions~5` are no longer active in the current catalog, and the scorer silently scores the rest. |
| `score.py benefit` on `catalog-trust`, `catalog-v2`, `catalog-requires` (the set's own era) | same | **150/150, 79.3%, 86.0%** (and through the runner from the classifier cache) |
| `score.py breaking`, the hill-climb's stored P0 labels | Jev 89.6%, Luna 92.5%, Codex 95.4% | **89.6% (5 FB / 20 MB), 92.5% (8 / 10), 95.4% (8 / 3)**. P4-Jev 95.4%. The labels came from another session's scratch directory under /private/tmp and are copied to `out/reference-labels/` (gitignored). |
| Nuxt held-out (`table.py`: 168 merges, 0.6 false per 100) | 168, 0.6 | **168 merges (166 SAME, 2 UNSURE), 0.6 per 100** through the runner (`cache`) |
| Guides `rule_eval.py` at 0.85 | 74 merges: 53 dev (0 false), 21 Next.js (1 D, 2 U) | All 104 pairs: same. Faithful 94: 66 merges (48 dev, 0 false; 18 Next.js, 1 D, 1 U) |
| Within-source (83) | 62 SAME, 15 DIFFERENT, 6 UNSURE, all merged by the first run | Faithful 72 under today's guards: 57 merged (56 SAME, 1 UNSURE), 0.9 false per 100 |

## Split policy

`splits.json` assigns dev and held-out per set from what each set documents, and flags where a set falls short of
technology-disjoint:

- **No set has a PyPI technology.**
- **Benefit** and **within-source** are all dev.
- **Breaking:** Laravel is assigned held-out here (85 items, Composer, in no other set). P4 was written from errors on all 241, so its numbers are in-sample.
- **Extraction and the gate** split by event. Next.js, Prisma and NestJS are on both sides, and so are the documents.
- **Step E:** Next.js is held out in the guides set but is 71 of the 83 within-source dev cases.

Thresholds (`BREAKING_P`, `BENEFIT_P`, `SAME_P`, `CROSS_SAME_P`) are the pipeline's. The runner saves raw probabilities
so they can be re-fitted on dev per candidate.

## Cost model (`cost.mts`)

| Step | Input per technology-year | Output |
|---|---|---|
| A | O(N + c·P_A) | R·o_A |
| B | O(N + R·o_A + c·P_B) | R·o_B |
| A+B, one call | O(N + c·P_1) | R·(o_A + o_B) |
| D | O(R·S_D) | R·o_D |
| E | O(R·K·S_E), K = 8 | R·K·o_E |

Tokens are characters / 4. Reasoning tokens are not bounded by the model; they are measured per run.

Measured on `.store/central`:

| Quantity | Mean | Max |
|---|---|---|
| N (notes tokens per technology-year) | 6.5k | 204k |
| c (chunks) | 17.5 | 531 |
| R (incoming records) | 115 | 1,092 |

- **Prompts:** P_A 0.6k, P_B 0.9k, P_1 1.5k.
- **States:** S_D 1.9k per request (mostly the 8 questions' instructions, repeated per record). An E request with 8 candidates is 2.8k.

Run it for $ per technology-year and at 10k / 50k / 200k technologies per priced model.

## Gaps (sets to build)

- **Extraction precision:** real developer-facing changes per 100 records. Recall alone rewards over-extraction.
- **change_type:** recall on removal and deprecation.
- **requires** (and replaces) precision.
- **A held-out benefit technology:** the benefit set is next, prisma and nestjs only.
- **A PyPI held-out technology** for every set: extraction, benefit, breaking, and the judge.
- **Judge recall beyond Jev:** the guides and Nuxt pairs exist only where Jev said p ≥ 0.5.
- **States for breaking:** a pipeline-native breaking set (records extracted by this pipeline, so states are faithful).
