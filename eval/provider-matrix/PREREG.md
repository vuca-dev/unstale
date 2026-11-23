# Provider matrix pre-registration: which model a user's own key should use per step

Written 10 November 2026, before any candidate call on a dev or held-out unit. Calls so far: one-word and made-up-state
probes (`probe.mts`, `probe-effort.mts`), a 10-record step D smoke for the decision model and for Haiku at its default
reasoning (not an arm here), a 5-request step E smoke for the decision model, and a 5-request qwen re-run that checks
`run5.mts`'s restored prompt (all 5 request keys equal slice 5's own cache keys).

**Question.** With local inference on the user's own key (vault: Edge Inference), the client's key picker needs, per
step (A+B extraction, D record labels, E same-or-new judge) and per key type (Jev, OpenAI, Anthropic, gateway or
OpenRouter), the model that clears the step's floor at the lowest cost. This slice compiles every cell already measured
(slices 3–14) and fills the gaps below. Codex and Cursor CLI cells are out of scope (another experiment).

## Candidates

| Id | Route and model | Setting | Steps | Why |
|---|---|---|---|---|
| **DEC** | OpenAI Decisions API, `POST /v1/decisions`, `gpt-6-luna` ($0.10/M input, output free) | none (a classifier) | D, E | The Jev analogue for a user with only an OpenAI key. Request shape as central's adapter before 15 October (`decisions.ts`) |
| **HK** | Gateway `anthropic/claude-haiku-5.5` ($0.10 / $0.50 per M) | `reasoning_effort: none` (the lowest it accepts; its default thinks, `probe-effort.mts`) | A+B, D, E | The current Haiku, for a user with an Anthropic key. The gateway serves the same model as the Anthropic API |
| HK-low | the same | `reasoning_effort: low` (production's gpt-6-luna setting) | A+B | Runs only if HK fails A+B: a fail at the lowest effort does not settle the model |
| **G6c** | Gateway `openai/gpt-6-luna` as a chat classifier | `low` (production's fallback setting) | D, E | The chat route an OpenAI-key user gets without the Decisions API; production's fallback today |
| **G6d** | OpenAI API directly, `gpt-6-luna` chat | `low` | A+B, H1 only | Second-route sanity check against the gateway baseline. Not a selection |

Not run: OpenRouter (no key configured); a direct Anthropic API route (no key; the gateway stands for it); Jev for A+B
(a classifier cannot generate records).

## Sets and baselines (unchanged)

| Step | Runner | Dev (fitting or gate) | Held-out | Baseline |
|---|---|---|---|---|
| A+B | `slice3/run3.mts --out provider-matrix --cap 1.5`, production prompts, two calls | DEV: 9 documents, 12 chunks (`eval/sets/score.py extraction`) | H1 40 short notes (`stats.py`), H2 7 guides and major notes (`stats3b.py`) | gpt-6-luna `low` two-call runs of slice 3b |
| D | `slice4/run4.mts` (`labelQuestions()`, = wording v1) | benefit 150 + breaking 241 | H1 233 records, H2 441 records | Jev v1: `jev-dev-qv1`, `jev-heldout-qv1`, `jev-heldout2-qv1` (stored) |
| E, DEC | `slice5/judge2.mts --arm Q8 --floor 0.60` (production's wording, as slice 14) | within-source + Prisma/NestJS guides (129 requests) | Nuxt + Next.js guide (236 requests) | Fresh Jev Q8 dev and held-out runs (current `jev-latest`) |
| E, chat | `slice5/run5.mts` (F8 requests and the stated-probability prompt, as slice 5's chat arms) | same | same | J1 (slice 5's Jev run 1) |

Chat arms in D use slice 4's prompt (a choice and a probability per option), as every earlier chat cell did.

## Floors (each slice's rule, unchanged)

- **A+B** (slice 10): DEV gate first: required fetched ≥ 56/61, in fetched sources ≥ 83/96, ≤ 1/12 chunks failed. A
  DEV passer gets one held-out look: H1 pooled, macro and breaking recall, H2 required and breaking recall, each ≤ 5
  points below the baseline and the 95% CI not wholly below 0; precision ≤ 10 points below on each set.
- **D** (slice 14): at the arm's dev-fitted thresholds, H1 against Jev v1 at Jev's fitted thresholds: breaking,
  benefit-vs-none and actionable recall each ≤ 5 points below and the paired CI not wholly below 0. H2 against Jev v1
  at 0.5: breaking recall and breaking precision, section-cluster CI not wholly below 0. **H2 runs only if H1 passes.**
- **E, DEC** (slice 14): pooled held-out guarded false merges ≤ 1.0 per 100 (unaudited counted as DIFFERENT) at the
  dev-fitted constants (slice 5 objective), and merge recall not significantly below fresh Jev Q8 (exact McNemar
  p < 0.05).
- **E, chat** (slice 5): the same floor and recall test against J1. Reported beside it, descriptive: the production
  fallback rule for an uncalibrated chat answer (`score5.mts --fixed 0.5,1.01,1.01`, merges only on a near-identical
  same-kind quote).
- **G6d:** H1 floor metrics against the gateway baseline by the A+B held-out rule. Passing means the routes agree.

The chat arms' stated probabilities are not scores (slice 4 `RESULTS-choice.md`); the fitted rules are applied anyway
because they are the rules every earlier chat cell was judged by, and the choice-only (0.5) view is reported beside them.

## Cost (unchanged formulas)

- A+B: `slice3/cost3.py` worst case per mean technology-year at list price (uncached input), the larger of the H1- and
  H2-based figures; a DEV-only arm is costed from DEV tokens as a ratio to gpt-6-luna and marked so.
- D: measured $ per held-out H1 record (retries and reasoning included) × R (114.6 mean, 1,092 largest).
- E: measured $ per held-out request × 8 / mean candidates per request × R.
- Gateway at default tier for every arm (flex is not listed for Haiku); gpt-6-luna's production flex price is shown
  beside its list price.

## Picker order (the decision this slice makes)

Per key type and step: cells that pass the floor, cheapest first. A difference under 10% is a tie, broken by the
better floor metrics. Where nothing passes for a key type, the option is listed as "below floor" with its failing
metric, ordered by fewest floor failures, then cost, and the step's no-model fallback (E: never merge) is named. A
key type that cannot run a step (Jev for A+B) is paired with the cheapest passing generative key.

## Budget

Under $5 in all. Gateway ≤ $2.50 (balance $4.45 at the start; runners refuse below a $1 reserve). Decisions API
≤ $0.60 for D (`run4.mts --decisions-cap`) and ≤ $0.40 for E (`judge2.mts` DECISIONS_CAP). OpenAI chat (G6d) ≤ $0.20.
Jev ≤ $0.10 (the Q8 baselines). A provider whose calls fail repeatedly is stopped and reported. Every call is logged
with tokens and dollars in the runner's usage log.

## Addendum 1: gpt-6-luna chat on step D, read on its choices (confirmatory)

Written 10 November 2026, after the run above and before any call for this addendum. **This tests a reading first seen
descriptively in that run** (RESULTS.md: at its choices gpt-6-luna chat looked level with or above Jev on H1 and H2),
so it needs a **fresh run**: rescoring the existing answers would reuse the draw that suggested the reading. The
existing answers are rescored the same way and reported beside it, labelled descriptive.

- **Arm (CH):** gateway `openai/gpt-6-luna`, `reasoning_effort: low`, asked through production's chat-fallback prompt
  and parser (`adapter.ts` `ChatClassifier`: one option per question, no probabilities; the answer becomes probability
  1 for the choice and 0 for the rest, `calibrated: false`). `run4.mts --cand choice:openai/gpt-6-luna`, empty caches.
  Breaking and benefit are the chosen options; no threshold is fitted on stated probabilities (any threshold in (0, 1]
  gives the choice).
- **Sets:** slice 4 dev (run for completeness; nothing is fitted on it), H1 (233 records), H2 (347 records), each once.
- **Baseline:** Jev on today's wording (v1 runs `jev-*-qv1`, J1's role on the questions `labelQuestions()` asks now).
- **Rule (slice 4, unchanged), H1:** breaking, benefit-vs-none and actionable recall each ≤ 5 points below Jev at Jev's
  dev-fitted thresholds and the paired CI not wholly below 0; guard: change_type accuracy and removal + deprecation
  recall, paired CI not wholly below 0. **H2:** breaking recall and breaking precision against Jev at 0.5,
  section-cluster CI not wholly below 0. CH passes if H1 and H2 both pass.
- **Reported beside it, pre-registered as secondary:** the same H1 comparison against Jev at 0.5, production's live
  thresholds. Known before this run, from the descriptive reading: CH-like breaking recall is about 7 points below
  Jev's fitted 0.05 on H1, so the primary rule may fail on that margin alone.
- **Budget:** ≤ $1 gateway (the runner's slice cap and the $2 balance stop still apply).
