# Slice 3f results: strict structured output for gpt-5-mini, and gpt-5.6-luna on the OpenAI API

18 October 2026. Pre-registration: `PREREG.md`, "Slice 3f". It was committed (4064230) before any 3f model call. Setup under
test: steps A+B through the OpenAI API directly, with production's prompts (same `prompt_sha` as 3b/3e), two calls and
reasoning `low`. The comparison is with gpt-6-luna `low` (slice 3b runs). There was no Vercel, Jev or Codex spend.

## Decision

**No arm passes. Keep `vercel:openai/gpt-6-luna`, `low`, two calls.**

- **gpt-5-mini with strict output (M5s) fails DEV.** Strict output removes the format failures (0 unparseable, 0 failed
  chunks), but recall does not recover: 54/61 required, below 3e's repaired 55.
- **gpt-5.6-luna (L56 plain, L56s strict) passes DEV but fails held-out H2 badly.** Required recall is −45 and −41 points,
  with CIs wholly below 0. On ~30k-character chunks it writes a third to a half of gpt-6-luna's records. Plain L56 also
  misses the H1 breaking margin (−8.6).

## DEV (gate: ≥ 56/61 required fetched, ≥ 83/96 in fetched sources, ≤ 1/12 failed chunks)

| Arm | Required fetched | In fetched sources | Failed chunks | Records | Ungrounded quotes | Unparseable answers | $ DEV (list) | DEV verdict |
|---|---|---|---|---|---|---|---|---|
| gpt-6-luna `low` (3b rebuild, baseline) | 59 | 87 | 0 | — | — | — | — | — |
| gpt-6-luna `none` (3c, reference) | 56 | 84 | 0 | 338 | 4.4% | ~1% | — | — |
| gpt-5-mini + repair (3e M5r, reference) | 55 | 88 | 0 | 304 | 22% | repaired | $0.250 | fail |
| **M5s** gpt-5-mini, strict | **54** | 87 | 0 | 271 | **21.0%** | 0 | $0.185 | **Fail** (−2 groups) |
| **L56** gpt-5.6-luna, plain | **61** | **94** | 0 | 283 | 10.6% | 0 | $0.083 | pass |
| **L56s** gpt-5.6-luna, strict | 58 | 87 | 0 | 311 | 10.3% | 0 | $0.081 | pass |

**What M5s misses** (required, fetched):
- Prisma 7 ships as an ES module;
- the Nest 12 Vitest default (3 groups);
- the custom-webpack build change;
- the React version note;
- the Prisma 7 Node minimum table (2 groups);
- the `--turbopack` default.

These are the same items 3e's M5r and 3c's `none` lost. **The 3e failure was not only format:** with format solved,
gpt-5-mini still under-reads the Next 16 guide and the Prisma 7 notes. Its quotes stay about 21% non-verbatim, the same as
3e. Strict output does not change how it quotes.

## Held-out, one look each (L56, L56s), against gpt-6-luna `low`

The table shows candidate − baseline in points, with the 95% bootstrap CI. H1 uses `stats.py`'s note bootstrap; H2 uses
`stats3b.py`'s section bootstrap. Comparisons are in `out/slice3f/cmp-h{1,2}[-strict].json`.

| | L56 plain | L56s strict | Margin |
|---|---|---|---|
| H1 pooled excl. unsure (66.3) | −3.1 (−7.8…+6.8) | −1.9 (−8.0…+8.5) | ≥ −5 |
| H1 macro excl. unsure (91.9) | +0.6 (−3.4…+4.3) | +1.4 (−1.1…+4.3) | ≥ −5 |
| H1 breaking (82.9, n 35) | **−8.6** (−19.4…0.0) | +2.9 (0.0…+6.5) | ≥ −5 |
| H1 precision (82.0) | −0.2 | +0.3 | ≥ −10 |
| **H2 required excl. unsure (88.7)** | **−44.8 (−64.2…−27.7)** | **−41.2 (−57.6…−27.1)** | ≥ −5 |
| **H2 breaking (86.4)** | **−41.4 (−59.7…−26.3)** | **−38.6 (−54.2…−25.6)** | ≥ −5 |
| H2 precision (84.8) | −0.7 (−10.6…+4.7) | −3.5 (−10.3…+1.2) | ≥ −10 |
| H2 guides required | 28.8 vs 91.3 | 44.2 vs 91.3 | (slice) |
| Records H1 / H2 (baseline 222 / 441) | 209 / 233 | 214 / 257 | — |
| Ungrounded quotes H1 / H2 (baseline 0.9% / 3.4%) | 7.2% / 8.6% | 3.3% / 12.1% | reported, not a gate |
| Failures | 0 failed chunks; 1 label call unparseable after 3 attempts (msw notes) | none | — |
| **Verdict** | **Fail** (H2; H1 breaking margin) | **Fail** (H2) | |

**The H2 loss is under-enumeration on long single chunks,** not a format or parse problem. There was no truncation. Records
per H2 document, against gpt-6-luna:

| Document | gpt-6-luna | L56 | L56s |
|---|---|---|---|
| sveltejs-kit 3.0.0 guide (30k chars) | 120 | 35 | 56 |
| transformers 5.0.0 notes (30k chars) | 87 | 29 | 23 |
| transformers 5.0.0 guide (28k chars) | 59 | 29 | 42 |

Short documents are on par. This matches slice 3b's finding for gpt-5.6-luna through `codex exec` (Luna 5.6 r1: 63.8
required on H2). The API path is worse still. DEV passes because it is sparse: 61 required groups over 9 documents (12
chunks of up to 26k characters), so a model that lists the headline changes hits them. H2 has 221 required groups over 7
documents and rewards exhaustive enumeration of 28–30k-character chunks.

## Tokens per record and the 2.5M/day allowance (`tokens3e.py`, `out/slice3f/tokens.json`)

The method is 3e's worst-case formula on the mean technology (N 6,460, c 17.5, R 114.6), with records scaled against
gpt-6-luna on the same set. The pre-registered figure is the larger of H1/H2 for arms that reached held-out, and DEV for M5s.

| Run | Tokens/record: input (cached) / output (reasoning) | Tokens per technology-year | Tokens/day at 20k | Over 2.5M/day | Excess on gpt-6-luna flex, $/yr | Free technologies with gpt-6-luna's 250k/day too | Remaining on Luna flex, $/yr |
|---|---|---|---|---|---|---|---|
| **M5s**, DEV | 589 (71) / 276 (81) | **78.6k** | 4.31M | 42% | $43–81 | 12.7k | $37–70 |
| L56, DEV | 437 (5) / 172 (19) | 69.8k | 3.83M | 35% | $35–67 | 14.2k | $30–56 |
| **L56**, H1 (larger) | 815 (0) / 236 (90) | **78.8k** | 4.32M | 42% | $43–81 | 12.7k | $37–70 |
| L56, H2 | 441 (33) / 169 (11) | 72.6k | 3.98M | 37% | $38–71 | 13.7k | $32–60 |
| L56s, DEV | 528 (5) / 130 (11) | 67.0k | 3.67M | 32% | $33–61 | 14.7k | $27–50 |
| **L56s**, H1 (larger) | 957 (40) / 182 (59) | **73.3k** | 4.02M | 38% | $39–73 | 13.6k | $33–62 |
| L56s, H2 | 496 (29) / 119 (3) | 61.2k | 3.35M | 25% | $26–49 | 16.0k | $20–38 |
| gpt-6-luna `low`, H1 (reference) | 773 (0) / 242 (92) | 81.0k | 4.44M | 44% | — | — | — |
| gpt-6-luna `low`, H2 (reference) | 259 (7) / 155 (7) | 71.1k | 3.89M | 36% | — | — | — |

The $ ranges use gpt-6-luna flex for whatever is not free: the low end is slice 3d's replay ($0.0051 per
technology-year, $102/yr at 20k), the high end 3b's worst case at flex ($0.0096, $192/yr).

The combined headroom counts as free:
- 2.5M × 365 / the arm's tokens per technology-year;
- plus 250k × 365 / 81.0k, about 1.1k technologies, on gpt-6-luna's own complimentary group (a separate quota).

- **The token figures are hypothetical, since no arm passed.** They show what a passing small model would be worth: A+B
  free for about 12–15k of 20k technologies, about $30–70/yr instead of $102–192/yr.
- **The input floor binds.** About 53k input tokens per technology-year (notes read twice, extract output re-read,
  fixed prompts) is 2.9M/day at 20k, above 2.5M before any output.
- **The strict schemas cost input.** Input per record is 12–21% higher in the strict arms than in plain L56 on the same
  set; OpenAI counts the schema. Output per record is 20–30% lower, because the JSON is compact. The net is roughly even.
- **L56's H2 tokens per technology-year are flattered by under-extraction.** Records scale 0.53 and 0.58 of
  gpt-6-luna's, and fewer records cost fewer tokens.

## Spend

| | |
|---|---|
| OpenAI, this slice | **$0.682 of the $4.00 cap** (`out/slice3f/usage.jsonl`, Standard list price) |
| ↳ M5s (smoke + DEV) | $0.200 (its own limit $2.50) |
| ↳ L56 (smoke, DEV, H1, H2) | $0.006 + $0.083 + $0.093 + $0.066 = $0.248 |
| ↳ L56s (smoke, DEV, H1, H2) | $0.005 + $0.081 + $0.086 + $0.061 = $0.233 |
| Vercel, Jev, Codex | $0 |

All three arms' models are in the complimentary group (gpt-5.6-luna as the relayed help article says), so the billed
amount may be $0. No call was refused.

## Caveats

- **DEV did not predict H2 for gpt-5.6-luna** (61/61 on DEV, −45 on H2). DEV holds about 7 required groups per document,
  H2 about 32, so DEV cannot see a model that lists only the headline changes of a long document. Records per chunk
  against gpt-6-luna on DEV's long documents would have flagged it; that is a suggestion, not part of this slice's rule.
- **This is another look at H1/H2.** Prompts were not tuned, and the H2 failure is far outside the replicate spread
  (−3.6).
- **The help article listing gpt-5.6-luna in the 2.5M group** (help.openai.com/en/articles/10306912) refused automated
  fetches. The group membership is as relayed, not checked here. The list price is from the OpenAI pricing page.
- **Same scorer limits as 3e:** credit is matched by quote. The H2 losses are missing records, not paraphrased quotes
  (record counts fall by half).
- **One run per arm,** Standard tier, reasoning `low`. A higher effort or smaller chunks for gpt-5.6-luna were not
  tried; smaller chunks would change production's chunker, not just the model.

## Files

- `PREREG.md` § "Slice 3f".
- `run3.mts`: `--strict` adds strict structured output to both two-call answers:
  - the extract schema is `{records: [...]}`, unwrapped by the parser;
  - the label schema is keyed `r1`…`rN`;
  - null prerequisite bounds are dropped;
  - also adds `gpt-5.6-luna` at reasoning `low`.
- `tokens3e.py`: writes `tokens.json` beside the runs and adds the combined free headroom.
- `prices.json`: gpt-5.6-luna on the OpenAI API ($0.20 / $0.02 / $1.20 per M, flex half).
- Runs: `eval/select/out/slice3f/runs/*`, `usage.jsonl`, `tokens.json`, `cmp-*.json` (not committed; `out/` is ignored).
