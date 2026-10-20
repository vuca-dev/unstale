# Slice 13 pre-registration: MiniMax M3.1 Flash for release notes' step A, fitted on slice 12's set, one held-out look

20 October 2026. DEV fitting is done (below). No held-out output exists: no release note first ingested on or after
22 October has been looked at, and none exists yet (see "Eligible today"). This file, the frozen design
(`design.patch`) and the scripts are committed and pushed before any held-out call.

Question: with release notes' step A on `vercel:minimax/minimax-m3.1-flash` (free) and gpt-6-luna as its fallback, can
extraction be as precise as gpt-6-luna's, with recall, labels (D) and the judge (E) held? Slice 12 rejected MiniMax
on steps A and B: recall passed, but precision was −18.1 points against a gpt-6-luna replicate (71.9 against 90.0),
records +22.7% against production, terms Jaccard −13.1, and D and E agreement were lower with paired CIs below 0. The
LARGE stratum was worst: 401 records against production's 256, at 53.6% precision.

## DEV: slice 12's 126 release notes

Slice 12's set (`slice12/set.json`, 126 releases, 116 technologies, 938 production records) is DEV here. `base` and
`rep` are slice 12's arms, reused; slice 12's `mm` is `r0`. Scorer and pass rule are slice 12's (`score13.mts` is
`score12.mts` with the output directory as an argument).

### Why MiniMax loses precision (`fp13.mts` on r0)

r0 has 323 records that production does not match. They are concentrated: two LARGE releases hold 135 (a monorepo
changelog with 166 records against production's 90, and a long backend changelog with 72 against 27).

| Class | r0 | rep | What |
|---|---|---|---|
| extra | 181 | 48 | A change production did not record: small internal items, UI polish, release-process lines, usage instructions and examples written as records, lines from other packages' changelogs, and some real changes production skipped (deprecations at the end of a long note) |
| dup | 91 | 4 | The quote overlaps another record of the same arm: the same line repeated under several packages of a monorepo note (one record per repeat), and one list item split into one record per name |
| split | 44 | 34 | The quote overlaps a production record already matched: one change written as several records |
| ungrounded | 7 | 5 | The quote is not in the notes |

Production itself writes several records from one quote (123 of its 938 records share a quote with another), so a
change split per name is not by itself an error against this reference.

Rejected without a model call (offline on r0 and r1):
- **Merging records by quote overlap within a release** (any chunk; or same quote and same subject): it removes
  records production also has, so recall falls 2.5 points for 3 points of precision (r0: precision 74.6, recall 84.9).
- **A post-filter by label** (change type, surface): no class separates MiniMax's unmatched records from its matched
  ones (unmatched rates 0.06 to 0.76 across classes, with the large classes at 0.26 to 0.39).
- **Dropping a repeat only when subject and quote both repeat** in another chunk: weaker than quote alone (r1: precision
  80.2 against 80.9, records +7.8% against +6.1%, for recall 86.5 against 85.8).

### Revisions (each a full MiniMax run on DEV; D and E only for the frozen one)

| | r0 (slice 12) | r1 | r2 | r3 (frozen) | Margin |
|---|---|---|---|---|---|
| Change | slice 11's r3 prompt | + scope rule; + terms rule for B | r1 + "a change stated twice is one record"; link example; drop a repeat of an earlier chunk's subject and quote; no terms rule | r1's scope rule; link example; drop a quote repeated from an earlier chunk; **step B on gpt-6-luna** | |
| Recall (rep 87.3) | 88.3 (+1.0) | 87.1 (−0.2) | 84.8 (−2.6) | 84.3 (−3.0; −6.7…+0.7) | ≥ −5, CI |
| Breaking recall (90.4) | 86.3 (−4.1) | 91.4 (+1.0) | 90.9 (+0.5) | 90.4 (0.0) | ≥ −5, CI |
| Actionable recall (88.0) | 88.5 (+0.5) | 89.1 (+1.1) | 85.4 (−2.6) | 84.6 (−3.4; −8.5…+1.5) | ≥ −5, CI |
| **Precision** (90.0) | 71.9 (−18.1) | 78.3 (−11.7) | 78.5 (−11.5) | **80.0 (−10.0; −14.3…−6.0)** | ≥ −5, CI |
| Records (base 938; rep −3.0%) | +22.7% | +11.3% | +8.0% | +5.4% | ±10% |
| Terms Jaccard (47.2) | 34.1 | 33.9 | 33.5 | 44.8 (−2.4) | ≥ −5 |
| D breaking agreement (97.3) | 95.0 (−2.3; CI < 0) | – | – | 96.1 (−1.2; −3.3…+0.6) | ≥ −3, CI |
| **D actionable agreement** (96.3) | 94.0 (−2.4; CI < 0) | – | – | **92.7 (−3.7; −5.3…−2.0)** | ≥ −3, CI |
| E outcome agreement (99.1) | 97.9 (−1.2; CI < 0) | – | – | 99.1 (0.0; −0.5…+0.5) | ≥ −3, CI |
| Failed releases | 0 | 0 | 0 | 0 | ≤ 2 |
| Rule items passed | 4 of 10 | – | – | **8 of 10** | |

What each change did:
- **Scope rule** (r1): one record per change; lines that explain, illustrate, list fields of, or migrate a change
  belong to its record; a repeated line is one record; skip usage instructions, UI polish, internal fixes naming nothing
  a developer writes or runs, release-process notes, and changes of other packages the notes pass along; when unsure
  about a minor item leave it out, never a breaking one. Records +22.7% → +11.3%, precision +6.4, recall held.
- **Terms rule** (r1, "usually 2 to 5 terms, as code writes them"): MiniMax wrote fewer terms (3.0 against
  production's 3.8) but no more of production's; Jaccard unchanged. Dropped.
- **"Stated twice is one record, from its first statement"** (r2): recall −2.4 against r1, precision unchanged. Dropped.
- **Link example** (r2, `[#123](url)` copied as `#123`): MiniMax had kept link brackets in quotes (10 ungrounded
  records in one release). Kept.
- **Drop a quote repeated from an earlier chunk** (`dropRepeats`): records of one chunk that share a quote are kept.
  Unmatched `dup` records fell from 52–64 (r1, r2; mostly the monorepo note) to 4 in r3.
- **Step B on gpt-6-luna** (`writesLabels`): MiniMax's search terms agreed with production's far less than a replicate's
  in every run (Jaccard 33.5–34.1 against 47.2). With B on gpt-6-luna, Jaccard is 44.8 and E agreement equals rep's.

**Frozen: r3**, the revision passing the most rule items. It still fails two on DEV: precision (−10.0, CI below
−5) and D actionable agreement (−3.7, CI below 0). The held-out look is expected to fail on precision. It is
registered so that the result is known on data no revision saw, not because DEV passed.

Frozen MiniMax extract template sha256 `a2ec7086761eb0d7f57c0ba179a30b82be468317c5271382f5282444c6aa7942` (pinned in
`central/test/llm-fallback.test.ts` inside the patch). `design.patch` sha256
`f8d926764fbfa672c6f6ac9f62fd1931c7eaa5f7cd1de9b0881f8677494a7a12`. It applies to `origin/main` at b9a663b and holds
slice 12's routing (`UNSTALE_RELEASE_MODEL`, fallback, per-model cache keys, usage by model and role) plus r3. Central's
suite passed 492/492 with it. `central/src` on this branch is `origin/main`: nothing ships from this PR.

Cost if it shipped: release notes' step A is about half of release A+B spend (October: A $3.356, B $3.248), so about
$49/yr of the $102/yr A+B projection at 20k technologies would go to the free model. Step B and the fallbacks stay paid.

## Held-out set (`inventory13.mts`, `select13.py`)

Built like slice 12's set, from the newest `catalog-state` generation at build time:
- release notes (not guides or docs notes) whose every non-empty chunk has a cached gpt-6-luna step-A answer;
- **every such chunk first answered on or after 2026-10-22T00:00Z**, dated by the production usage log line whose
  usage tuple equals its cached answer's (slices 8 and 12's matching; every `usage*.jsonl` under `central/`, archived
  months included). A chunk with no matching line makes its release ineligible;
- excluding the repositories of every earlier extraction or label set (slice 12's list) and of slice 12's set (this
  slice's DEV). Earlier sets' chunks were all answered before 21 October, so the date rule excludes them;
- strata MAJOR, LARGE (≥ 8,000 characters), NPM, PYPI, at most 24, 12, 54, 36; order sha256(`20261022|tech|version`);
  at most one release per technology per stratum, two per technology, three per repository.

**At least 100 releases.** `select13.py` exits with status 2 and writes nothing when fewer are selected. Then wait and
build again from a later generation. The first generation that yields ≥ 100 fixes the set. `heldout.json` is committed
and pushed before any held-out model call, with the generation name in the commit message.

## Arms and metrics

As slice 12, on the held-out set, in the patched worktree: `base` (production's cached answers; E fresh), `rep` (a fresh
gpt-6-luna replicate, `UNSTALE_RELEASE_MODEL=none`), `mm` (the frozen design: MiniMax step A on r3, gpt-6-luna step B and
fallback). D is the pipeline's classifier, E the same-or-new judge against the technology's store without this release.
Metrics, matching and bootstrap (2,000 resamples of releases, seed 20261020, paired `mm − rep` CI) are slice 12's.

## Decision rule (slice 12's, unchanged; one look)

`mm` passes when all hold:
1. Recall no more than 5 points below rep's, paired CI not entirely below 0.
2. Breaking recall and actionable recall: each as rule 1.
3. Precision no more than 5 points below rep's, paired CI not entirely below 0.
4. Records within ±10% of base, or within rep's deviation + 5 points if rep deviates more than 5%.
5. Terms Jaccard no more than 5 points below rep's.
6. D breaking and actionable agreement each no more than 3 points below rep's, paired CI not entirely below 0.
7. E outcome agreement no more than 3 points below rep's, paired CI not entirely below 0.
8. Failed releases at most max(1, 2%).

If the Jev cap stops D or E early, the rule is scored on the releases all three arms completed, in `heldout.json` order.
**If it passes:** a PR applies `design.patch` to `central/src` and is not merged without review. **If not:** nothing
changes in `central/src`; RESULTS.md records the look.

## Commands (exact)

```sh
# 0. Scratch directory and the newest state (download only; nothing is written to catalog-state).
S=<scratch dir>; mkdir -p "$S/store"
cd /path/to/unstale && UNSTALE_STORE="$S/store" UNSTALE_STATE_REMOTE="github:vuca-dev/unstale#415543018" \
  GH_TOKEN="$(gh auth token)" npm --prefix central run -s state -- restore --all   # note the generation it prints

# 1. A worktree at this file's commit, with the frozen design.
git fetch origin && git worktree add ../unstale-slice13h origin/slice13
cd ../unstale-slice13h && git apply eval/select/slice13/design.patch
ln -s /path/to/unstale/node_modules node_modules; ln -s /path/to/unstale/central/node_modules central/node_modules
ln -s /path/to/unstale/eval/select/node_modules eval/select/node_modules

# 2. Inventory and set (no model calls). Exit status 2: fewer than 100 releases; stop and retry from a later state.
cd central
npx tsx ../eval/select/slice13/inventory13.mts --state "$S/store/central" --out slice13h
python3 -I ../eval/select/slice13/select13.py "$S/store/central" ../eval/select/out/slice13h/chunks.jsonl \
  ../eval/select/slice13/heldout.json
git -C .. add eval/select/slice13/heldout.json && git -C .. commit -m "Slice 13 held-out set (<generation>)" -- eval/select/slice13/heldout.json && git -C .. push

# 3. Arms (caps per output directory: Vercel $1, Jev $0.50), then the score.
for arm in base rep mm; do
  npx tsx ../eval/select/slice13/run13.mts --state "$S/store/central" --set slice13/heldout.json --out slice13h --arm $arm
done
npx tsx ../eval/select/slice13/score13.mts --state "$S/store/central" --out slice13h --cand mm
```

## Eligible today

None. The newest complete generation is `state-20261020T181528Z-39461062144-1` (20 October, 18:15Z), before the
22 October cutoff, so `select13.py` selects 0 releases (checked against the 17:33Z state: 0). For the rate: on that state
with the cutoff moved to 20 October 12:00Z, the last 5.5 hours of the bulk onboarding gave 105 eligible releases and
32 selectable under the per-technology caps (MAJOR 2, LARGE 2). After onboarding, ingestion is monitoring only, so
reaching 100 is expected to take days to weeks.

## Budget

DEV spent Vercel **$0.040** (r3's gpt-6-luna step B; MiniMax $0) and Jev **$0.131** (r3's D and E). Held-out caps:
Vercel **$1.00** and Jev **$0.50** in `out/slice13h` (`run13.mts` refuses a call that would pass either). Slice 12's
126 releases cost $0.097 for rep and $0.31 of Jev for three arms.

## Known limits

- The reference is production's own output, not gold. Part of MiniMax's "extra" records are real changes gpt-6-luna
  skipped (DEV: a long note's closing deprecations), which count against precision here.
- One MiniMax run per revision. Run-to-run variation is large on single releases (one release: 7 unmatched records in
  r1, 29 in r2, 24 in r3), so differences of a few points between revisions are within noise.
- Revisions were chosen on DEV with D and E run for r3 only; r1 and r2 are A+B results.
- E's pre-release store is reconstructed as in slice 12.

## Files

`fp13.mts` and `match13.mts` (false-positive classes), `notes13.mts` (notes by chunk, for reading), `run13.mts`,
`score13.mts`, `inventory13.mts`, `select13.py`, `design.patch`. DEV outputs are gitignored, in `out/slice13/`.
