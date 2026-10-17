# Breaking hill-climb: pre-registered plan (15 October 2026)

Written and committed before any labelling call.

## Question

The type-tier review regressed on the unstale catalog (replay, `eval/replay/RESULTS.md`): covered key changes whose
entry is in the first type-tier batch of 16 fell from 18 to 13 of 19; found by review 17.5 → 10.5. Cause: `breaking`
is now set by Jev with the strict rubric (`BREAKING_RUBRIC`, `central/src/pipeline/vocab.ts`). Is this (a) prompt
sensitivity, (b) "evalism" (the replay rewarding labels the vault deliberately decided against: Next.js `middleware`
→ `proxy` deprecation is NOT breaking; ESM-only Nest packages is a case no label recovers), (c) a model (Jev) problem,
or (d) the rubric/design choice itself?

## Variants of the breaking question (exact texts in `prompts.ts`)

- **P0** (control): the catalog's question, `Is this change BREAKING?\n` + `BREAKING_RUBRIC`, options `yes`/`no` as in
  `labels.ts`. Asked alone (one question per request), not inside the catalog's eight-question request.
- **P1**: a paraphrase of P0 with identical meaning (same criteria, reworded sentences and option texts).
- **P2** ("obligation"): yes if breaking by P0, OR the release deprecates, renames or replaces something existing
  projects use with a stated removal or a warning, i.e. the upgrade expects existing projects to act.
- **P3**: P0's question with more input context. Held-out: the extraction `change_type` and the guide section around
  the evidence (the context the vault's judges saw; 144 of 251 records have one). Dev: one request per catalog record
  carrying the whole merged record (all evidence quotes with their kinds, all releases, facet, change_type, surface,
  terms, requires, prerequisites, conditions, introduces, replaces) instead of one request per incoming extraction.
- **P4**: ONE hill-climb revision, written only after seeing P0–P3 on the held-out and dev sets; its text and the
  reason will be appended to this file (dated) before it is run.

## Classifiers (same question text for all)

- **Jev** `jev-latest` through `central/src/pipeline/classify/adapter.ts` (`Jev` class, no fallback, so each answer
  is Jev's), yes if `p(yes) >= BREAKING_P` (0.5).
- **Luna**: OpenAI Decisions `gpt-6-luna` through the adapter (`OpenAIDecisions` class), same threshold.
- **Codex** `gpt-5.6-luna` via `codex exec` (flags as `~/ati-slice2/harness/dm_ident.py`), batches of 12 records of
  one technology. The prompt states the same question instructions and option texts, and each record as the same
  JSON state the other two classifiers receive. Answer: `yes`/`no` per record.
- Cache: every call cached by a hash of its full request (adapter's `ClassifierCache` for Jev/Luna; sha256 of the
  prompt for Codex) under the scratch dir; usage logged per call (`usage.jsonl` of the scratch store copy, as the
  pipeline does; Codex usage from its `turn.completed` events).
- **Codex budget (≤ ~150 calls including reviews):** held-out P0, P1, P2; dev P0 only. P3 and P4 are Jev and Luna
  only, unless the running total leaves room (P4 held-out first). Up to 12 review calls at the end.

## Held-out set and reference

The 251 records of `~/ati-slice2/results/datamodel/breaking/items.json` (161 upgrade-guide, 90 release-notes).
State: `{technology, source: "upgrade guide"|"release notes", release, subject, summary, evidence}` (P3 adds as above).

**Reference: the 241 records where the two vault judges (Codex `pipeline`, Sonnet `reference`) agree**, which the vault
reports were read by hand and held up. The 10 judge disagreements have no recorded hand ruling (the vault calls them
borderline), so they are excluded from agreement and reported separately. Bias to note: Codex `gpt-5.6-luna` was
one of the two reference judges, so Codex has a home advantage; Luna and Jev do not.

Metric: agreement on the 241 (%), false breaking (classifier yes, reference no), missed breaking (classifier no,
reference yes).

## Dev set (deterministic, no review agent)

The three replay events (workout-next16, invoicerr-prisma7, invoicerr-nest12). Relabel every catalog record in each
event's window (the queue plus the bump line, since a relabel can move a fix/security/performance record into the
queue): 435 records, 492 incoming extractions. P0–P2 (and P4) label each incoming extraction with the pipeline's own
`recordState` and set the record's `breaking` by the combine rule (true if any of its extractions is breaking); P3
labels the record once. Records outside the windows keep their catalog label. Matching is NOT rerun.

Per (variant × classifier): copy `~/unstale/.store` (`cp -cR`) to scratch, write the new `breaking` into the copy's
`central/records/<tech>.json`, republish with `UNSTALE_STORE=<copy> catalog publish`, run
`run_replay.py --catalog <copy>/catalog --work <copy of the final replay work dir> queue`, and score with the two
existing Codex match runs from the final replay (`match.json`: intersection of the two runs, `in_queue` recomputed
from the new queue). Never touches `~/unstale/.store`.

Dev metric: of the 19 covered key changes, how many have an entry in the first 16 of the type-tier order (per event
and total), plus tier-0 size per event (crowding). Sanity check: republishing with the cached catalog labels must
reproduce 13 of 19 and tier-0 sizes 42 / 54 / 12.

**P0 reproduction rate:** per extraction, P0 asked alone vs the catalog's cached label (read from the pipeline's
classifier cache by request hash, no call), and per record after the combine rule.

## Pre-registered interpretation

- **Model issue:** under the same prompt, Jev's held-out agreement is > 5 points below Codex or Luna.
- **Prompt sensitivity:** P1 flips > 5% of labels vs P0 for a classifier (held-out and dev extractions reported apart).
- **Evalism:** a variant raises the dev metric but lowers held-out agreement with the rubric reference, or raises
  it mainly by inflating tier-0 size.
- **Rubric/design question:** classifiers agree with the reference under P0 and dev stays low → the regression is the
  rubric choice, not the model or prompt.

## Reviews

For the single best variant by dev (summed over classifiers? no: the best (variant, classifier) cell, ties broken by
held-out agreement) that does NOT fail the evalism test, run replay review arms `tier` and `all`, K=2, for the three
events, and compare "found" with RESULTS.md. If none qualifies, skip the reviews and say so.

## Rules

No push, no remote, no rebase/amend/reset. Commits stage only `eval/breaking-hillclimb/`, plain messages, no AI
trailer. Keys loaded only inside the process. Network: api.typesafe.ai, api.openai.com/v1/decisions, `codex exec`.
Read only: `~/ati-slice0`, `~/ati-slice2`, the vault, `~/unstale/.store`. Budget: Jev well under $1 ($0.042/M
input), Codex under ~150 calls.

## P4 (appended 15 October 2026, after P0–P3 on both sets; before any P4 call)

What P0–P3 showed:

- Held-out, rubric reference (241): P0 Jev 89.6%, Luna 92.5%, Codex 95.4%. Jev's errors are mostly **missed**
  breaking (20 of 25): silent behaviour or default changes with no "breaking" wording (UUIDv7, gRPC status codes,
  `db:show` output, `minimumCacheTTL`, `.next/dev`, Turbopack as default bundler) and contract changes for
  implementers (`UserProvider::rehashPasswordIfRequired`, `Enumerable::dump`). Its false breaking are opt-in cases
  (Carbon 3, ESM import extensions, `@prisma/client-runtime-utils`). P3's context helps both Jev (+2.1) and Luna (+2.1).
- P2 (obligation) is the only variant that raises the dev metric (13 → 15 for Jev and Luna: `next-proxy-ts` and
  `next-images-domains-domains` move into tier 0) and it lowers held-out agreement for every classifier.
- No rubric-faithful variant moves dev: the remaining dev losses are entries the rubric rules not breaking
  (middleware → proxy deprecation, `images.domains` deprecation, Vitest as the generated-project default) or a
  breaking entry (`next-turbopack`) that, once labelled breaking, still ranks below 16 inside a crowded Next tier 0.

**P4 = P3's state + P0's rubric + one paragraph** naming, in general terms, the breaking changes P0 misses without
"breaking" wording (a changed default or observable result for existing projects, a rename or removal without the
old name working, a new method implementers must add) and the opt-in cases it over-calls (applies only to projects
that adopt something new or optional; old form still works with a warning). Exact text: `prompts.ts`, `P4`. Why:
it is the one revision that targets the classifier's measured errors against the rubric without changing what the
rubric means; it is deliberately not aimed at the dev records. Caveat: it is fitted to held-out errors, so its
held-out agreement is in-sample and optimistic. Codex runs P4 on held-out only if the call total allows (115 so far).
