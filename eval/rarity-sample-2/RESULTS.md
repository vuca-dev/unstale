# Rarity sample, selection rule (15 October 2026)

## Pre-registration (written before any variant was drawn or measured)

**Why.** The first sample (code-search best match, stars, current major, n = 5; `sample/<tech>/sample.parked.json`)
lowered required key changes in the type-tier first 16 on the expanded replay from 40 to 35 (DEV 32 → 28). Suspected
causes: low-adoption repositories (NestJS's are near random) and sampling at the current major, where every project
contains the new major's migration terms, so those terms get the lowest weight.

**Fixed for every variant.** Automatic, once per technology, no hand-picking. Exclusions as before (forks, archived,
templates, teaching words, the technology's own organisation, over 200 MB, one repository per owner) plus every
evaluation repository: the 15 events of `eval/replay/events/EVENTS.md` and the original end-to-end repositories, and
their forks and upstreams. Counted by the edge's matcher (`unstale count-terms`, one binary for all variants), published
by `publishTechnology` into a side catalog, queued by `eval/rarity-sample/rarity_queue.py --weights sample` (the
harness queue, condition `orig`, weight ln((n+1)/(c+0.5))), with the v2 match results reused (same record ids). The
queue is the harness's Python queue, not the CLI's, so changes to the CLI's tier-0 order do not touch these numbers.

**Pools.**
- **code-search** (as now): GitHub code search `"<first package>" filename:package.json`, pages 1–10, ranked by stars.
- **adoption**: GitHub repository search `topic:<topic> stars:>=50 pushed:>=<draw date − 365 days>`, sorted by stars
  (pages 1–10). The topic is ecosystem vocabulary, picked automatically: the technology repository's own GitHub topics
  that equal (lowercase, alphanumerics only) its repository name or one of its package names without scope; if several,
  the one with most repositories. A repository qualifies when a `package.json` in its tree (not under `node_modules`,
  not on a path with a teaching or fixture word) declares a package of the technology at the target major.

**Majors.** current (the catalog's highest line), previous (current − 1), mix (⌈n/2⌉ previous, the rest current,
each in rank order).

**Candidates (stage 1, n = 5):**

| Id | Pool | Major |
|---|---|---|
| R0 | code-search | current (the parked sample; reproduction check) |
| R1 | code-search | previous |
| R2 | adoption | current |
| R3 | adoption | previous |
| R4 | adoption | mix |
| R5 | code-search | mix |

**Stage 2 (n):** for the stage-1 winner's pool and major, n = 3, 10 and 20 (prefixes of the same ranked list).

**Comparison.** The fallback (no sample, `sample_n: 0`, rarity among the catalog's own terms), measured in the same
work setup. Previously reported DEV numbers for it: type tier 32, usage 24 required in the first 16.

**Metric (DEV only, 9 events, 72 required key changes):** required key changes in the type-tier first 16 (primary)
and in the usage first 16 (secondary).

**Decision rule.**
1. Winner = highest DEV type-tier required; ties → higher DEV usage required → higher DEV type-tier all key changes →
   smaller n → lower id.
2. Recommend publishing the winner only if its DEV type-tier required ≥ the fallback's **and** its DEV type-tier +
   usage required ≥ the fallback's + 2. Otherwise keep the fallback.
3. HELD-OUT is then run once, for the winner only. If its held-out type-tier required is 2 or more below the
   fallback's, the recommendation becomes "keep the fallback" whatever DEV said.

**Held-out disclosure.** I had read the held-out numbers already in `eval/replay/RESULTS-expanded.md` (fallback 8 /
parked sample 7 type-tier required, 5 / 4 usage) before this pre-registration; nothing about the new variants was seen.

## Results

Measured on 15 October 2026 against one queue for every variant: `eval/rarity-sample/rarity_queue.py` (the harness's
Python queue, condition `orig`) at commit 328bc27, with v2's match results; the CLI's own order is not involved, so
agent B's tier-0 work does not change these numbers. Counts by one `unstale count-terms` binary (sha256 65c7a0c502b0e830,
built 15 October 11:00). Side store `.store/central-sample` (copy of `.store/central`); the live store and catalog were
not touched. Setup check: the fallback catalog published from the side store is byte-identical to the published
catalog's indexes, and R0 reproduces the parked sample's repositories and every count, and the earlier numbers
(fallback 32 / 24, parked sample 28 / 28).

### DEV (9 events, 72 required): required key changes in the first 16

| Variant | Pool | Major | n | Type tier: req (all) | Usage: req (all) |
|---|---|---|---|---|---|
| **fallback** (no sample) | | | 0 | **32** (49) | 24 (36) |
| R0 (parked) | code-search | current | 5 | 28 (45) | 28 (44) |
| R1 | code-search | previous | 5 | 28 (46) | 23 (36) |
| R2 | adoption | current | 5 | 28 (45) | 22 (35) |
| **R3** | adoption | previous | 5 | **31** (47) | 26 (36) |
| R4 | adoption | mix | 5 | 28 (45) | 21 (31) |
| R5 | code-search | mix | 5 | 28 (45) | 28 (45) |
| R3-n3 | adoption | previous | 3 | 31 (48) | 22 (33) |
| R3-n10 | adoption | previous | 10 | 29 (45) | 23 (35) |
| R3-n20 | adoption | previous | 20 (nestjs 17) | 28 (44) | 23 (34) |

Covered required changes: 49 for every variant (same match). Per event (tier / usage required), the differences are
almost all in cedar-prisma7 (fallback 12 / 4, R0 9 / 8, R3 11 / 8) and zodgen-prisma7 (fallback 3 / 5, every sample
2 / 2 or 2 / 4); per-event rows in the scratch metrics files.

**Stage 1 winner: R3** (adoption pool, previous major). **Stage 2:** n = 5 stays (n = 3 ties on tier, 31, and loses on
usage, 22 vs 26; more repositories make it worse, 29 and 28). Larger n does not help here, consistent with the earlier
"3 ≈ 25" finding.

**Decision rule:** R3's DEV type tier, 31, is below the fallback's 32, so condition 2 fails: **keep the fallback**.
(R3 + usage = 57 vs the fallback's 56, also short of the +2 margin.)

### HELD-OUT, once, for the winner (R3, n = 5)

| | Type tier: req (all) | Usage: req (all) |
|---|---|---|
| fallback | 8 (9) | 5 (7) |
| R3 | 8 (9) | 4 (5) |

Rule 3 is not triggered (no 2-point loss), but held-out shows no gain either.

### What this says

- **Sampling at the previous major is the change that matters**, and only with an adoption-ranked pool: R3 recovers
  3 of the 4 lost type-tier changes (28 → 31) and keeps most of the usage gain (26 vs 24). On the code-search pool,
  the previous major does nothing (R1 28). Mixing majors brings the migration-term problem back (R4, R5 at 28).
- **Adoption ranking alone does not fix it** (R2 28): at the current major, popular projects still all contain the new
  major's migration terms.
- **No rule beats the catalog-terms fallback on the default order.** The sample's effect is concentrated in two Prisma
  events; three events out of nine decide every difference, so these are small numbers.
- **The adoption pool picks libraries and scaffolders too** (create-t3-app, next-auth, shadcn-ui/ui; NestJS's topic
  `nest` returns mostly NestJS libraries, 106 candidates). The pre-registered rule kept them; no rule was tuned after
  seeing them.

### Recommendation

Keep publishing with the fallback (`sample_n: 0`). If a sample is wanted for the usage order later, use R3 (adoption
pool, previous major, n = 5): it is the only rule within one change of the fallback on the default order. The code's
`DEFAULT_RULE` is unchanged (code-search, current, 5); the pipeline still draws a sample when `sample.json` is absent,
as before.

### Calls

GitHub only, no model calls: about 944 new cached answers (repository search: about 18 calls, of which 3 topic counts;
code search: 0, all cached from the first draw; the rest repository trees and package.json contents, plus 3 repository
metadata), and 100 shallow clones in the side store (2.3 GB). npm registry: 3 reads (package keywords, while looking at
topics). Numbers from `.store/central-sample/sample/*/gh` (3,060 → 4,004 files).

```sh
S=<scratch>; cp -cR ~/unstale/.store/central ~/unstale/.store/central-sample
export UNSTALE_CENTRAL_DIR=~/unstale/.store/central-sample UNSTALE_BIN=<unstale> BASE_WORK=<expanded replay w2n work dir>
cd ~/unstale/central
npx tsx ../eval/rarity-sample-2/variants.mts draw R0 R1 R2 R3 R4 R5 R3-n3 R3-n10 R3-n20     # samples/<variant>/<tech>.json
npx tsx ../eval/rarity-sample-2/variants.mts publish $S fallback R0 R1 R2 R3 R4 R5 R3-n3 R3-n10 R3-n20
cd ../eval/rarity-sample-2; for v in fallback R0 ...; do ./queue.sh $S $v dev; done; ./queue.sh $S R3 heldout
```
