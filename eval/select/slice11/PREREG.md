# Slice 11 pre-registration: fit the extraction prompt to MiniMax M3.1 Flash (free), then one held-out look

20 October 2026. Written before any held-out output of this slice. Before writing it, the only slice 11 outputs were the
analysis of slice 10's MiniMax DEV run (below), a one-word probe (MiniMax accepts and ignores the gateway's flex option),
and revision r1's DEV run, which was started at the same time and had not finished when this file was written.

Question: can `vercel:minimax/minimax-m3.1-flash` (free on the AI Gateway) replace production's
`vercel:openai/gpt-6-luna` (reasoning `low`, two calls, flex) for extraction steps A and B, with gpt-6-luna kept as the
fallback, without losing quality? Slice 10 ran MiniMax on production's prompts unchanged and missed the DEV gate by one
required change: 55/61 required and 86/96 overall, against 56/61 and 83/96.

## Why MiniMax misses on DEV (slice 10's run, `eval/sets/score.py extraction`)

There were no failures of format, length or JSON: 0 of 12 chunks failed, nothing was truncated (the most output was
under 16,000 tokens), nothing was unparseable, and there were 20k reasoning tokens over 24 calls at `low`. No chunk was
skipped either: it produced 441 records, against 338 for gpt-6-luna `none`. The six required misses:

| Gold quote (fetched source) | Luna `none` (3c) | MiniMax: what it emitted instead |
|---|---|---|
| Prisma 7 guide: "Prisma ORM now ships as an ES module" | hit | A record for the change (`package.json`, summary "…because Prisma ORM now ships as an ES module") that quotes the **remedy**, "Set the `type` field in your `package.json` to `module`" |
| Prisma 7 guide: "Node \| 20.19.0 \| 22.x" (minimum versions table) | hit | Records `Node` and `TypeScript` that quote the **section's introduction**, "Prisma ORM v7 introduces breaking changes when you upgrade…" |
| Next 16 guide: "If your project has a custom `webpack` configuration and you run `next build` … the build will **fail**" | hit | A record whose summary states it ("…requiring projects with custom webpack configuration to migrate or opt out"), quoting the neighbouring line "Turbopack is stable and used by default…" |
| Prisma 7 guide: "After running `npx prisma generate`, you'll need to update your imports…" (2 events) | miss | — (Luna misses it too) |
| Next 16 notes: "Add a --webpack flag and default --turbopack to true" | miss | — (Luna misses it too) |

So the three misses that only MiniMax has are **evidence choice**, not missing records. It understood the change but
quoted a heading, an introduction shared by several changes, or the instruction for adopting the change, instead of the
sentence or table row that states it. It also reuses one quote for several records (three `tsconfig.json` records, 12
environment-variable records). The fix is general, in the wording of the evidence field. It is not per technology.

## DEV revisions (at most 3), then freeze

Each revision changes only the extract prompt sent to MiniMax. The runner is `slice3/run3.mts --cand
vercel:minimax/minimax-m3.1-flash --split dev --out slice11 --addendum mm-rN`, and the text is in `slice3/addenda.ts`
`REVISIONS`. The label prompt, reasoning `low`, max_tokens 16,000, chunking and two calls are all unchanged. If a revision
shows a different failure (truncation, JSON), a later revision may also change max_tokens or reasoning effort, and
`RESULTS.md` records it.

- **r1** replaces the evidence field (`"evidence": a sentence or phrase copied verbatim from the notes that supports the
  record`) with: the sentence, list item or table row that states the change itself (what is new, removed, renamed,
  required or now fails), not a heading and not a sentence that only introduces several changes; when the notes follow
  the statement with what to do about it, copy both.
- **r2, r3**, only if needed, are written from the previous revision's DEV misses, on DEV only. Each is a full DEV run.

**DEV gate** (slice 10's, unchanged): required fetched **≥ 56/61**, in fetched sources **≥ 83/96**, **≤ 1 of 12**
chunks failed. **Freeze:** revisions run in order. Stop early once a revision reaches gpt-6-luna `low`'s DEV result
(59/61 required and 87/96). Otherwise stop after r3. The frozen revision is the passer with the most required hits, ties
broken by more hits in fetched sources, then by fewer ungrounded quotes. Its sha256 (the MiniMax extract template) is
recorded in `RESULTS.md` and in a central test before any held-out call. If no revision passes, nothing goes to
held-out and the slice is eval only.

## Held-out (one look, frozen revision only)

H1 (`holdout/`) and H2 (`holdout-majors/`) have had many looks since slice 3b. `holdout-majors` *is* H2, so it is not a
fresher set. The fresher set is slice 6's held-out AI SDK units, and it is the **primary** set here.

**P (primary): slice 6's held-out AI SDK units.** These are the 4.0, 5.0, 6.0 and 7.0 migration guides, each read by every
package that ingested it: 4 units, 42 pairs, 1,110 base records. They come from the 20 October production state. Slices 6 and
7 used them for guide-sharing designs. No extraction prompt has been fitted on them, and no model other than gpt-6-luna has
extracted them. Slice 6's NestJS 12 unit is excluded, because its guide is a DEV document here.
- Arm `mm`: **production's code path**, `extractRelease` from this branch's `central/src`, with MiniMax primary on the
  frozen prompt and gpt-6-luna `low` flex as the fallback. It runs per package with empty caches. No Jev labels: step D is
  unchanged.
- Compared against slice 6's stored `base` (production's per-package answers) and `rep` (a fresh gpt-6-luna replicate,
  the noise reference), with `slice6/score6.mts` (matching as in slice 3d, pair bootstrap, seed 20261020).
- Pass when **all** of the following hold. These are slice 6's rules 1–4 and 6, with `mm` in place of `shared`:
  - **F1** is no more than 3 points below rep's, and the paired CI is not entirely below 0.
  - **Recall** and **precision** against current are each no more than 5 points below rep's, with the paired CI not
    entirely below 0.
  - **Records** are within ±10% of base, or within rep's deviation + 5 points.
  - **Terms Jaccard** is no more than 5 points below rep's.
  - **Failed pairs** are at most max(1, 2%), counting a pair as failed only when the fallback also failed.

**H1 and H2 (secondary): slice 3b's rule, as slice 10 Step 2.** `run3.mts --split heldout|heldout2 --addendum <frozen>`
runs MiniMax alone. A failed chunk scores zero records, with no fallback, which is conservative. Baselines are the slice
3b gpt-6-luna `low` runs (`out/slice3b/runs/vercel_openai_gpt-6-luna-two-call-heldout`, `…-heldout2`). Noise references
are `out/slice3c/runs/…-heldout-rep2` and `out/slice3b/runs/…-heldout2-rep2`. These are stored runs, so the baselines
cost nothing.
1. Floor:
   - H1 (`stats.py compare`): pooled and macro group recall excluding unsure, and breaking-group recall.
   - H2 (`stats3b.py compare`): required-group recall excluding unsure, and breaking-group recall.
   - Each must be no more than **5 points** below the baseline, with the 95% CI of the difference not entirely below 0.
2. Precision must be no more than **10 points** below the baseline on each set.

**Gold (slice 6's rule 7):** H2's three upgrade guides only (`@sveltejs/kit` 3, `msw` 3, `transformers` 5), with the
MiniMax H2 run's guide records against the same baseline's guide records (`holdout/score.py compare` on the guides-only
manifest that `slice6/gold_prep.py` builds). Required-group recall excluding unsure and breaking-group recall must each
be no more than 5 points below, with the CI not entirely below 0. Precision must be no more than 10 points below.

**Verdict:** pass only if P, H1, H2 and Gold all pass. Ungrounded-quote share and records per set are reported but are
not gates.

## Load (free tier, no held-out text)

A burst of **200 calls**: the 12 DEV extract prompts (frozen revision), cycled, at concurrency **40**, with no cache and
production's retry policy (429/5xx retried, honouring `retry-after`). It records 429s, retry-after values, calls
exhausting retries, sustained calls per minute, p50/p95 latency and output tokens per second.
- Production need at 20k technologies is about **40 calls/minute** during onboarding (slice 10: 56,000 calls/day), and
  about 1,900/day at steady state.
- Verdict: "sustains the load" if the burst reaches **≥ 40 calls/minute** with **≤ 1%** of calls exhausting retries.
  Otherwise MiniMax is usable only with the gpt-6-luna fallback absorbing the excess, and the saving is the share it
  serves.

## Production (only if the held-out verdict is pass)

`central/src/pipeline/llm.ts` and `extract.ts`:
- MiniMax becomes the default primary extraction model (`UNSTALE_EXTRACT_MODEL`). Its extract prompt is the frozen
  revision.
- gpt-6-luna `low` flex stays as the fallback (`UNSTALE_EXTRACT_FALLBACK`, `none` disables it). It is used on HTTP errors,
  exhausted 429s, truncation and unparseable answers, and it gets production's prompts unchanged.
- **Caches stay valid.** The cache key is already sha256(provider + request body), and the body names the model, so each
  model's answers live under their own keys. A lookup tries the primary's key, then the fallback's key, before any call,
  so a chunk already extracted by gpt-6-luna is answered from cache and is not extracted again. Its label call then
  matches gpt-6-luna's cached label request too.
- The model that answered is recorded in the cache entry and in the usage log, with role primary or fallback and the
  fallback reason.
- The classifier's chat fallback keeps gpt-6-luna and its cache keys.
- Unit tests use mocked fetch. If the verdict is fail, `central/src` is not changed.

## Cost

MiniMax is $0. Expected $/yr at 20k technologies = the fallback's share of calls (from P and the load burst) ×
gpt-6-luna flex's $/yr: $102 on the slice 3d production replay, $192 in the 3b worst case.

## Budget

Vercel cap **$2.00** for the slice, from `out/slice11/usage.jsonl` plus the P arm's usage log (provider-reported). The
only paid calls are gpt-6-luna fallbacks. No Jev, OpenAI or Codex spend.

## Known limits

- One run per arm. MiniMax's run-to-run spread on DEV is unknown, so a one-group DEV pass is within noise. Held-out
  decides.
- P measures agreement with gpt-6-luna's own output, not gold. A different but equally good extractor can score lower
  there.
- H1 and H2 are stale; the H2 gold subset is three guides.
