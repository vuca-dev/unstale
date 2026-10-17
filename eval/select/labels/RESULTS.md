# Label fields (step B) on gpt-6-luna: reference set, prompt variants, input diet

16 October 2026. Pre-registration: `PREREG.md` (written before the reference set was scored). Model:
`vercel:openai/gpt-6-luna`, reasoning `low`, two calls (cost levers #5 and #6).

## Verdicts

| Experiment | Verdict | Why |
|---|---|---|
| #5a label-field reference set | **Built.** 663 records, adequately powered for `replaces` (218 positive records) and borderline for `requires` (37). `prerequisites` (19) and `conditions` (11) are underpowered | See Power |
| gpt-6-luna against Luna 5.6 on labels | **gpt-6-luna is better** (supports the A + B switch) | Same records and prompt. Luna: conditions presence precision 0.15 against 0.78 (−0.63, CI −0.95…−0.33), terms loose precision −0.14 (CI −0.21…−0.07), requires precision 0.27 against 0.76 (not significant: 37 positives, chunk clustering) |
| The "conditions gap" (gpt-6-luna 5.9% of gate records against Luna's 11–12%) | **Not a recall loss** | On identical records the reference marks 1.7% of records; gpt-6-luna marks 1.4%, Luna 9%, at 15% precision. Luna's higher fill is mostly wrong phrases ("config files must not contain sensitive information", "projects using app route handlers") |
| #5b v1: `replaces` lists each spelling of the obsolete literal | **Fail** | replaces recall +0.04 (CI −0.03…+0.09), precision −0.08 (CI −0.10…−0.02) |
| #5b v2: `requires` names integrations the notes scope a change to ("on the Kafka transport") | **Fail** (rule: target recall must rise with CI above 0) | requires recall +0.05 (CI −0.06…+0.27); precision +0.21 (CI +0.01…+0.58), but the unchanged prompt run twice already moves requires precision +0.16 (G0r) |
| #5b v3: v1 + v2 | **Fail** | No significant gain; replaces precision −0.06 (CI −0.09…0.00) |
| #5b conditions hill-climb | **Not run as a hill-climb: underpowered and ill-defined** | 11 reference positives. The two blind labelers agree on 1 of the 15 records where either gives a condition; the field's definition does not pin down what belongs in it |
| #6 section diet (only sections holding evidence) | **Fail, and no saving** | The prompt is only 5% shorter: extraction is exhaustive, so nearly every section holds a record; H2 keeps 100% of its notes. requires recall −0.18 (CI −0.50…−0.03) |
| #6b evidence-only label input (no notes; section heading in the brief) | **Fail** | The prompt is 42% shorter, and input tokens −42%. But requires recall −0.11 (CI −0.36…+0.05), past the 5-point rule; conditions collapses (presence recall −0.55, CI −0.86…−0.14; underpowered, so descriptive). Saving if it had passed: about $16 / $81 / $323 per year at 10k / 50k / 200k technologies (−8% of A + B) |

**Production change recommended: none to the label call.** Keep `LABEL_PROMPT` and full chunk notes. The switch of
A + B to gpt-6-luna improves label precision against Luna. Before any further `conditions` work, its definition needs a
product decision (what an agent should do with it), and the set needs a sample rich in conditions (guides, docs pages,
database and platform notes).

## Baselines and arms (all records; item recall / precision, then presence recall / precision)

| Arm | replaces | requires | prerequisites | conditions | terms core R / loose P | $ this run |
|---|---|---|---|---|---|---|
| G0 gpt-6-luna (slice 3b answers) | 0.55 / 0.74 (0.84 / 0.86) | 0.66 / 0.76 (0.68 / 0.76) | 0.89 / 1.00 | 0.58 / 0.70 (0.64 / 0.78) | 0.47 / 0.70 | cached |
| G0r same prompt, repeat | 0.56 / 0.75 | 0.58 / 0.92 | 0.84 / 1.00 | 0.42 / 0.71 | 0.50 / 0.69 | $0.043 |
| L Luna 5.6 (Codex) | 0.54 / 0.73 | 0.32 / 0.27 (0.73 / 0.61) | 0.89 / 0.85 | 0.42 / 0.15 (0.45 / 0.15) | 0.43 / 0.56 | plan |
| v1 replaces spellings | 0.59 / 0.66 | 0.55 / 0.81 | 0.79 / 1.00 | 0.17 / 0.67 | 0.45 / 0.69 | $0.043 |
| v2 requires scoping | 0.53 / 0.74 | 0.71 / 0.96 | 0.84 / 0.94 | 0.50 / 0.75 | 0.45 / 0.67 | $0.042 |
| v3 v1 + v2 | 0.59 / 0.68 | 0.63 / 0.96 | 0.84 / 1.00 | 0.42 / 0.42 | 0.46 / 0.68 | $0.044 |
| #6 section diet | 0.53 / 0.70 | 0.47 / 0.78 | 0.89 / 1.00 | 0.50 / 0.67 | 0.50 / 0.72 | $0.043 |
| #6b evidence only | 0.53 / 0.77 | 0.55 / 0.91 | 0.95 / 1.00 | 0.08 / 0.20 | 0.47 / 0.68 | $0.035 |

- **Noise floor.** G0 against G0r differs by up to 8 points on requires recall and 16 on its precision (neither
  significant). Single-run differences on `requires` smaller than this are noise.
- **H1 against H2.** On short notes (H1) `requires` recall is 0.21 (13 reference records). Most of the set's `requires`,
  `replaces` and `prerequisites` positives come from the guides and major notes (H2).
- **`replaces` item recall (0.55) is low against an exhaustive reference.** Presence recall is 0.84; the reference lists
  more spellings per record (`data-sveltekit-preload-data="off"` and two siblings against `off`). Scoring is exact
  match after normalisation, as pre-registered, so partial spellings (`.words(` against `words`) count as misses.

## Power

| Field | Reference records (H1 / H2) | Items | Labelers agree (where either gives a value) | Status |
|---|---|---|---|---|
| replaces | 218 (6 / 212) | 306 | 134 / 272 | adequate |
| requires | 37 (13 / 24) | 38 | 21 / 38 | borderline: ±0.15–0.30 CIs |
| prerequisites | 19 (4 / 15) | 19 | 16 / 23 | underpowered |
| conditions | 11 (5 / 6) | 12 | 1 / 15 | underpowered, and the definition is unstable |

To detect a 10-point change in `requires` or `conditions` recall needs about 150–200 positive records. At the observed
rates (5.6% and 1.7% of records) that means 3,000–10,000 records of this mix, or a targeted sample.

## Set construction

- **Records:** gpt-6-luna's slice 3b extractions of H1 (41 chunks, 222 records) and H2 (7 chunks, 441 records), via
  `items.mts`. Every arm labels the same records.
- **Labelers:** A = Opus and B = Sonnet, through `claude -p` with no tools, given `LABEL_PROMPT` plus a "gold standard,
  be precise" preface. 70 batches of at most 20 records each; no failures after a tolerant JSON parse (Sonnet wrote
  `"\.safeParse("`).
- **Adjudication:** disputes on 176 of 2,652 record fields (6.6%). An Opus adjudicator saw the answers as "Annotator
  1/2" in hash order. **It sided with A (Opus) 129 times, with B 34, other 13**: a strong same-model lean, or Opus being
  better; the set cannot tell which.

## Cost model

- **Shares.** On the held-out sets, A + B with gpt-6-luna costs $0.0897 per run of both sets. The label call is $0.0385
  of that (43%), and its input $0.018 (20%).
- **#6b.** Evidence-only cut the label call's cost 18% (input −42%, output +8%): −8.4% of A + B, or −$16 / −$81 / −$323
  per year at 10k / 50k / 200k technologies against $192 / $960 / $3,840. It fails on quality, so the saving is not
  available.
- **#6.** No measurable saving: the prompt is 5% shorter, and two retries in the run cancelled it.

## Evalisms

1. **The reference is Claude's reading of the same prompt** the candidates answer. It measures agreement with a careful
   reader of the spec, not agreement with what projects need. For `conditions` the spec is too loose for two strong
   readers to agree.
2. **Adjudicator bias toward Opus** (129 against 34), the same pattern as H1's classifier adjudication.
3. **Records are gpt-6-luna's.** Luna labels records it did not extract, which is fair to the label call but not to
   Luna's whole pipeline.
4. **Variant design was on dev** (Luna's dev extractions), checked only by fill rates and reading, because dev has no
   label reference. Fill rates on dev moved ±50% between runs of prompts that changed an unrelated field: the label call
   is noisy run to run.
5. **Chunk-cluster bootstrap with 48 chunks,** where H2's 7 large chunks hold 66% of the records. CIs are wide and
   driven by a few chunks.

## Spend

- **Gateway:** $0.336 of the $1.20 track cap (dev design $0.086, set runs $0.249).
- **Codex (plan):** 49 Luna label calls.
- **Claude (plan):** 140 labeler calls and 70 adjudicator calls.
- **No Jev.**

## Files

- `items.mts` / `items.json` (the fixed set)
- `dev-items.mts` / `dev-items.json`
- `reference.mts` (labelers and adjudicator)
- `prompts.mts` (variants, diet, evidence-only)
- `run.mts` (runner)
- `score.py` + `test_score.py`
- `PREREG.md`
- Outputs: `eval/select/out/labels/`: `ref/{A,B,ADJ}`, `runs/*`, `table.json`, `cmp-g0-*.json`, `usage.jsonl`
