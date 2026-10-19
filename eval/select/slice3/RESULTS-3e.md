# Slice 3e results: OpenAI small models on the free data-sharing allowance

18 October 2026. Pre-registration: `PREREG.md`, "Slice 3e" and its two amendments. Each was committed before the runs it
governs. Setup under test: steps A+B on OpenAI models that the org's complimentary allowance covers (2.5M tokens/day,
shared). The runs called the OpenAI API directly through central's `openai` provider. Production's prompts were unchanged
(same `prompt_sha` as slice 3b), with two calls and reasoning `low`. The comparison is with gpt-6-luna `low` (slice 3b).

## Decision

**No arm passes. Keep `vercel:openai/gpt-6-luna`, `low`, two calls.** All three arms failed the pre-registered DEV
gate, so none was run on held-out (H1/H2 were not looked at in this slice), and nano did not run.

| Arm | DEV required fetched (gate ≥ 56/61) | DEV in fetched sources (gate ≥ 83/96) | Failed chunks (gate ≤ 1/12) | Records | Ungrounded quotes | Tokens/record (in + out; reasoning) | $ DEV (list) | Verdict |
|---|---|---|---|---|---|---|---|---|
| gpt-6-luna `low` (baseline, 3b rebuild) | 59 | 87 | 0 | — | 2.2% (rebuild) | 1,015 H1 / 414 H2 (92 / 7) | — | incumbent |
| gpt-6-luna `none` (3c, reference) | 56 | 84 | 0 | 338 | 4.4% | 542 (0) | $0.040 (gateway) | passed H1/H2 in 3c |
| **M54** `gpt-5.4-mini` low | **42** | **61** | 0 | 244 | 6.1% | 684 (40) | $0.299 | **Fail** (−17 required) |
| **M5** `gpt-5-mini` low | **49** | **82** | **2** (unparseable) | 240 | 21% | 1,083 (119) | $0.258 | **Fail** |
| **M5r** `gpt-5-mini` low + escaped-quote repair | **55** | 88 | 0 | 304 | 22% | 862 (101) | $0.250 (as a fresh run) | **Fail** (one group short) |
| N54 `gpt-5.4-nano` | — | — | — | — | — | — | — | **Not run** (no mini passed DEV) |

No held-out confidence intervals exist for any arm, because the decision stopped at DEV, as the pre-registration set.
DEV is scored by `eval/sets/score.py extraction`, with no bootstrap. Reference spread on DEV between gpt-6-luna settings:
59 at `low` (3b rebuild) and 56 at `none`. Between Luna 5.6 runs: 59 T-fresh and 57 T-cached (slice 2).

## The arms

### M54 (gpt-5.4-mini)

**Clear recall loss.** It writes far fewer records on major releases than gpt-6-luna. On Nest 12 it wrote 18 records
against 49 for gpt-6-luna `none`.

Required changes it misses entirely:
- Nest 12's move to ESM (10 required groups);
- Vitest as the default test runner;
- `revalidateTag`'s new required argument;
- Prisma 7's driver-adapter requirement;
- `prisma-client-js` → `prisma-client`.

Part of the loss is quote matching. It summarises "Prisma ORM now ships as an ES module" but quotes a different line, and
the scorer misses it. That explains only a few of the 19 required misses, not the Nest losses.

Practical notes: it was the fastest arm (60 s for DEV) and had no format failures.

### M5 (gpt-5-mini)

**Systematic format failure.** In 7 of 9 failed answers it opens a string value with an escaped quote:
`"evidence": \"…\"`. Two of 12 DEV chunks stay unparseable after 3 attempts: the Next 16 guide's second part and the
Prisma 7 notes. Those chunks hold most of its misses.

### M5r (gpt-5-mini with a repair)

The repair was added after DEV, chosen on DEV only, and pre-registered before the rerun. When an answer does not parse,
one deterministic rewrite turns `"<field>": \"<text>\"` into `"<field>": "<text>"`. It rescues both failed chunks with
0 failures and raises recall to 55/61 and 88/96.

**It still fails, by one required group.** Misses include:
- "Prisma ORM now ships as an ES module";
- the custom-webpack build change;
- Prisma 7's Node minimum table.

These are the same items slice 3c's `none` arm lost.

**Quotes are not verbatim:** 22% are ungrounded, against about 4% for gpt-6-luna. Precision on held-out would be the next
risk.

**It is the most token-hungry arm:** 862 tokens per record, against 542–1,015 for gpt-6-luna.

## Tokens per record and the 2.5M/day allowance (`tokens3e.py`, `out/slice3e/tokens.json`)

**Method.** This applies `cost3.py`'s worst-case formula in tokens to the mean technology (N 6,460, c 17.5, R 114.6):
- input = attempt factor × (2N + R·85·1.5 + c·(597 + 874));
- output = attempt factor × R × the arm's records relative to gpt-6-luna on the same set × measured output tokens per
  record (reasoning included).

**Basis.** The pre-registration asked for the H1- and H2-based figures. No arm reached held-out, so the candidates'
figures come from DEV. gpt-6-luna's figures come from its 3b H1/H2 runs and the 3c DEV run.

| Run | Tokens/record: input (cached) / output (reasoning) | Tokens per technology-year | Tokens/day at 20k technologies | Share over 2.5M/day | Fallback to gpt-6-luna flex for the excess, $/yr |
|---|---|---|---|---|---|
| gpt-5.4-mini, DEV | 493 (0) / 190 (40) | 69.0k | 3.78M | 34% | $35–65 |
| gpt-5-mini, DEV | 607 (130) / 476 (119) | 138.0k | 7.56M | 67% | $68–129 |
| gpt-5-mini + repair, DEV | 506 (75) / 356 (101) | 108.7k | 5.96M | 58% | $59–111 |
| gpt-6-luna `none`, DEV | 384 (65) / 158 (0) | 74.5k | 4.08M | 39% | — |
| gpt-6-luna `low`, H1 | 773 (0) / 242 (92) | 81.0k | 4.44M | 44% | — |
| gpt-6-luna `low`, H2 | 259 (7) / 155 (7) | 71.1k | 3.89M | 36% | — |

The $/yr range applies the over-cap share to gpt-6-luna flex: the low end at slice 3d's production replay
($0.0051 per technology-year, $102/yr at 20k), the high end at slice 3b's worst case at flex ($0.0096, $192/yr at 20k).

- **The allowance cannot carry 20k technologies even for a perfect model.** Input alone is about 53k tokens per
  technology-year: the notes read twice, the extract output re-read by the label call, and the fixed prompts. That is
  2.92M tokens/day at 20k, above the 2.5M cap before any output.
- **A passing small model would make A+B free up to about 8k–13k technologies** (2.5M × 365 / tokens per
  technology-year: 13.2k at gpt-5.4-mini's rate, 8.4k at gpt-5-mini's). Beyond that, the excess falls back.
- **At 20k technologies, the saving would be about a third to a half of A+B** (the 34–58% over-cap share is paid at
  gpt-6-luna flex). That is $35–65/yr instead of $102–192, a saving of $40–130/yr, if a model had passed.
- **The formula is a worst case** (uncached input, the attempt factor). The production replay costs about 53% of it, so
  real daily tokens are probably 2–3M at 20k, near the cap. Onboarding bursts come on top.

## Spend

| | |
|---|---|
| OpenAI, this slice | **$0.658 of the $3.00 cap** (`out/slice3e/usage.jsonl`, Standard list price) |
| ↳ smoke M5 / M54 | $0.014 / $0.024 |
| ↳ DEV M5 / M54 | $0.258 / $0.299 |
| ↳ DEV M5r (re-calls of the 2 failed chunks only) | $0.063 |
| ↳ key checks (3 one-word calls) | < $0.001, not logged |
| Vercel, Jev, Codex | $0 |

The models are in the complimentary data-sharing group, so the billed amount may be $0. The cap was counted at list. No
call was refused, and the per-call reservation never came near the cap.

## Caveats

- **DEV is small, and the gate is a count:** 61 required groups, with gate margins of 3 groups and 5 points. M5r misses
  by one group, inside the 2–3 group spread between gpt-6-luna and Luna runs. M5r's verdict is therefore "not shown
  adequate", not "shown worse". Its 22% ungrounded quotes and its verbosity are separate reasons not to pursue it
  without a prompt or parser change.
- **The DEV baseline (59/61, 87/96) is slice 3b's full pipeline rebuild,** not a `run3.mts` DEV run. The rebuild
  catalog holds all releases, not only the 9 documents. Spending on a fresh gpt-6-luna `low` DEV run was out of scope
  (no Vercel spend). The gpt-6-luna `none` DEV run (56/61 through `run3.mts`) is the like-for-like reference.
- **The scorer matches by quote.** Models that paraphrase evidence lose credit for changes they found (3b's lenient check
  showed 8–13 points for Luna 5.6 and Qwen). M54's and M5's misses were checked by hand only in part.
- **One configuration each:** reasoning `low`, Standard tier, production prompts. Medium effort or strict structured
  output (`response_format`), which would remove M5's format failure at its source, were not tried.
- **Truncation:** none in any run.

## Files

- `PREREG.md` § "Slice 3e" and its two amendments.
- `run3.mts`: `--cand openai:<model>` (OpenAI API, `max_completion_tokens`, hard per-call cap with in-flight
  reservation) and `--repair escaped-quote`.
- `tokens3e.py`: tokens per record, per technology-year and per day against the cap.
- `prices.json`: OpenAI Standard and flex list prices for gpt-5.4-mini, gpt-5.4-nano, gpt-5-mini and gpt-5-nano, from the
  OpenAI pricing page, checked 18 October 2026.
- Runs: `eval/select/out/slice3e/runs/*`, `usage.jsonl`, `tokens.json` (not committed; `out/` is ignored).
