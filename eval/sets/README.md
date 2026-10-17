# Labelled sets, one per pipeline stage

These sets support a top-down model and cost walk: swap one stage's model or prompt, score that stage on its set,
then confirm end to end with the release gate (`eval/gate/run_gate.sh`). Scorers make no model calls.

| Set | Stage it scores | Items | Reference | Scorer |
|---|---|---|---|---|
| `extraction-recall.json` | **Extraction**: does a source line that carries a real upgrade change become a record? | 100 key changes of the 15 replay events whose text a source carries: 96 in fetched sources (61 required), 4 only in sources the catalog does not fetch | Built from the gate's diagnosis (`eval/gate/MISSES.md`). For covered key changes, the source lines are the evidence of the records both match runs map them to. For the other 5, the line is quoted in MISSES.md. | `python3 score.py extraction <catalog-dir>`: a hit is any active record whose evidence quote matches a labelled line (containment or similarity ≥ 0.8 after normalising PR refs and markup), reported per split, overall, fetched-only and required. Published catalog: 96/100 (fetched 96/96). `catalog-v1` (no guides): 63/100. |
| `benefit/reference.json` | **Benefit labels** (Jev labeller at ingest, `benefit` field) | 150 records, 50 each of next, prisma and nestjs, chosen by sha256 of `benefit-set:<id>` from the published catalog's active records | Two judges under the benefit rule (Slice 0 `benefit_label.py` PROMPT_V2, the "Improvements review: benefit labels" re-run with maintainability): Codex `gpt-5.6-luna` (`benefit/judge_codex.py`, 25 records per call) and Claude reading each record. Every disagreement was adjudicated by Claude and noted (`adjudication` field). | `python3 score.py benefit <labels.json or catalog-dir>`: identical set, benefit-vs-none, per-benefit precision and recall. The judges agreed on 131 of 150; 19 were adjudicated (14 for Claude's label, 4 for Codex's, 1 for neither). Reference: 83 records with a benefit (correctness 63, security 12, performance 9, cost 1), 67 none. **Published catalog (Jev labels): 79.3% identical sets, 86.0% benefit-vs-none.** Codex alone scores 90.0% and Claude alone 96.7%, but Claude was also the adjudicator, so that number is inflated. |
| Breaking (241) | **Breaking label** (`breaking`) | 241 records (143 breaking) where the two reference judges agree, out of 251 Laravel, Next.js, Prisma and NestJS records from guides and notes | `~/ati-slice2/results/datamodel/breaking/` (`pipeline` = Codex, `reference` = Sonnet; read only) | `python3 score.py breaking <{rid: bool}.json>`. The hill-climb's own `eval/breaking-hillclimb/analyze.py` also reports flips and the dev metric. |
| Matching, within source (83) | **Same-or-new judge and guards**, release notes against release notes | 83 judge "same" matches of the first run, each with a verdict (SAME, DIFFERENT, UNSURE) | `docs/match-audit.md` | `central/test/match.test.ts` (guards on the 83 cases, part of `npm test`). Tuned on this set, so it is not independent. |
| Matching, guides vs notes (104) | **Cross-source matching** (`CROSS_SAME_P`, cross-kind guards) | 104 guide↔notes pairs with Jev p ≥ 0.5 | `docs/match-audit-guides.md`, `eval/guides/pairs.json` and `verdicts.json` (Codex v3 rules plus my verdicts) | `python3 eval/guides/rule_eval.py eval/guides/pairs.json eval/guides/verdicts.json`. Tuned in-sample on Prisma and NestJS; Next.js was held out. |
| Matching, held out (Nuxt) | **Matching on an unseen technology** | 168 merges plus the pairs near the threshold, Nuxt (pre-registered) | `docs/match-audit-heldout.md`, `eval/heldout/pairs.json` and `verdicts.json` | `python3 eval/heldout/table.py` (counts and table). The rule passed: 0.6 false merges per 100. |
| Release gate (end to end) | **Order and review** on the shipped CLI | 15 events, 158 key changes (94 required), DEV 9 / HELD-OUT 6 | `eval/replay/events/` keys, rule-based required/optional | `eval/gate/run_gate.sh <catalog> <label>` and `eval/gate/score.py` |

Notes:

- **Extraction recall is 100% on fetched sources** for the current pipeline, so the set mainly guards against
  regressions when the extraction model or prompt is made cheaper. Its quotes come from the current records'
  evidence (for covered items), so a rebuild that rewords evidence quotes is matched by similarity, not identity.
- **The benefit reference is not the user-labelled set.** That set is the 11 rated improvements in Slice 0.
  This reference is two judges plus adjudication on the record text alone, so it measures labelling, not value in a
  given repository.
