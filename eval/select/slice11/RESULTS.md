# Slice 11 results: MiniMax M3.1 Flash with a fitted extract prompt (steps A+B)

20 October 2026. Pre-registration: `PREREG.md` (39d57e7, pushed before any held-out call).

## DEV (gate: required fetched ≥ 56/61, in fetched sources ≥ 83/96, ≤ 1/12 failed chunks)

| Arm | Extract prompt sha | Required fetched | In fetched sources | Failed chunks | Records | Ungrounded | Wall | 429s |
|---|---|---|---|---|---|---|---|---|
| gpt-6-luna `low` (3b gate rebuild, incumbent) | `68e134fe` | 59 | 87 | 0 | — | 2.2% | — | — |
| MiniMax, production prompt (slice 10) | `68e134fe` | 55 | 86 | 0 | 441 | 6.8% | 237 s | 0 |
| MiniMax r1: evidence = the stating line | — | 53 | 86 | 0 | 453 | 1.5% | 162 s | 0 |
| MiniMax r2: r1 + "copy a link as its text" in the field | `87e52604` | 55 | 89 | 0 | 432 | 0.7% | 178 s | 0 |
| **MiniMax r3**: r2 + the link rule after the task, with a neutral example | **`2f578d1b`** | **59** | **88** | 0 (1 unparseable, retried) | 418 | 2.9% | 217 s | 0 |

- r1 fixed slice 10's three MiniMax-only misses: Prisma's ES module line, the Node row of the minimum-versions table, and
  Next's custom-webpack failure. It then copied markdown link URLs into its new statement quotes
  ("All [parallel route](/docs/…) slots…"), which no longer read as the page reads, and lost four others.
- r2's field-level instruction was not followed. r3's restated rule was followed: 7 of 198 guide quotes carry a link,
  against 30 in r1.
- `central/src/pipeline/extract.ts` `locate` now folds markdown links (`[text](url)` → `text`) on both sides, so a
  link-free quote still grounds. This changes no quote, only the `grounded` flag and section of quotes copied that way.
- **Frozen: r3** (it equals gpt-6-luna `low`'s 59/61 and has the most required hits). Its template sha `2f578d1b…` is
  pinned in `central/test/llm-fallback.test.ts` against `extractPromptFor`.
