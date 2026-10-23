# Slice 14 pre-registration: SubQ Snap 1.1 for steps D and E

Written 22 October 2026, before any `subq-snap-1.1` call on a dev or held-out unit (one 97-token API smoke on a made-up
state checked the id). Question: should production move step D (record labels) and/or step E (same-or-new judge)
from Jev to SubQ Snap 1.1? The preview (`subq-snap-preview`) was rejected on 17 October (slice 4 `RESULTS.md` § "SubQ
Snap", slice 5 `RESULTS-judge2.md` § "SubQ Snap on the judge").

**Model and price.** `subq-snap-1.1` (`GET https://api.subq.ai/v1/models`), $0.04 per M input, output free
(subq.ai/pricing, checked 22 October; `prices.json`). Jev stays at $0.042 (`prices.json`; thejevai.com/pricing now shows
credit packs only, so the per-token rate could not be re-checked). Same request and answer shape as Jev, through
`subq.ts` (`--subq-model subq-snap-1.1`).

## Sets, wording and baselines (unchanged from slices 4 and 5)

| Step | Dev (fitting) | Held-out (decision) | Wording asked | Jev baseline |
|---|---|---|---|---|
| D | benefit 150 (170 requests) + breaking 241 | H1 233 records (posthog-js, zod, uvicorn, typer); H2 441 records (SvelteKit 3, MSW 3, transformers 5, mypy 2) | `labelQuestions()` = `questions.ts` v1 (checked byte-equal) | `jev-dev-qv1`, `jev-heldout-qv1`, `jev-heldout2-qv1` (existing runs, same wording) |
| E | within-source 72 + Prisma/NestJS guides (129 requests) | Nuxt 211 pairs + Next.js guides 35 (236 requests) | Q8: `shortRules` (M8) with `QUESTION_FLOOR` 0.60, as ingest asks since #29 | fresh Jev Q8 dev and held-out runs (the 17 October Q8 runs are not on disk) |

## Fitting (dev only, unchanged)

- D: `BREAKING_P` and `BENEFIT_P` on the 0.05 grid by dev F2, ties to 0.5 (slice 4 `analyze.fit`).
- E: same / cross / quote by the slice 5 objective (max dev merge recall s.t. guarded false ≤ 1.0 per 100; ties to
  the higher constants), `score5.mts`.

## Floor (the switch rule's, per step)

- **D passes** if both hold, Snap at its dev-fitted thresholds:
  - H1, against Jev v1 at Jev's dev-fitted thresholds (slice 4 rule): breaking, benefit-vs-none and actionable recall
    each ≤ 5 points below Jev and the paired CI not wholly below 0.
  - H2, against Jev v1 at 0.5 (H2's rule): breaking recall and breaking precision, section-cluster paired CI not
    wholly below 0.
- **E passes** on pooled held-out: guarded false merges ≤ 1.0 per 100 merges (unaudited counted as DIFFERENT unless
  adjudicated), and merge recall not significantly below Jev Q8 (exact McNemar p < 0.05 with fewer recalled = fail).

## Cost and repeatability

- **Cost** per technology-year, worst case, as slices 4 and 5: held-out input tokens per unit as billed × price
  × R (114.6 mean, 1,092 largest); step E × K / mean candidates per request. Both candidates on the same requests.
- **Repeatability:** one second fresh held-out run per candidate per step (Snap: `-r2`; Jev D: `jev-heldout-qv1-r2`;
  Jev E: a second Q8 run). Counted as decisions that change between the two runs: D, H1 records whose mapped labels
  (breaking, benefit set, change_type, actionable) differ at the arm's thresholds; E, held-out items whose guarded
  merge target differs.

## Merge rule (the user's), per step, D and E separately

Adopt Snap 1.1 for a step if it passes that step's floor and either:
1. **More cost-efficient:** its $/tech-year is more than 10% below Jev's; or
2. **Comparable cost** (within ±10%) **and** noticeably better: a significant paired gain on a floor metric (CI wholly
   above 0 / McNemar p < 0.05 in Snap's favour), or materially better repeatability (Snap's changed decisions ≤ half
   of Jev's, with Jev's ≥ 3).

More than 10% dearer: Jev stays. A held-out set is scored once per round; nothing is refitted on held-out.

## Hill-climbing (at most 2 rounds)

Round 0 is the pipeline's wording at the fitted thresholds above. A round, if any, is written below before it runs:
the lever, the dev-only fitting rule, and the held-out arm it produces. Levers are limited to the step's request
(question wording, K, batching, floor) and its thresholds; answer by id, never by rewriting. Clear wins only: a round's
arm is adopted only if it passes the same floor and merge rule, and it is reported with the number of held-out looks.

## Budget

SubQ ≤ $1.00 in all (runner caps: `run4.mts --subq-cap`, `judge2.mts` SUBQ_CAP $0.40 including the preview's $0.034).
Jev ≤ $0.10 (repeat and Q8 baselines). No gateway, no Cloudflare.

## Round 1 (written 22 October 2026, after round 0's held-out look and before any round 1 fit or call)

Round 0 (RESULTS.md) failed both floors. Seen on dev only, for the levers below: Snap's dev actionable share (surface
≠ runtime_internal) is 72.5% against Jev's 75.7%; on step E dev, Snap's guide-vs-notes DIFFERENT pairs sit at median
p 0.985 (Jev 0.67), while its within-source DIFFERENT pairs sit at 0.48.

- **D1 (no new calls, round 0's answers re-mapped):**
  - `BREAKING_P`: maximise dev F2 subject to dev breaking precision ≥ Jev v1's dev precision at the live 0.5; ties to
    0.5. `BENEFIT_P`: unchanged (dev F2).
  - Actionable: not actionable only when p(runtime_internal) ≥ τ (instead of the argmax choice). Dev has no surface
    labels, so τ is matched to the incumbent: the smallest τ on the 0.05 grid (0.50–0.95) at which Snap's dev
    actionable share is ≥ Jev v1's dev argmax share. Production would publish the next-best surface when the argmax is
    runtime_internal below τ.
  - Floor and merge rule as above, on H1 and H2 (second look at both).
- **E1:** Q8 with the cross-kind sentence removed from the guide-vs-notes questions (`--no-cross`; every question then
  reads as the within-source one). Dev fit by the slice 5 objective, then one held-out run; floor and merge rule as
  above against Jev Q8 (second look).

## Round 2: not run

Both round 1 arms failed (RESULTS.md). No lever left can be fitted on dev with a credible path to the floor:
- D's binding failure is actionable recall, and dev has no surface labels. D1 already matched the incumbent's dev rate.
- E's gap is about 62 recall points. The levers left are the longer rules or a larger K, which cost more than Jev Q8.

A third held-out look would only spend power.
