# Slice 3c results: cutting the cost of the settled extraction setup

16 October 2026. Pre-registration: `PREREG.md`, "Slice 3c" and its amendments, each written before the runs it governs.
Setup under test: steps A+B on `openai/gpt-6-luna`, reasoning `low`, two calls ($0.0192 per mean technology-year; slice
3b). Baselines: slice 3b's runs on H1 (40 short notes) and H2 (7 guides and major notes), re-scored unchanged.

## Decision

**Keep the slice 3b configuration (`vercel:openai/gpt-6-luna`, `low`, two calls, verbatim quotes, pretty-printed JSON).**
Of six variants, one passes the pre-registered rule (reasoning `none`). It is not recommended: its saving falls almost
entirely on short notes, and on the extraction set it loses five required migrations from upgrade guides. One variant
raises recall at a cost (the `lists` prompt). It is shown as a trade-off, since its gain does not clear the pre-registered
bar. Every new variant is env-gated in `extract.ts`/`llm.ts`; the defaults are byte-for-byte unchanged (prompt hashes
equal slice 3b's).

| # | Variant | A+B cost vs baseline | H1 floor (pooled / macro / breaking) | H2 floor (required / breaking) | Precision H1 / H2 | Verdict |
|---|---|---|---|---|---|---|
| 1 | Evidence by unit id (`UNSTALE_EXTRACT_EVIDENCE=ids`) | −3.8% (not shown: under the 8% spread) | +1.2 / **−5.6** / **−8.6** | −0.9 / −0.4 | +2.0 / +3.6 | **Fail** (H1 margin) |
| 2 | One call, strict schema, records first (`UNSTALE_EXTRACT_STRUCTURE=one-call-schema`) | **−34%** | +2.7 / +0.2 / **−5.7** | −4.1 / −2.5 | +1.0 / +1.4 | **Fail** by the letter (H1 breaking); guides −14.0 (CI −20.6…−7.9) |
| 3 | Reasoning `none` (`UNSTALE_EXTRACT_EFFORT=none`) | −12% (H1 −23%, H2 −1%) | −3.9 / −2.6 / 0.0 | 0.0 / 0.0 | −0.9 / −0.4 | **Passes**; not recommended (below) |
| 4 | Output diet: drop unread `change_type`/`surface` and compact JSON (`UNSTALE_EXTRACT_DIET=1`), at `none` | −22% vs `none` | **−6.6** (CI −9.3…−2.7) / **−5.5** / −8.6 | **−6.8** (CI −14.2…−0.7) / −5.0 | −0.1 / +0.6 | **Fail** |
| 4b | Compact JSON only, all fields kept (`UNSTALE_EXTRACT_DIET=compact`) | −11% | −2.3 / −2.3 / −2.9 | **−5.9** (CI −14.2…0.0) / −4.6 | +0.1 / −4.8 | **Fail** (H2 margin); guides −14.5 (CI −23.6…−6.7) |
| 5 | Recall: `lists` paragraph (`addenda.ts`) | +10% A+B; +14% with D+E (records +18%) | +3.9 / **+1.5** (CI +0.2…+3.0) / +14.3 (CI 0.0…+22.4) | +3.6 (CI −2.9…+9.2) / +4.3; major notes +5.4 (CI +2.3…+9.2) | **−8.4 / −7.7** | **Not adopted** (required CI not above 0); trade-off |

Bold marks a floor metric outside the 5-point margin or a CI wholly below 0. **Noise reference:** an H1 replicate of the
baseline moves pooled +1.2, macro −0.3 and breaking +2.9, with 7 of 35 breaking groups flipping between identical runs.
The slice 3b H2 replicate moves required −3.6. Each variant's H1 breaking result therefore rests on 2–5 net groups.

## 1. Evidence by unit id

**Measured first (free):** in the baseline's extract answers, the verbatim `evidence` quote is 23% of the characters. The
summary is another 23%, the unread `change_type`/`surface` 12%, and indentation 12.5%.

- **Design:** units are lines, or sentences of a line over 240 characters. The record names 1–3 unit numbers.
  - Amended at the smoke: the model ignored a range cap and returned ranges of up to 22 lines.
  - Quotes are rebuilt deterministically, so 0 are ungrounded by construction.
- **Saving is small.** Extract output fell 11%, but numbering adds 9% input, so the net is −3.8% (H1 + H2). Evidence is
  only part of extract output, and extract output only part of the bill.
- **H1 fails.** Macro is −5.6 and breaking −8.6 (CIs cross 0). Two causes:
  - The model answered `[]` for a one-line uvicorn note it had extracted before.
  - It named non-adjacent sentences (`[5, 7]`), whose joined text matches no reference anchor.
  - A post hoc rebuild using contiguous spans (no model calls) was worse on H2 (required −6.8), so recall here depends
    on how quotes are built. The scorer matches by quote containment, and rebuilt quotes are 75–125% longer.
- **Downstream cost moves the wrong way.** Mean quote length on H1 rose from 81 to 182 characters, which grows the state
  that D and E read.

## 2. One call with a strict schema, records first

`response_format: json_schema` (strict) with `{records: [...], labels: [{id, ...}]}`. The gateway accepts it for
gpt-6-luna. There were no unparseable or truncated answers, and every record got its labels.

- **Cost −34%:** $0.0126 against $0.0192 per technology-year, about −$66 per 10k technologies.
- **H2 passes the floor:** required −4.1 (CI −13.5…+2.8), records 58 per document against 63. Compared with the earlier
  labels-inline one call (−19.5), the records-first schema recovers most of the loss.
- **But guides lose 14.0 points (significant).** H1 breaking is −5.7 against the 5-point margin: 2 net groups of 35,
  inside the replicate's spread. By the letter it fails.
- **Label fields shift** (unscored): `conditions` on H1 records rise from 3 to 20.

## 3. Reasoning `none`

Both `none` (0 reasoning tokens) and `minimal` are accepted. `none` ran first, as amended before any run.

- **Held-out:** passes both sets (H2 0.0 / 0.0; H1 −3.9 / −2.6 / 0.0). Precision is unchanged. About 1% of answers are
  unparseable and retried; the cost includes the retries.
- **Cost:** −12% overall, but −23% on H1 and −1% on H2. gpt-6-luna at `low` barely reasons on long chunks (3k reasoning
  tokens on all of H2). The worst case (the largest technology, long documents) is essentially unchanged.
- **Gate rebuild** (`.store/slice3c-none`, through the production switch `UNSTALE_EXTRACT_MODEL` /
  `UNSTALE_EXTRACT_EFFORT`, 287 calls, $0.17, 1 failed nestjs chunk):

| | gpt-6-luna `low` (3b) | gpt-6-luna `none` |
|---|---|---|
| Extraction set required fetched (of 61) | 59 | **54** |
| Gate DEV required covered / in queue / first 16 (of 72) | 49 / 45 / 35 | 53 / 45 / 32 |
| Gate HELD-OUT required covered / in queue / first 16 (of 22) | 11 / 11 / 7 | 11 / 11 / 7 |

- **Seven items only `none` misses** (net −5 required), mostly Next.js 16 upgrade-guide migrations:
  - `revalidateTag`'s new required argument (two events);
  - the custom-webpack build change;
  - the `--turbopack` default;
  - the React version note;
  - Prisma 7's Node minimum table (two items).
  `low` misses one item that `none` covers.
- **Recommendation: do not adopt.** It saves about $23 per 10k technologies on the mean technology and nothing in the
  worst case, and it loses guide migrations, the recall that matters most. That is the same loss H2's guides show
  (−7.3, CI −18.9…+3.9).

## 4 and 4b. Output diet

**Measured first (free):**
- `change_type` and `surface` become `hint_change_type`/`hint_surface`, which no code reads; the classifier labels both.
- Summaries average 12 words (cap 40), so a shorter cap was not tested.

**Results:**
- **Dropping the hint fields and writing compact JSON fails clearly on both sets,** with 7–11% fewer records.
- **Compact JSON alone also fails.** H2 required is −5.9 and guides −14.5 (significant).
- **The schema one call also emits compact JSON and also loses about 14 points on guides.** On gpt-6-luna,
  pretty-printed output goes with fuller enumeration of long documents. The categorising fields are not dead weight
  either: removing them cost recall even though nothing reads them.

The D check (Jev on the variant's records) was not run, because the variant failed the floor first.

## 5. Recall hill-climb

**Free analysis:** no required-sure group is missed on H1. Its 87 sure misses are mostly fixes in zod's long notes, which
the prompt skips by design and which are not targeted, because recovering them raises R. On H2 there are 25 required-sure
misses, mostly removals and raised minimum versions in long lists (transformers notes 10, kit guide 5, mypy notes 3).

- **DEV** (9 documents, both arms at `none`): required fetched 56 → 57 of 61, records +6%, so the arm went on to held-out.
- **One look, at `low`:** every recall metric rises.
  - H1 macro +1.5 (significant) and breaking +14.3 (5 groups gained, 0 lost).
  - H2 major notes +5.4 (significant) and breaking +4.3.
  - H2 required +3.6, with a CI (−2.9…+9.2) that does not clear 0, so it is not adopted by the rule.
- **The cost is precision and records:** precision −8.4 (H1) and −7.7 (H2), records +18%. A+B costs +10%; with D and E
  scaling by records, the total is about $0.0504 against $0.0441 per technology-year (+14%, about +$63 per 10k).
- **If recall is valued over cost,** this is the next candidate. A second held-out set, or a larger H2, would be needed
  to certify it.

## Spend

| | |
|---|---|
| Gateway, slice runs | $0.649 (694 calls) |
| Gateway, gate rebuild | $0.172 (287 calls) |
| **Gateway total** | **$0.82 of the $3.50 cap** |
| Jev (rebuild) | 5.28M input, about $0.22 of $0.40 |
| Codex (gate match calls) | plan |

## Caveats

- **Seven looks at H1/H2 in this slice.** Each variant was pre-registered before its run, but the sets are no longer fresh
  for prompt work.
- **Small samples.** H1 breaking has 35 groups, and identical runs flip 7 of them. H2 is 7 documents.
- **The scorer matches by quote.** Variants that change how quotes are built (1, 2) are partly measured through that.
- **Label fields are unscored** on H1/H2, so the `conditions` shifts (2, 5) are unjudged.
- **The gate is not technology-disjoint,** and it was rebuilt only for the one variant that passed.

## Files

- **Code (env-gated, defaults unchanged):**
  - `central/src/pipeline/extract.ts`: `EXTRACT_PROMPT_IDS`, `numberUnits`, `unitQuote`, `parseIdsAnswer`,
    `SCHEMA_PROMPT`, `SCHEMA_RESPONSE_FORMAT`, `parseSchemaAnswer`, `dietPrompt`, and the `extractEvidence`,
    `extractStructure` and `extractDiet` switches.
  - `central/src/pipeline/llm.ts`: `extractLlm` takes `responseFormat` and `maxTokens`.
  - Tests: `central/test/extract-variants.test.ts`.
- **Runner:** `run3.mts` gains `--evidence`, `--structure one-call-schema`, `--diet full|compact` and `--addendum`.
- **Helpers:** `addenda.ts`, and `dcheck.mts` (the D check, unused).
- **Runs:** `eval/select/out/slice3c/` (runs, `usage.jsonl`, `cmp-h2-*.json`).
- **Gate:** `.store/slice3c-none` (+ `-catalog`), `eval/gate/results/slice3c-gpt-6-luna-none.*`.
