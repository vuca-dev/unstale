# Slice 4 pre-registration: the record-label classifier (step D)

Written 16 October 2026, before any candidate was run on the held-out set and before any held-out reference label
was read. Question: which model should answer step D's eight questions (`classify/labels.ts`: change_type, surface,
breaking, five benefit yes/no)? Vault: Inference Costs, "Model selection".

## Sets

| Role | Set | Items | Use |
|---|---|---|---|
| DEV | `eval/sets/benefit/reference.json` | 150 records (170 faithful requests; item label = union over sources, as `states.ts aggregate`) | Fit `BENEFIT_P`; smoke samples |
| DEV | Breaking, vault 241 (`states.ts breakingUnits`, the 241 where both judges agree) | 241 (143 breaking), states synthesised | Fit `BREAKING_P` |
| HELD-OUT (decision) | `eval/select/holdout/classify/records.json` + `labels/adjudicated.json` | 233 (posthog-js 80, zod 80, uvicorn 40, typer 33) | Scored once per candidate |

Nothing from posthog-js, zod, uvicorn or typer is used for fitting or training. Laravel (85 of the breaking 241) is
used as dev here: it is outside this slice's held-out technologies (the 241 set is named as dev for this slice).

Mapping a model's answers to the held-out schema: `breaking` = p(yes) ≥ `BREAKING_P`; `benefit` = the benefits with
p(yes) ≥ `BENEFIT_P`, else `["none"]`; `change_type` = the choice; `actionable` = surface choice ≠ `runtime_internal`.
An unanswered record (parse failure after the candidate's retries, HTTP failure) is a missing prediction and counted
wrong (`score.py`).

## Candidates

| Id | Model | Path | Notes |
|---|---|---|---|
| J1, J2 | Jev `jev-latest` | `jev.ts` (the pipeline's `Jev` class) | Two fresh held-out runs, each with its own empty cache. **J1 is the baseline**; J2 measures repeatability. One dev run. |
| CF | Cloudflare Clef Flash | Workers AI, if its API can return a choice and a probability per option | Free tier (10,000 neurons/day) |
| G20 | `openai/gpt-oss-20b` | AI Gateway, the pipeline's `CodexClassifier` prompt and parser (`jev.ts chatClassifier`) | Lowest reasoning effort the model accepts |
| G120 | `openai/gpt-oss-120b` | same | same |
| Q | `alibaba/qwen3.8-flash` | same | same (thinking off if accepted) |
| DS | `deepseek/deepseek-v4-flash` | same | same |
| L | Luna `gpt-5.6-luna` | `codex exec` on the user's plan, same prompt and parser | Costed prompt-only at the gateway list price ($0.20 / $1.20) |
| B10 | the chat model (G20, G120, Q, DS) with the best **dev** mean of the three floor metrics' dev analogues (breaking recall, benefit-vs-none recall at the fitted thresholds) | 10 records per call, all questions once, answers per record | Missing records are retried singly (counted as retry cost) |
| ENC | A fine-tuned encoder (ModernBERT-base), one head per question, trained on Jev's stored labels for technologies outside {posthog-js, zod, uvicorn, typer, next, prisma, nestjs, nuxt, laravel} | Local, CPU inference | Imitates Jev: its ceiling is Jev |

`google/gemini-3.1-flash-lite` is not run: its gateway list price ($0.25 / $1.50 per M) is above Luna's ($0.20 /
$1.20), which the brief excludes.

## Process

1. Smoke every candidate on 10 dev records (seed `slice4`): parse rate, tokens (reasoning included), $/record.
2. Dry-run estimate of dev + held-out from the smoke's per-record cost ×1.5. **Abort a candidate whose projected
   dev + held-out cost exceeds $0.80.**
3. Dev run; fit thresholds; then one held-out run per candidate (J: two).
4. Score with `python3 eval/select/holdout/score.py classify` and `compare` (Jev J1 as A).

## Thresholds (fitted on DEV only, per candidate)

Grid 0.05, 0.10, …, 0.95. `BREAKING_P` maximises F2 (recall weighted) of breaking on the 241 dev items; `BENEFIT_P`
(one value for all five benefits, as the pipeline) maximises F2 of benefit-vs-none on the 150 dev items. Ties go to
the value nearest 0.5. Held-out is reported at the fitted thresholds (the decision) and at the default 0.5.

## Metrics (held-out)

- **Floor:** breaking recall; benefit-vs-none recall; actionable recall.
- **Secondary:** breaking precision; benefit-vs-none precision (and per benefit); change_type accuracy; removal +
  deprecation recall (n reported; underpowered by construction, `POWER.md`).
- Parse rate (records answered / records), retries, reasoning tokens.

## Decision rule (as given)

Floor metrics = breaking recall, benefit-vs-none recall, actionable recall. A candidate **passes** if on held-out
each floor metric's point estimate is no more than 5 points below Jev's (J1) AND the paired bootstrap does not show it
significantly worse (95%: the `compare` CI of candidate − Jev lies wholly below 0). Among passers, the **lowest
worst-case cost per technology-year** wins (measured R and S per technology from `cost.mts`; reasoning tokens and
parse-failure retries included). Secondary: breaking precision, benefit precision, change_type accuracy and removal +
deprecation recall (n reported; likely underpowered). If a costlier candidate is significantly better on a floor
metric, the accuracy/cost trade-off is presented instead of a pick. Speed only breaks ties. If held-out power cannot
separate candidates, that is said explicitly.

Sensitivity (reported, not the rule): the same comparison against J2.

## Cost

Per record measured on the held-out run: mean input tokens × input price + mean output tokens (reasoning included) ×
output price, × calls per record (retries). Per technology-year: R × that, with R = 114.6 (mean technology) and
R = 1,092 (the largest technology), from `cost.mts`. Fleet: mean technology × 10k / 50k / 200k. Jev output is free;
Clef Flash's output price is unknown (input $0.038/M). The encoder: $0 on a free CPU runner (records/second
measured).

## Budget

AI Gateway ≤ $3.00 for the whole slice, from this slice's own usage log (`out/slice4/usage.jsonl`) and checked
against the live balance before each run; Jev ≤ $0.50; Cloudflare inside the free 10,000 neurons/day; Luna on the
plan. Per candidate: abort if projected dev + held-out > $0.80.

## Compression arms (written 16 October 2026, before any compression arm was run on dev or held-out)

Question: can step D's fixed question block (about 1,790 of about 2,240 Jev input tokens per record) be shortened
without losing the floor? The model is fixed (Jev); the answer space is unchanged (same 8 question ids and option keys,
`questions.ts`). Measured Jev overhead: about 290 input tokens per call plus about 40 per question, so the floor for
8 questions and a ~150-token state is about 770 tokens per record.

Arms (`eval/select/slice4/questions.ts`, written before any run; not edited after a held-out look):
- **JQ1** `v1`: the pipeline's text, yes/no options that restate the instruction shortened (about 1,570 tokens).
- **JQ2** `v2`: definitions and rubric condensed, every decision boundary kept (about 950 tokens).
- **JQ3** `v3`: glosses of a few words, the rubric in one sentence (about 540 tokens).
- **JS** the cheapest passing JQ arm with the `lean` record state (technology, source and release dropped); run only
  if a JQ arm passes.
- **CF-Q** Clef Flash on the cheapest passing JQ arm (or JQ2 if none passes), free tier.

Process: dev run per arm; thresholds fitted on dev exactly as above (`analyze.fit`); then **one** held-out run per
arm. All three JQ arms get their held-out look regardless of dev (dev has no surface labels, so actionable recall can
only be seen on held-out); this is three looks at H1, stated as a multiplicity caveat.

Decision rule (per arm, against J1 on held-out, at the arm's fitted thresholds):
1. Floor: breaking, benefit-vs-none and actionable recall each no more than 5 points below J1 **and** the paired
   bootstrap CI (arm − J1) not wholly below 0.
2. change_type accuracy and removal + deprecation recall: the paired CI not wholly below 0 (n for obligations is 12,
   reported as underpowered).
3. Among passers, the lowest measured $/technology-year (R = 114.6 mean, 1,092 max) wins; fleet at 10k/50k/200k.
Reported, not the rule: the same at the live 0.5 thresholds, and against J2.

Budget: Jev ≤ $0.60 for these arms (on top of the slice's earlier $0.083); Cloudflare free tier; no gateway spend.

## Confirm H on H2 (written 16 October 2026, before any classifier run on these records)

Question: does question block H (`questions.ts` `h`; built after three looks at H1, so its H1 result is post-hoc) hold
breaking on records it was never designed against? JQ1 (`v1`) runs too, as the safe fallback.

Data: held-out set 2 (`holdout-majors`, guides and major notes of SvelteKit 3, MSW 3, transformers 5, mypy 2).
Records: slice 3b's gpt-6-luna two-call H2 run (`out/slice3b/runs/vercel_openai_gpt-6-luna-two-call-heldout2`, 441
records), state from the pipeline's own `recordState`. Each record takes its reference from the adjudicated group the
scorer's precision matching (`score.py` `match_note`, groups capped at their item count) credits it to:
- `breaking` = the group's `breaking` (any item breaking).
- Excluded and counted: records credited to no group, and records whose group is `unsure`.
- Secondary, descriptive only (not the rule): obligation recall = among records whose group has a `removal` or
  `deprecation` item, the share the classifier answers `removal` or `deprecation`; change_type agreement = the answer is
  one of the group's item change_types. Benefit and actionable have no H2 reference: H's benefit questions are v1's
  (passed pre-registered in JQ1), and H's actionable result rests on H1 only.

Arms: J1 (pipeline `labelQuestions()`), H, JQ1; Jev; same records; one run each, after a smoke on 10 records.

Rule, at the live 0.5 threshold (breaking = P(yes) ≥ 0.5), H against J1:
1. Breaking recall: the paired difference's 95% section-cluster bootstrap CI not wholly below 0, McNemar reported.
2. Breaking precision: the same.
H passes if both hold. Fitted thresholds are not used (slice 4: not shippable). If H fails, JQ1 is judged by the same rule.

Caveats stated up front: records come from one extractor run (gpt-6-luna), so references inherit its record split;
the breaking flag is group-level (a non-breaking record inside a breaking group counts as breaking); references are
Claude-made, as for H1.

Budget: Jev ≤ $0.25 for this section; no gateway, no Cloudflare.
