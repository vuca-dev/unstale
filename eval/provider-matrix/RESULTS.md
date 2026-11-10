# Provider matrix results: which model each key should use, per step

10 November 2026, under `PREREG.md` (commit 43b208c, pushed before any candidate call on a dev or held-out unit). One
look per held-out set. Raw output is under `eval/select/out/` (gitignored): `provider-matrix/`, `slice4/runs/`,
`slice5/runs/`.

## Decision: picker order per key type

| Key | A+B extraction | D record labels | E same-or-new judge |
|---|---|---|---|
| **Jev** | Jev cannot generate records: pair it with a generative key (OpenAI or gateway row) | **1. Jev** ($0.0100) | **1. Jev** ($0.0081, Q8 with C′ constants) |
| **OpenAI** | **1. gpt-6-luna `low`**, direct ($0.0183 list) | Nothing passes. 1. gpt-6-luna chat, below floor (H2 breaking precision −6.2 at its fitted 0.05 only; $0.0430 list). 2. Decisions API, below floor (H1 benefit recall; $0.0239) | Nothing passes. 1. gpt-6-luna chat, below floor (holds 0.9 per 100, recall 80.2% against 88.8%; $0.0455 list). 2. Decisions API (2.0 per 100, recall 73.1%; $0.0170). 3. Never merge |
| **Anthropic** | Nothing passes. Haiku 5.5 `none`, below floor ($0.0189; H2 required −9.0). `low` fails DEV (52/61) | Nothing passes. Haiku 5.5, below floor ($0.0564; breaking and benefit recall) | Nothing passes. Haiku 5.5, below floor (recall 38.6%; $0.0573). Never merge is the honest default |
| **Gateway / OpenRouter** | **1. `openai/gpt-6-luna` `low`, flex** ($0.0096; $0.0192 list) | **1. DeepSeek V4 Flash** ($0.0410). **2. Qwen3.8 Flash** ($0.0630). Below floor: gpt-6-luna chat ($0.0249 at flex) | Nothing passes. 1. gpt-6-luna chat, below floor ($0.0269 at flex). 2. Never merge |

Costs are $ per mean technology-year, worst case (formulas in `PREREG.md`); × 10,000 for 10k technologies.

- **Only Jev holds D and E.** No OpenAI or Anthropic route passes either step under the pre-registered rules. A user
  without Jev either takes a below-floor judge (more false merges or fewer merges) or never-merge (22.7 duplicates per
  100 records), and pays 2.5–5.6× Jev's price for D.
- **gpt-6-luna chat is the best non-Jev classifier, and the D verdict hangs on the threshold.** It fails D only at
  the threshold fitted on stated probabilities (0.05). At its choices (0.5), which is how production's fallback reads a
  chat answer, it is level with or above Jev at 0.5 on every metric: H1 breaking 86.2 / benefit 97.5 / actionable 87.7
  against 82.8 / 85.1 / 84.9; H2 breaking R 92.6 and P 93.0 against 90.0 and 94.5, both CIs spanning 0. That is
  descriptive, not the rule. It is the one cell worth a pre-registered choice-only re-test.
- **The gateway's D passers (DeepSeek, Qwen) are slice 4 results** on the older wording, also at fitted thresholds on
  stated probabilities, which `RESULTS-choice.md` says overstate recall. Treat their order over gpt-6-luna chat as weak.
- **An Anthropic-only key has no passing cell on any step.** Haiku 5.5 is close on short notes (H1 −5.8 pooled) and
  loses guides (H2 −13.5 on guide groups). The picker should say so and recommend a second key; if the user declines,
  run Haiku with the "below floor" label and never-merge for E.
- **OpenRouter was not measured** (no key configured). It serves the same model ids as the gateway; until a cell is
  measured, order it as the gateway row and run a parity check before claiming the gateway's numbers.

## The matrix

Rows: provider and model. Each step cell: verdict against that step's floor, then $ per mean technology-year. "—" = not
measured. **Bold** = measured in this slice. Sources: slice 3 / 3b / 3e / 3f / 10 / 11 / 12 (A+B), slice 4 and 14 (D),
slice 5 and 14 (E).

| Route / model | A+B | D | E |
|---|---|---|---|
| Jev (`jev-latest`) | n/a (classifier) | pass, $0.0100 (v1 wording) | pass, $0.0141 (F8, J1 0.8/100); $0.0081 Q8 (1.14 needs C′, slice 17) |
| **OpenAI Decisions API, gpt-6-luna** | n/a (classifier) | **fail** (H1 benefit −3.3, CI −6.6…−0.8), **$0.0239** | **fail** (2.0/100, recall 73.1% vs 91.9%), **$0.0170** |
| Gateway `openai/gpt-6-luna` `low` | pass (production), $0.0192 list / $0.0096 flex | **fail** (H1 pass; H2 breaking P −6.2 at fitted 0.05), **$0.0430 list / $0.0249 flex** | **fail** (0.9/100 holds; recall 80.2%, p 5e-4), **$0.0455 list / $0.0269 flex** |
| **OpenAI direct `gpt-6-luna` `low`** | **same model; H1 within noise** (see below), **$0.0183** list | — | — |
| **Gateway `anthropic/claude-haiku-5.5` `none`** | **fail** (DEV pass 56/61; H2 required −9.0, CI −18.6…−1.1), **$0.0189** | **fail** (H1 breaking −10.3, benefit −5.8), **$0.0564** | **fail** (recall 38.6%, p 3e-30), **$0.0573** |
| **Gateway `anthropic/claude-haiku-5.5` `low`** | **fail** (DEV 52/61) | — | — |
| Luna 5.6 via Codex (prompt-only, list) | baseline before 16 Oct; H2 −19…−25 vs gpt-6-luna, $0.0481 | pass, $0.1068 | fail (2.4/100), $0.0962 |
| OpenAI direct `gpt-5.6-luna` | DEV pass, H2 fail (−41…−45) | — | — |
| OpenAI `gpt-5.4-mini`, `gpt-5-mini` (±strict) | fail DEV (42–55/61) | — | — |
| Gateway `gpt-5-nano` | fail H1 (−23.6), $0.0095 | — | — |
| Gateway `alibaba/qwen3.8-flash` | H1 pass; H2 −26.7 vs gpt-6-luna (rejected), $0.0186 | pass, $0.0630 | fail (recall 75.6%), $0.0630 |
| Gateway `deepseek/deepseek-v4-flash` | fail (H1 macro −35.9), $0.0113 | pass, $0.0410 | fail (5.8/100), $0.0465 |
| Gateway `openai/gpt-oss-120b` | fail, $0.0159 | fail (benefit, actionable), $0.0631 | — |
| Gateway `openai/gpt-oss-20b` | fail, $0.0035 | fail (benefit, actionable), $0.0132 | fail (recall 74.6%), $0.0131 |
| Gateway qwen3.7-flash, glm-4.7-flash, nemotron-3.5-lightning | fail H1, $0.0071–0.0117 | — | — |
| Gateway minimax-m3.1-flash (free) | fail (DEV 55; r3 prompt: precision −18 to −22) | — | — |
| Gateway beam-free, ling-3.0-flash, mercury-2.5, mistral-nemo | fail (DEV or held-out) | — | — |
| SubQ Snap preview / 1.1 | n/a | fail (H2 precision / H1 actionable), $0.0095 / $0.0072 | fail (recall 42.1% / 26.9%), $0.0059 (1.1) |
| Cloudflare Clef Flash | n/a | fail (actionable −13.7), $0.0093 (free tier) | — |
| ModernBERT encoder (Jev-distilled) | n/a | fail (actionable −13.7), $0 | — |
| Embedding cosine (qwen3-embedding-0.6b) | n/a | — | fail (recall 50.3%), $0.0002 |
| Never merge | — | — | no false merges, 22.7 duplicates per 100 records, $0 |

## This slice's runs

### A+B: Claude Haiku 5.5 (gateway), and gpt-6-luna on a second route

| Arm | DEV required / fetched sources (gate 56 / 83) | H1 pooled / macro / breaking / precision (Δ vs gpt-6-luna) | H2 required / breaking / precision (Δ) | $ / tech-year |
|---|---|---|---|---|
| gpt-6-luna `low`, gateway (baseline, reproduced) | 59 / 87 | 66.3 / 91.9 / 82.9 / 82.0 | 88.7 / 86.4 / 84.8 | $0.0192 |
| Haiku `none` | 56 / 84, 0 failed chunks: **pass** | 60.5 (**−5.8**, CI −10.7…+1.6) / 87.0 (−4.9, **CI −10.0…−0.8**) / 82.9 (0) / 79.5 | 79.6 (**−9.0, CI −18.6…−1.1**) / 78.9 (**−7.5, CI −16.2…−0.5**) / 89.2 (+4.3) | $0.0189 |
| Haiku `low` | 52 / 83: **fail** | not run | not run | — |
| gpt-6-luna direct (OpenAI API) | — | 66.3 (0) / 92.5 (+0.6) / 74.3 (**−8.6**, CI −16.3…0.0) / 83.2 | not run | $0.0183 |

- **Haiku loses guides.** Guide group recall 68.4 against 81.9 (−13.5); major notes are level (−1.6). On H1 it
  writes 205 records against 222; precision on H2 is higher (+4.3), the usual small-model pattern of fewer, safer records.
- **The two gpt-6-luna routes agree within run-to-run noise.** Direct misses the H1 breaking margin by the letter
  (3 of 35 breaking groups, McNemar p 0.25), but the gateway's own replicate differs from its first run by 7 discordant
  breaking groups (+2.9) and from the direct run by −11.4. Pooled and macro recall are equal. Same model, same
  prompts: the route does not change quality. Direct costs list price; only the gateway serves flex (50%).

### D: Decisions API, Haiku, gpt-6-luna chat (H1 233 records; Jev v1 at its fitted 0.05 / 0.10)

| Arm (fitted BREAKING_P / BENEFIT_P) | Breaking R | Benefit R | Actionable R | Breaking P | change_type | At 0.5: breaking R / P, benefit R | Floor | In / out tokens per record | $ / tech-year |
|---|---|---|---|---|---|---|---|---|---|
| Jev v1 (baseline, reproduced) | 93.1 | 99.2 | 84.9 | 38.6 | 82.0 | 82.8 / 75.0, 85.1 | — | 2,074 / 0 | $0.0100 |
| Decisions gpt-6-luna (0.10 / 0.40) | 100 (+6.9) | 95.9 (**−3.3, CI −6.6…−0.8**) | 83.6 (−1.4) | 24.0 | 79.0 | 96.6 / 33.7, 95.0 | **fail** | 2,086 / 0 | $0.0239 |
| Haiku 5.5 `none` (0.30 / 0.50) | 82.8 (**−10.3**) | 93.4 (**−5.8, CI −9.9…−1.7**) | 82.2 (−2.7) | 82.8 | 71.2 | 82.8 / 92.3, 93.4 | **fail** | 2,520 / 481 | $0.0564 |
| gpt-6-luna chat `low` (0.05 / 0.10) | 100 (+6.9) | 98.3 (−0.8) | 87.7 (+2.7) | 42.6 | 85.0 | 86.2 / 65.8, 97.5 | H1 pass; **H2 fail** | 1,668 / 417 (100 reasoning) | $0.0430 list ($0.0249 billed, mostly flex) |

H2 (347 records, breaking against Jev v1 at 0.5, section-cluster CI): gpt-6-luna chat at its fitted 0.05 has recall 98.3
(+8.3, CI +5.1…+12.1) and precision 88.3 (**−6.2, CI −11.8…−2.2**), so it fails. At 0.5: recall 92.6 (+2.6, CI −1.8…+5.7),
precision 93.0 (−1.5, CI −5.0…+0.9).

- **The decision model is not a drop-in Jev.** Same request shape, and its probabilities are graded, but it misses
  benefits Jev finds and over-flags breaking at 0.5 (precision 33.7 against Jev's 75.0). It also costs 2.4× Jev:
  $0.10 against $0.042 per M input on the same token count.
- **Haiku at 0.5 is the most precise breaking labeller here** (92.3), but its change_type accuracy is 10.8 points below
  Jev, and at its fitted thresholds it fails breaking and benefit recall. The chat arms' stated probabilities carry
  nothing beyond the choice (slice 4 `RESULTS-choice.md`), so the 0.5 column is the honest view of a chat arm.

### E: Decisions API (Q8, against fresh Jev Q8) and chat arms (F8, against J1)

| Arm | Fitted same / cross / quote | HO guarded false / 100 [95% CI] | Merge recall | McNemar vs baseline | Fallback rule (choice + near-identical quote): false / recall | $ / tech-year |
|---|---|---|---|---|---|---|
| Jev 1.14 Q8, fresh (baseline) | 0.87 / 0.87 / 0.95 | 2.1 [1.2–6.9] | 181/197 = 91.9% | — | — | $0.0081 |
| Jev 1.14 Q8 at production's C′ (0.82 / 0.91 / 0.99), descriptive | — | 1.4 [0.6–5.7] | 171/197 = 86.8% | — | — | |
| Decisions gpt-6-luna Q8 | 0.90 / 0.94 / 1.01 | **2.0** [1.1–7.7] | 144/197 = **73.1%** | 40 vs 3, p 3e-9 | — | $0.0170 |
| Decisions at C′, descriptive | — | 1.8 [1.0–6.9] | 161/197 = 81.7% | | | |
| J1 Jev 1.13 F8 (slice 5, reproduced) | 0.73 / 0.89 / 0.99 | 0.8 [0.3–4.8] | 175/197 = 88.8% | — | 0.0 / 74.1% | $0.0141 |
| Haiku 5.5 `none` F8 | 0.88 / 0.90 / 1.01 | 0.0 [0.0–4.7] | 76/197 = **38.6%** | 99 vs 0, p 3e-30 | 0.0 / 65.0% | $0.0573 |
| gpt-6-luna chat `low` F8 | 0.82 / 0.97 / 1.01 | 0.9 [0.4–5.3] | 158/197 = **80.2%** | 20 vs 3, p 5e-4 | 0.0 / 72.1% | $0.0455 list ($0.0269 flex) |

- **The decision model fails both conditions:** it does not hold the floor at its fitted constants, and it loses 18.8
  points of recall against Jev.
- **Jev 1.14 on a fresh Q8 run** misses the floor at its own dev fit (2.1) and sits at 1.4 at production's C′. This is
  the drift slices 15–17 found; one false merge moves the rate by about 0.6, so 1.4 against slice 17's pass is within
  one merge. Not this slice's decision; noted for the next judge refit.

## Spend (all priced from the providers' usage; logs in `eval/select/out/`)

| Provider / model | Calls | Input / output (reasoning) tokens | $ |
|---|---|---|---|
| Gateway `anthropic/claude-haiku-5.5` (A+B ×4 runs, D, E) | 1,166 | 3.68M / 0.77M (70k) | $0.752 |
| Gateway `openai/gpt-6-luna` chat (D, E; billed mostly at flex) | 1,368 | 2.55M / 0.50M (118k) | $0.295 |
| Gateway `alibaba/qwen3.8-flash` (prompt-identity check) | 5 | 13k / 2k | $0.003 |
| OpenAI Decisions API `gpt-6-luna` (D, E) | 1,021 | 1.89M / 0 | $0.189 |
| OpenAI API `gpt-6-luna` (A+B H1, direct) | 84 | 171k / 50k (18k) | $0.042 |
| Jev (fresh Q8 baselines) | 362 | 593k / 50k | $0.025 |
| **Total** | | | **$1.31** (gateway balance $4.45 → $3.39) |

## Not run, and why

- **OpenRouter:** no key configured. **Anthropic API directly:** no key; the gateway stands for it (same model id).
- **Codex and Cursor CLI cells:** out of scope (another experiment).
- **Decisions API on D H2, Haiku on D H2, Haiku `low` held-out:** pre-registered to run only after a first-stage pass.
- **Repeat runs:** none (budget); each arm is one look, with the baselines' replicate spread as the noise reference.

## Candidates worth a cell later (proposed, not run)

- **gpt-6-luna chat on D, choice-only, pre-registered at 0.5** on H1 and H2 (no new calls are needed for this slice's
  answers, but a fresh run on production's choices-only prompt is the faithful test). The most likely way an OpenAI
  key gets a passing D cell.
- **Haiku 5.5 `low` on D and E.** Reasoning may recover change_type and judge recall, at about 2× the output cost; a
  pass would give the Anthropic key a classifier, still at about 5× Jev.
- **Gemini 2.5 Flash-Lite** (`google/gemini-2.5-flash-lite`, $0.10 / $0.40): priced at gpt-6-luna's level and not
  yet measured (slice 3 tried only 3.1 Flash-Lite, which costs more than Luna). The cell a Google-only key would need.
- **gpt-6-luna on the Batch API** for A+B onboarding: same model at 50%, matching flex; a parity check, not a new model.

## Evalisms

- Chat arms are judged by fitted rules on stated probabilities, as every earlier chat cell was (`PREREG.md`); the
  0.5 and fallback-rule columns are the production view.
- The E chat arms see F8 requests (slice 5's) while the decision model sees Q8 (production's today); each is compared
  with the Jev run on the same requests.
- `score5.mts`'s pick check now differs from `match.ts` on 12 of 365 items (4 in slice 14): the guards moved since slice
  5. It applies to every arm alike.
- H1 has 29 breaking records in D and 35 breaking groups in A+B: one record is 3.4 and 2.9 points.
- References are Claude-labelled; Haiku is a Claude model. Its scores could carry a shared-style bonus; none is visible
  (it is the arm furthest below the references on recall).
