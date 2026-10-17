# Slice 4b: compressing step D's question block (Jev; Clef re-run)

16 October 2026. Pre-registration: `PREREG.md`, § "Compression arms" (written before any arm ran). Arms:
`questions.ts`; runner `run4.mts --qv <arm> [--sv lean]`; analysis `analyze_compress.py` →
`out/slice4/compress-report.json`. Held-out: H1 classifier set (233 records, 29 breaking). Baseline J1 reproduced from
cache before any run: breaking 93.1, benefit 99.2, actionable 83.6, the same as `RESULTS.md`.

## Verdict

- **Production pick: H, v3's change_type, surface and breaking questions plus v1's benefit questions.**
  - Cost: 1,622 Jev input tokens per record against 2,241, which is **−28%**: $0.0078 per technology-year, **$78 / $390 /
    $1,562** at 10k / 50k / 200k (J1: $108 / $539 / $2,158).
  - At the live 0.5 thresholds, which is what the pipeline ships, it matches J1 on every floor metric.
  - **It is post-hoc.** It was built from dev evidence after the three pre-registered held-out looks, so it is the
    fourth look at H1. Each of its parts did pass in a pre-registered arm: v1's benefit questions in JQ1, and v3's
    other questions in JQ3 (breaking, actionable and change_type, at both thresholds).
- **Pre-registered winner: JQ3 (v3, −47%, $57 per 10k).** It passes only at its fitted `BENEFIT_P` = 0.05, which
  slice 4 said not to ship because the dev prevalence was skewed. At the live 0.5 thresholds its benefit-vs-none recall
  falls 11.6 points (CI −17.4…−6.6). Dev showed the same drop before any held-out look (0.70 against 0.78).
  **Adopt v3's benefit questions only together with a `BENEFIT_P` refit on a dev set with realistic prevalence.**
- **Safe minimum: JQ1 (v1, −7.5%).** It passes at both thresholds, with no loss anywhere.
- **Rejected:**
  - **JQ2 (v2).** Actionable recall −11.0 (CI −20.5…−2.7) and benefit recall −3.3, both significant. This is
    non-monotone: v3 is shorter and holds actionable recall, so surface answers are sensitive to wording, not only to
    length.
  - **Lean record state** (technology, source and release dropped). It saves about 30 tokens per record (−2.7%) and
    costs 5.0 points of benefit recall (significant).
  - **Clef Flash on v3.** The sharper prompt narrows its actionable gap from −13.7 to −6.8 (CI −13.7…0.0), still more
    than 5 points below J1. Change_type is still significantly worse (−13.7). At 0.5, breaking recall falls to 48.3.
    The answer for Clef is unchanged: it fails.

## Held-out (H1), at fitted thresholds (the pre-registered rule)

| Arm | Question tokens (chars/4) | Jev input per record | BREAKING_P / BENEFIT_P | Breaking R | Benefit R | Actionable R | Breaking P | Benefit P | change_type | Removal+deprecation R (n 12) | $/technology-year (mean / max) | 10k / 50k / 200k | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| J1 (base) | 1,792 | 2,241 | 0.05 / 0.10 | 93.1 | 99.2 | 83.6 | 36.0 | 70.2 | 81.1 | 91.7 | 0.0108 / 0.103 | $108 / $539 / $2,158 | baseline |
| JQ1 v1 | 1,566 | 2,074 | 0.05 / 0.10 | 93.1 | 99.2 | 84.9 | 38.6 | 69.0 | 82.0 | 91.7 | 0.0100 / 0.095 | $100 / $499 / $1,997 | pass |
| JQ2 v2 | 952 | 1,547 | 0.05 / 0.05 | 93.1 | 95.9 | **72.6** | 40.9 | 65.5 | 83.3 | 100 | 0.0074 / 0.071 | $74 / $372 / $1,489 | **fail** (actionable −11.0, benefit −3.3, both significant) |
| JQ3 v3 | 540 | 1,194 | 0.15 / 0.05 | 93.1 | 97.5 | 80.8 | 45.8 | 69.4 | 82.0 | 91.7 | 0.0057 / 0.055 | $57 / $287 / $1,150 | pass (fitted thresholds only) |
| JS v3 + lean state | 540 | 1,163 | 0.10 / 0.05 | 96.6 | 94.2 | 89.0 | 29.8 | 69.1 | 78.1 | 100 | 0.0056 / 0.053 | $56 / $280 / $1,119 | **fail** (benefit −5.0, significant) |
| CF-Q Clef v3 | 540 | 1,131 | 0.10 / 0.10 | 93.1 | 98.3 | **76.7** | 40.9 | 59.5 | **67.4** | 91.7 | 0.0049 (input-only list price; free tier) | $49 / $246 / $985 | **fail** (actionable more than 5 points below; change_type −13.7, significant) |
| Clef base (slice 4) | 1,792 | 2,141 | 0.10 / 0.10 | 96.6 | 96.7 | 69.9 | 32.6 | 58.8 | 68.7 | 91.7 | 0.0093 | $93 / $466 / $1,864 | fail |
| **H hybrid (post-hoc)** | 1,035 | 1,622 | 0.20 / 0.05 | 89.7 | 99.2 | 82.2 | 53.1 | 65.9 | 82.4 | 100 | 0.0078 / 0.074 | **$78 / $390 / $1,562** | passes the rule (descriptive) |

Paired difference against J1 (95% CI), fitted thresholds:

| Arm | Breaking R | Benefit R | Actionable R | change_type | Removal+deprecation R |
|---|---|---|---|---|---|
| JQ1 | 0.0 | 0.0 | +1.4 [0.0, +4.1] | +0.9 [−1.3, +3.0] | 0.0 |
| JQ2 | 0.0 [−10.3, +10.3] | −3.3 [−6.6, −0.8] | −11.0 [−20.5, −2.7] | +2.1 [0.0, +4.7] | +8.3 |
| JQ3 | 0.0 | −1.7 [−4.1, 0.0] | −2.7 [−11.0, +4.1] | +0.9 [−2.6, +4.3] | 0.0 |
| JS | +3.4 | −5.0 [−9.1, −1.7] | +5.5 [−1.4, +12.3] | −3.0 [−7.3, +1.3] | +8.3 |
| CF-Q | 0.0 [−10.3, +10.3] | −0.8 [−2.5, 0.0] | −6.8 [−13.7, 0.0] | −13.7 [−19.7, −7.7] | 0.0 |
| H | −3.4 [−10.3, 0.0] | 0.0 | −1.4 [−9.6, +6.8] | +1.3 [−2.1, +5.2] | +8.3 |

## At the live 0.5 thresholds (what the pipeline ships)

| Arm | Breaking R | Benefit R | Actionable R | Breaking P | Benefit P | change_type | Benefit R against J1 at 0.5 |
|---|---|---|---|---|---|---|---|
| J1 | 82.8 | 86.8 | 83.6 | 77.4 | 84.0 | 81.1 | — |
| JQ1 | 82.8 | 85.1 | 84.9 | 75.0 | 84.4 | 82.0 | −1.7 [−5.0, +1.7] |
| JQ2 | 82.8 | 82.6 | 72.6 | 92.3 | 79.4 | 83.3 | −4.1 [−8.3, 0.0] |
| JQ3 | 82.8 | **75.2** | 80.8 | 72.7 | 86.7 | 82.0 | **−11.6 [−17.4, −6.6]** |
| **H** | **82.8** | **86.8** | 82.2 | 70.6 | 86.8 | 82.4 | **0.0 [−2.5, +2.5]** (actionable −1.4 [−9.6, +6.8]) |
| CF-Q Clef v3 | 48.3 | 63.6 | 76.7 | 82.4 | 84.6 | 67.4 | −23.1 |

Dev (fitted thresholds; F2 breaking / benefit; recall at 0.5, breaking / benefit):
- J1: 0.962 / 0.943; 0.853 / 0.783.
- v1: 0.962 / 0.936; 0.853 / 0.807.
- v2: 0.962 / 0.943; 0.825 / 0.795.
- v3: 0.959 / 0.900; 0.867 / **0.699**.
- H: 0.962 / 0.932; 0.874 / 0.783.

## Where the tokens go
- **Jev overhead (measured):** about 290 input tokens per call plus about 40 per question, so with 8 questions and a
  state of about 150 tokens, the floor is about 770 tokens per record.
- **Question block:** the base block is about 1,800 tokens; v3's is about 540.
- **Benefit questions:** the five of them are most of what is left in H, because each repeats `BENEFIT_RULE`. Jev has
  no field for shared instructions, so the rule cannot be stated once.

## Caveats
- **Four looks at H1:** three pre-registered and one post-hoc (H). No arm was edited after a look.
- **Small samples:**
  - H1 has 29 breaking records, so a single record moves breaking recall by 3.4 points; H's −3.4 at fitted thresholds
    is one record.
  - Removal plus deprecation has n = 12.
- **Prompt sensitivity:** the result is non-monotone in prompt length (v2 fails where v3 passes). Surface answers depend
  on the exact wording, so H's actionable result (−1.4, CI −9.6…+6.8) should be confirmed on the next held-out set.
- **Thresholds:** the fitted values are still not shippable, for the skewed-dev-prevalence reason in `RESULTS.md`. The
  production comparison is the 0.5 table.
- **Unchanged from slice 4:** the references are Claude-made and the adjudicator sided with A more often.

## Spend
- **Jev:** $0.207 for these arms, $0.29 for slice 4 in all.
- **Cloudflare:** about 0.79M input tokens for Clef, inside the free tier.
- **Gateway:** $0.

## Recommended production question block (H)

Same ids and option keys as `labelQuestions()`. The benefit questions keep `BENEFIT_DEFS` and `BENEFIT_RULE` from
`vocab.ts` unchanged.

```ts
change_type: { instructions: "Kind of change?", options: {
  new_api: "New API, command or file convention.", new_option: "New option on something existing.",
  behavior_change: "Existing behaviour changed.", default_change: "A default changed.", fix: "Bug fix.",
  deprecation: "Deprecated, still works.", removal: "Removed or support dropped.",
  stability_change: "Stability level changed.", performance: "Faster or lighter.",
  security: "Security fix or hardening.", tooling: "Developer tooling.", other: "Other." } },
surface: { instructions: "Where does a project meet this change?", options: {
  code_api: "Application code.", configuration: "Configuration.", file_convention: "File or directory convention.",
  command_line: "Command line.", schema_or_migration: "Schema or migration.", types_only: "Types only.",
  runtime_internal: "Run-time behaviour only; nothing to write.", build_tooling: "Build output.", other: "Other." } },
breaking: { instructions: "Breaking: would an unchanged project that worked before fail or behave noticeably differently after upgrading (removals and raised minimum versions count; deprecations, new options and fixes do not)?",
  options: { yes: "Yes.", no: "No." } },
// for each b of BENEFITS:
[`benefit_${b}`]: { instructions: `Does this change bring a ${b} benefit? ${b}: ${BENEFIT_DEFS[b]} ${BENEFIT_RULE}`,
  options: { yes: "Yes.", no: "No." } },
```

`BREAKING_RUBRIC` is used only by `labels.ts`, so it falls out of use under H. `CHANGE_TYPES` and `SURFACES` in
`vocab.ts` stay unchanged for the extraction prompt; the short glosses belong in `labels.ts`.
