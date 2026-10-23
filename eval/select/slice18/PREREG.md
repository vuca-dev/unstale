# Slice 18 pre-registration: the lineage bar

Written 23 October 2026. The census counts below are known; no new label, fit or score exists. Slice 17 measured
lineage at production's LINEAGE_SAME_P 0.80 on 82 held-out requests: 3.1 false merges per 100 and 65% recall. Those
82 requests are part of the held-out split below, so that look has already been taken.

## Sets: the whole production history's lineage pairs (`slice17/lineage.mts`, unsampled), split by technology

| Split | Technologies | Requests | Lineage pairs | Production lineage merges |
|---|---|---|---|---|
| **DEV** | next, nestjs, prisma (already used for step E in slices 2–5) | 359 | 1,007 | 219 |
| **HELD-OUT** | the other 21 (tanstack-react-query, npm-to-yarn, pinecone, …) | 468 | 1,544 | 100 |

- **Labels:** every lineage pair, by two judges (J1 Codex gpt-5.6-luna, J2 gateway gpt-6-luna), with slice 17's prompt.
  Disagreements are adjudicated by me, blind to p and to any arm. The 471 pairs labelled in slice 17 keep their
  labels.
- **Answers:** production's recorded p (Jev 1.13 or 1.14 at the time).

## Decision model (a request re-decided from its recorded judged list)

- A non-lineage candidate keeps its production outcome: it is eligible only if production marked it `same` or
  `not-best`.
- A lineage candidate is eligible if its p ≥ max(SAME_P 0.70, the arm's bar) and production did not block it by the
  breaking, advisory or cross guard. `unasked` is never eligible.
- The request merges into the eligible candidate with the highest p.
- **Check:** at 0.80 this must reproduce production's decisions. Mismatches are reported.

**Metrics** (on lineage pairs):
- false merges per 100 lineage merges = 100 × (D + 0.5 U) / merges;
- recall = requests with a SAME lineage pair that merge into one / requests with a SAME lineage pair;
- paired against production (0.80): exact McNemar on requests.

## Rounds (fitted on DEV only; one held-out look per round)

- **Round 1: LINEAGE_SAME_P** on 0.70–0.99 by 0.01. Objective: maximise dev recall subject to dev false merges
  ≤ 1.0 per 100. Ties go to the higher bar. If no bar meets the floor, minimise false merges, then maximise recall.
- **Round 2** (only if round 1 does not ship): a lineage quote guard. Below a bar Q ∈ {0.85, 0.90, 0.95, 0.99, never},
  a lineage merge also needs the incoming quote to be near-identical (`nearIdenticalQuote`) to one of the candidate's
  quotes of the same document. LINEAGE_SAME_P and Q are refitted jointly on dev by round 1's objective (ties: higher
  bars).
- **Not run: request wording or candidate set.** A lineage request cannot be rebuilt: a merged item's own brief and
  the candidates' past states are not stored, so a new wording could not be asked faithfully.

## Ship rule

Ship a round's setting if, on held-out, guarded false merges are ≤ 1.0 per 100 and recall is not significantly below
production's (McNemar p < 0.05 with fewer recalled = fail). Otherwise report the trade-off. A shipped setting changes
`thresholds.ts` (and, for round 2, `match.ts`), with tests.

Budget ≤ $5 (J2 on the gateway; Codex on the plan; no Jev).
