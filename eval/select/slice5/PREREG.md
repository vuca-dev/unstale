# Slice 5 pre-registration: the same-or-new judge (step E)

Written 16 October 2026, before any candidate (Jev included) was run on a held-out request. Question: which model
should answer `match.ts matchRequest` (does the incoming record describe the same change as candidate c1..cK, K = 8)?
Runner `run5.mts`, scorer `score5.mts` (this directory).

## Code state

Guards and request builder: `central/src/pipeline/match.ts` and `thresholds.ts` at HEAD `b042f5f`, **unmodified in
the working tree** (the working tree's uncommitted changes are another session's, in `cli.ts`, `extract.ts`,
`DECISIONS.md`; none touches matching). Requests come from `eval/select/states.ts` (faithful only: byte-identical to
a request the pipeline asked, proven by a classifier-cache hit that reproduces the audit's p).

## Sets (faithful requests only)

| Role | Set | Pairs (faithful / all) | Requests | Records R (for duplicates/100) | Excluded |
|---|---|---|---|---|---|
| DEV | Within-source, `docs/match-audit.md` (Next.js 62, Prisma 5, NestJS 5) | 72 / 83 | 72 | 1,072 (central-v1 ingested) | 11: cached p differs from the audit's (`run5.mts --units` lists them) |
| DEV | Guides ↔ notes, Prisma + NestJS (`eval/guides`) | 59 | 57 | 94 guide items | of the 10 unreconstructable guide pairs, 7 are Prisma/NestJS |
| HELD-OUT | Nuxt (`eval/heldout`), technology-disjoint | 211 / 211 | 204 | 794 items | 0 |
| HELD-OUT | Guides ↔ notes, Next.js | 35 | 32 | 73 guide items | 3 Next.js pairs |

Verdicts are the audits' (SAME / DIFFERENT / UNSURE). Next.js is dev in the within-source set (62 pairs), so the
Next.js guide holdout is technology-contaminated (different source kind only); Nuxt is the clean holdout and is
reported separately as well as pooled.

**Known evalism, stated before the run.** Pairs exist only where Jev said p ≥ 0.5 (guides; Nuxt adds the pairs a guard
blocked and the near-threshold pairs; within-source holds only Jev's 83 merges). A candidate cannot be credited for a
SAME pair Jev scored low, so **merge recall is recall within Jev's pair set**, not judge recall, and the never-merge
duplicate rate is a lower bound. A candidate can also merge into a candidate no audit read ("unaudited merge"); its
verdict is unknown.

## Unaudited merges

Counted per candidate. The floor metric is reported two ways: (a) **unaudited merges adjudicated**: I (Claude) read
each unaudited merge of the held-out runs, pooled across candidates and shown without the model's name, under the v3
identity rules (RULES_V3, "different when unsure"), and give SAME / DIFFERENT / UNSURE; these verdicts are marked as
new, not the audits'; (b) the bound with every unaudited merge counted as DIFFERENT. If adjudication is not done for a
candidate, (b) is its floor number. In dev fitting, unaudited merges count as DIFFERENT (conservative).

## Candidates

| Id | Model | Path | Settings |
|---|---|---|---|
| J1, J2 | Jev `jev-latest` | pipeline `Jev` class | Two fresh held-out runs, each with its own empty cache; **J1 is the baseline**, J2 measures repeatability. One fresh dev run (fitting). Jev slice spend ≤ $0.30. |
| G20 | `openai/gpt-oss-20b` | AI Gateway, the pipeline's `CodexClassifier` prompt and the adapter's answer check | `reasoning_effort: low` (its lowest) |
| Q | `alibaba/qwen3.8-flash` | same | `reasoning_effort: none` |
| DS | `deepseek/deepseek-v4-flash` | same | `reasoning_effort: none` |
| GF | `google/gemini-3.1-flash-lite` | same | `reasoning_effort: none` (lowest accepted). Its list price ($0.25 / $1.50) is above Luna's; run as the brief asks, flagged in the verdict |
| L | Luna `gpt-5.6-luna` | `codex exec` on the user's plan, same prompt | Generation reference; costed prompt-only at list price ($0.20 / $1.20) |
| EMB | `alibaba/qwen3-embedding-0.6b` | gateway `/v1/embeddings` | p(same) = cosine(incoming brief, candidate brief), each brief the canonical JSON object the judge sees |
| NM | Never merge | — | No judge: every incoming record is new |

Chat answers must parse in full (every `same_cK` with a choice and both probabilities); up to 3 attempts, then the
request is unanswered = no merge (counted in parse rate and in retries' cost).

## Process

1. Smoke every candidate on 5 dev requests (seed `slice5`): parse rate, tokens (reasoning included), $/request.
2. Dry-run worst case, then projected cost of dev + held-out from the smoke's $/request × 1.5. **Abort a candidate
   projected above $0.40.** Slice gateway total ≤ $1.50 (the runner refuses past it).
3. Dev run, fit thresholds, then one held-out run per candidate (Jev: two).

## Thresholds (fitted on DEV only, per candidate)

Parameters: `SAME_P` (grid 0.50–0.99 by 0.01; embedding: its observed dev cosines), `CROSS_SAME_P` (same grid, ≥
`SAME_P`), `QUOTE_GUARD_BELOW` ∈ {0.90, 0.95, 0.99, never skip}. `LINEAGE_SAME_P` is immaterial: `sameLineage` holds
for no candidate of any request in the four sets (checked on request structure, not answers). Decision = match.ts
`pick` with these constants (judge, then breaking, advisory, cross and quote guards, best surviving p).

Objective on dev (within-source + Prisma/NestJS guides pooled): maximise item merge recall subject to guarded false
merges ≤ 1.0 per 100 merges; if no setting meets it, minimise false merges per 100, then maximise recall. Ties: the
higher (more conservative) thresholds. Also reported: every candidate at the pipeline's constants (0.7 / 0.85 / 0.95).

## Metrics (held-out: Nuxt + Next.js guides; also per set)

- **False merges per 100 merges** = 100 × (DIFFERENT + 0.5 × UNSURE) / merges. **Judge-only**: best p ≥ fitted
  `SAME_P`, no guards. **Guarded**: `pick` with the fitted constants. **FLOOR: guarded ≤ 1.0 per 100** (pooled
  held-out), the model-selection criterion for step E. (The Nuxt pre-registration's own acceptance bar was 5 per 100 plus "no
  hidden security change"; 1.0 is the stricter bar set for model selection.) The point estimate decides; the exact 95%
  interval is shown.
- **Merge recall (capped):** items with at least one audited SAME pair that merge into an audited SAME candidate /
  items with at least one audited SAME pair.
- **Duplicates per 100 records** = 100 × (items with an audited SAME pair that do not merge into a SAME candidate) / R
  (R: Nuxt 794, Next.js guide 73). A lower bound (the cap).
- Parse rate, retries, reasoning tokens, $ this run.

Paired comparison vs J1 on the same held-out items: exact McNemar (two-sided) on per-item recall and on per-merge-item
false-merge indicator, and a paired bootstrap (10,000 resamples of items) of the recall difference.

## Decision rule (as given)

Candidates meeting the false-merge floor with guards on held-out, whose merge recall is not significantly worse than
Jev's (McNemar p < 0.05 with lower recall = significantly worse), are ranked by worst-case cost per technology-year
O(R·K·S) (R and S measured by `cost.mts`, K = 8; reasoning tokens and retries included); the cheapest wins. Where a
costlier candidate is significantly better, the trade-off is presented. Where power cannot separate candidates, that
is said. If Jev (J1) itself misses the floor, that is reported and candidates are compared with Jev on the same metric.

## Cost

Per request measured on the held-out run (input, output incl. reasoning, × calls per request), scaled to K = 8
candidates by the ratio 8 / mean candidates per request; × R (mean technology 114.6; largest 1,092, `cost.mts`);
fleet at 10k / 50k / 200k technologies. Jev output is free. Luna prompt-only at list price. Embedding: O(R·(1+K))
embeddings of one brief each if not cached per record, O(R) if cached.

## Judge 2: fewer and shorter questions (16 October 2026, written before any run of these arms)

Question: can step E's cost (O(R·K·S), Jev, K = 8) fall without losing the floor? Runner `judge2.mts`, scorer
`score5.mts --judge2` (this directory). Same sets, same faithful requests, same dev/held-out split, same fitting
objective and grid (SAME_P, CROSS_SAME_P, QUOTE_GUARD_BELOW) per arm on DEV, one look at held-out.

**Measured before the arms were designed (no answers read):** the judge's state is already a brief (subject,
breaking, release, summary; median 1.6k characters). The size is in the questions: every `same_cN` question repeats
the full identity rules, about 8.1k of the request's 9.7k characters (Jev bills about 2,760 input tokens per held-out
request). So "slim candidate records" has little to remove; the arms cut the repeated rules and K instead. In the
audit units, the audited SAME candidate's position is c1 for 94%, within c1–c4 for 304/306 (both misses held-out).

Arms (all Jev `jev-latest`, each with its own empty cache, except F8):
| Arm | Candidates | Questions |
|---|---|---|
| F8 | c1–c8 | the pipeline's (J1 reproduced from J1's own caches: must be 100% hits and identical answers) |
| F4 | c1–c4 | the pipeline's, first 4 |
| O8, O4, O2, O1 | c1–cK | rules once, in the state (`identity_rules`); each question "Does the incoming record describe the same change as candidate cN? Apply the identity_rules in the state." with the same yes/no options |
| I8, I4 | c1–cK | answer by id: rules once in the state; ONE choice question over options c1..cK and `none` ("no candidate is the same change, or unsure") |

The I arms map to per-candidate p for `pick`, with the reading chosen on DEV only: (A) p_yes(cN) = p(cN); (B) as A,
except the most probable candidate gets 1 − p(none) (a true change matched by two candidates, e.g. a backport, splits
its mass). The reading is part of the fit.

**Pass rule:** guarded false merges ≤ 1.0 per 100 merges on pooled held-out (point estimate; unaudited merges
counted as DIFFERENT unless adjudicated, as slice 5), AND merge recall not significantly below J1 (exact McNemar on
held-out items, p < 0.05 with fewer recalled = fail; paired bootstrap CI shown). Passers ranked by measured $/request
on held-out (Jev input tokens; output free), scaled to the arm's K (worst case: every request carries K candidates)
× R (mean 114.6, largest 1,092) → $/tech-year and 10k/50k/200k. A true match outside the top K is a certain miss for
that arm (counted from units `index`). Cheapest passer wins; where a dearer arm is significantly better, the
trade-off is shown.

Add-on if budget remains: Clef Flash (Cloudflare free tier) on the cheapest passing O/I arm, same pass rule vs J1.

Caps: Jev ≤ $0.55 for this section (runner refuses past it); Cloudflare free tier only; no gateway spend.
Evalisms carried from slice 5: recall is within Jev's pair set (an arm cannot be credited for a SAME pair Jev scored
low; a merge into a candidate no audit read is UNAUDITED); the Next.js guide holdout is technology-contaminated.

## Judge rules compression (16 October 2026, written after the dev runs and before any held-out run of these arms)

Question: can the identity rules, which stay inside every `same_cN` question (Judge 2 showed that moving them out of
the questions loses recall), be reworded shorter without losing the floor? K = 8, same state, same question ids and
answer options. Runner `judge2.mts --arm M8|T8` (`RULES` in that file holds the exact text). Scorer:
`score5.mts --rules`.

| Arm | Rules text per question | Dev Jev input per request |
|---|---|---|
| J1 (= F8) | the pipeline's (about 870 characters, plus the cross-source line) | 2,933 |
| M8 | moderate: the same rules, shorter clauses (about 470 characters) | 2,262 (−23%) |
| T8 | tight: one sentence plus a list of "no if" cases (about 330 characters) | 1,883 (−36%) |

Dev only, already seen: J1 105/109 at 0 false; M8 106/109 at 0.9 per 100 (1 D) with fitted 0.87 / 0.87 / 0.95; T8
102/109 at 0 with fitted 0.65 / 0.75 / 0.90. T8's probabilities shift down (at the pipeline's constants it recalls
94/109), so its constants must be refitted for production. Neither text is edited after this point.

**Pass rule (as Judge 2):** guarded false merges ≤ 1.0 per 100 merges on pooled held-out (point estimate; unaudited
merges count as DIFFERENT unless adjudicated), AND merge recall not significantly below J1 (exact McNemar on held-out
items, p < 0.05 with fewer recalled = fail; paired bootstrap CI shown). Constants are fitted on dev per arm (slice 5
objective and grid). Passers are ranked by measured held-out $/request × R (114.6 mean, 1,092 largest) → $/tech-year
and 10k/50k/200k; the cheapest passer wins. Unguarded (judge-only) false merges are reported too.

Caps: Jev ≤ $0.25 for this section. No gateway, no Cloudflare.
