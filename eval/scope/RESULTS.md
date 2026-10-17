# Scope: admitted population, changes per technology-quarter, admission thresholds (16 October 2026)

Question (user): what does the **median** admitted technology cost per quarter, across the supported ecosystems (npm,
which includes TypeScript packages, and PyPI; cargo has thresholds but no adapter), and are the admission thresholds in
`central/src/pipeline/admission.ts` (fresh: a release or push within 365 days; used: ≥ 1,000 weekly downloads or ≥ 100
stars; unreadable signals fail open) sound before organic demand data exists?

**The earlier cost projections were per technology-YEAR** ($0.040 per technology-year, i.e. $400 / $2,000 / $8,000 a
year at 10k / 50k / 200k technologies), built on R = 114.6 records per technology-year, the MEAN over the catalog's
popular, heavy technologies (its own median is 32).

## Method

- **Frame** (`frame.py`, `frame.json`): packages per registry above monthly-download floors, by binary search over the
  downloads-sorted ecosyste.ms listing. Cross-check against npm's and pypistats' own counts at the floors
  (`frame-check.json`): within ±20% for 7 of 8 (one PyPI package mid-spike).
- **Population signals** (`pop.py`, `popstats.py`): random 100-package pages per download band (≥ 1M/wk, 100k–1M,
  10k–100k, 1k–10k, 100–1k, < 100/wk) per ecosystem, 5,800 packages; the current admission rule applied to each.
- **Deep sample** (`deep.py`, `deep20.json`): 20 admitted packages per band per ecosystem (239 measured). Each package was
  measured over the last 4 quarters (17 Oct 2025 – 16 Oct 2026):
  - releases in the window (registry);
  - its release notes: GitHub releases carrying its versions, per-package tags in monorepos, or a CHANGELOG section;
  - human commits on the default branch;
  - archived and deprecated flags;
  - how many admitted packages share its repository and tag stream (the technology unit).
- **Records from notes** (`calib_fit.json`): fitted on the catalog's 78 technologies with records, log R = −3.31 + 0.848
  log N (N = note tokens a year, chars / 4), residual factor 2.3.
  - **Validated out of sample** (`validate.mts`, `validate-summary.json`): the production extraction (gpt-6-luna, low,
    two calls) on 10 sampled packages gave 261 records against 289 predicted (0.90×); 9 of 10 within the residual factor.
- **Cost per technology:**
  - A+B: $0.0192 × (0.38 N/6,462 + 0.62 R/114.6). Input share 38%, output 62%, as measured in model selection.
  - D + E: $0.0210 × R/114.6, with the classifier wording v1 and judge text M8.
- **Technology weighting:** packages that share one repository and one tag stream count as one technology. Weights come
  from the band populations. Bootstrap CIs are stratified within band (`bootstrap.json`).
- **Platform stratum** (`platform.py`, `platform.json`): Node.js, TypeScript, Deno, Bun, CPython, npm CLI, pnpm, Yarn,
  pip, uv, Poetry and setuptools.

## Population (registry-wide ceiling under the current rule)

Admission is demand-driven (a package must be declared by a registered repository), so these are ceilings, not the fleet.

| Weekly downloads ≥ | 100 | 1k (floor) | 10k | 100k | 1M |
|---|---|---|---|---|---|
| npm packages | 511,622 | 164,564 | 63,467 | 26,652 | 10,613 |
| PyPI packages | 114,040 | 41,188 | 16,721 | 6,019 | 1,923 |

| | npm | PyPI | Both |
|---|---|---|---|
| Packages admitted by the current rule (downloads or stars, fresh) | ≈ 240k | ≈ 57k | ≈ 297k |
| … of which admitted on stars alone (under the download floor) | ≈ 130k | ≈ 30k | 53% |
| Technologies (shared tag streams counted once) | ≈ 110k | ≈ 37k | ≈ 148k |

## Changes per technology-quarter

Records per technology-quarter, technology-weighted. Fleet tiers assume a demand-driven fleet of K distinct
technologies is roughly the top K by usage (10k ≈ packages at ≥ 1M/wk).

| Population | p50 | p75 | p90 | p99 | Mean (95% CI) | No notes in the window |
|---|---|---|---|---|---|---|
| Model assumption until now (catalog mean) | — | — | — | — | 28.7 | — |
| Catalog's own 94 technologies | 8.0 | | | | 27.4 | |
| **~10k fleet (≥ 1M/wk)** | **3.1** (0–22.8) | 22.8 | 38.1 | 75.3 | **11.4** (3.8–19.3) | 29% |
| ~50k fleet (≥ 100k/wk, top of 10k–100k) | 0.2 (0–1.3) | 3.2 | 17.6 | 90.2 | 7.1 (2.6–15.6) | 41% |
| ~200k fleet (≥ 1k/wk) | 0.0 (0–1.3) | 2.8 | 6.7 | 320 | 15.3 (2.0–41.0) | 51% |
| Registry-wide admitted | 0.0 | 1.6 | 6.7 | 320 | 10.6 (2.0–27.2) | 61% |
| Only technologies with notes in the window | 2.9 | 6.7 | 38.1 | 320 | 27.3 | 0% |
| npm, registry-wide | 0.0 | 1.3 | 6.7 | 320 | 12.9 | 66% |
| PyPI, registry-wide | 0.3 | 2.1 | 9.4 | 55.5 | 3.8 | 46% |

**The median admitted technology produces almost nothing.**
- 61% have no release notes in a year: no GitHub release and no changelog section, or no release at all.
- A median technology in a 10k fleet yields about 3 records a quarter.
- The mean is driven by a heavy tail. In the sample, one npm package whose changelog is machine-written (228k note tokens
  a year, 4 stars, about 10k downloads a month) carries about 80% of its band's cost.

**Platforms** (records per quarter predicted from notes; $ per year):

| Platform | Records per quarter | $ per year |
|---|---|---|
| Node.js | 471 | $0.95 |
| pnpm | 445 | $0.89 |
| uv | 285 | $0.55 |
| CPython | 108 | $0.20 |
| npm CLI | 81 | $0.14 |
| Deno | 78 | $0.14 |
| TypeScript | 23 | $0.04 |
| Poetry | 16 | $0.03 |
| pip | 14 | $0.02 |
| Bun | 13 | $0.02 |
| Yarn | 9 | $0.01 |
| setuptools | 7 | $0.01 |

They are the per-technology tail, not a fleet cost.

## Cost per technology-quarter and fleet

| | Median $ per technology-quarter | Mean $ per technology-quarter | Mean $ per technology-year (95% CI) | Fleet $ per year (CI) | Earlier projection (per year) |
|---|---|---|---|---|---|
| ~10k fleet | $0.0012 | $0.0048 | $0.019 ($0.006–0.033) | **$191** ($63–326) | $400 |
| ~50k fleet | $0.0001 | $0.0030 | $0.012 ($0.004–0.027) | **$610** ($210–1,365) | $2,000 |
| ~200k fleet | $0.0000 | $0.0072 | $0.029 ($0.003–0.079) | **$5,790** ($640–15,780) | $8,000 |
| Registry-wide ceiling (≈ 148k technologies) | $0.0000 | $0.0050 | $0.020 ($0.003–0.052) | ≈ $2,950 ($470–7,700) | — |

- **Per quarter:** a 10k fleet is about $48 a quarter, and a 50k fleet about $150.
- **The 200k tier and the ceiling are dominated by a handful of verbose packages,** hence the wide CIs. The worst case
  per technology scales with its note volume, not its popularity.

## Threshold findings and recommendations (ranked)

Each finding gives the share of admitted packages, technologies and model cost it touches (deep sample, registry-wide).
**Model cost is already self-limiting:** a package with no release produces no extraction. Admission rules mostly
save crawling, docs snapshots and queue size. The cost lever is the technology unit and the tail.

1. **Count a technology per (repository, tag stream), not per package.**
   - **Effect:** 297k admitted packages fall to 148k technologies (−50%). It also ends the same notes being extracted and
     judged once per sibling package: 56% of admitted packages share a stream with another admitted package.
   - **How:** npm's `siblings` hook does part of this; PyPI has none. Generalisable as "packages whose registry
     repository is the same and whose releases carry no per-package tag are components of one technology".
   - **Risk:** low. Per-package-tag monorepos (changesets) stay separate, since their notes differ.
2. **Freshness by release, not by push.**
   - **Finding:** 42% of admitted packages (28% of technologies) had no stable release in the window. They pass only on
     `pushed_at`, which counts pushes to any branch, bot branches included. Example: a package last released 5.6 years
     ago, with 0 default-branch commits in the window, admitted. They carry 1.4% of predicted records.
   - **Rule:** use the registry's last release, prereleases included; keep `pushed_at` only when release dates are
     unreadable.
   - **Effect:** −28% technologies monitored; model cost about −1%.
   - **Risk:** low. The release-index re-admission (a parked package returns on its next release) already covers
     dormant-then-active packages.
3. **Stars count only for the repository's main package.**
   - **Finding:** 53% of admitted packages (35% of technologies, 6% of cost) pass on stars alone. Of the sampled
     stars-only packages, 46% point their `repository` at a repo where they get under 1% of the top package's downloads:
     borrowed stars. Examples: republished forks (`mermaid-es6` → mermaid-js/mermaid), font subsets, rebrands.
   - **Rule:** stars apply only to the package with the most downloads among those declaring that repository.
   - **Effect:** −10% technologies, about −0.3% cost.
   - **Risk:** low. A monorepo's minor packages are components of the main technology anyway (rule 1).
4. **A per-technology note budget per quarter in the demand-ordered queue.** This bounds the worst case at O(budget)
   rather than O(note volume).
   - **Finding:** the p99 technology yields about 320 records a quarter. One machine-written changelog in the sample
     (228k tokens a year) carries about 80% of its band's cost. Platforms such as Node.js and pnpm run 340–360k tokens a
     year legitimately.
   - **Rule:** a budget (e.g. about 50k note tokens a quarter), with overflow extracted in demand order. That way a
     popular verbose technology still gets through, and an unused verbose one waits.
   - **Risk:** delayed records for verbose, little-used technologies.
5. **Archived repositories stop counting as a signal** (GitHub `archived`). Corrected on implementation
   (`admission-check.mts`): all 5 sampled packages with an archived repository still release from their registry,
   including prosemirror-view (released 20 days before the sample, 104M downloads a month), because projects that move
   off GitHub archive the old repository. Parking on `archived` alone would drop live packages. Implemented rule: the
   archived repository's stars and pushes no longer count, so the package must qualify on registry release and
   downloads. In the sample this parks 0 of the 5.
6. **Deprecated, removed or inactive** (npm `deprecated` on latest, ecosyste.ms `removed`, PyPI "7 - Inactive" or every
   file yanked). 3.4% of packages, about 0 cost.
   - **Rule:** do not monitor; publish one "package deprecated" record from the registry metadata, since a deprecation is
     an obligation the user's agent should see, then park.
7. **`@types/*` and `types-*`.** 1% of packages, no release notes (DefinitelyTyped and typeshed). Park them, or attach
   them to the typed package's technology. Low priority.
8. **No release notes at all** (61% of technologies). Not an admission rule: they cost no extraction. Their only cost is
   docs crawling and storage, so the docs monitor, not admission, should decide on them.

**Rejected:**
- **Dependents count as a usage gate.** 44% of admitted packages show 0 dependents, including 9–17% of packages at
  100k–1M+ weekly downloads, because coverage is incomplete (PyPI especially). Usable only as a ranking signal.
- **Raising the download floor.** The fleet is demand-driven. Below the floor the stars path, not downloads, is the
  problem (rule 3).
- **Downloads alone as proof of use.** CI and bot installs pass 1k a week: a test-fixture package in the sample has 17k a
  month. Rejected as a reason to change anything before demand data, since demand (direct declaration) is the real gate.

## Caveats

- **Sample size:** 20 per band per ecosystem. Medians and p90s per band have wide CIs. The mean is tail-driven: one
  package can move a band's mean several-fold.
- **Records are predicted, not extracted,** for the population. The fit was validated on 10 out-of-catalog packages
  (0.90×), and the catalog it was fitted on is popular and npm-heavy.
- **Notes attribution is conservative:**
  - monorepo packages with idiosyncratic tags count 0 (e.g. a Python package inside a JS-tagged monorepo);
  - changelog parsing finds version headings only;
  - docs, upgrade guides and blog-post release notes (TypeScript's handbook page was added by hand for the platform
    stratum) are not counted.
- **Fleet tiers by download rank are a proxy** for demand. A real fleet is the union of users' direct dependencies.
- **The technology dedupe uses ecosyste.ms repository lookups** of packages that also pass the current rule.
- **No change to `central/src`.** Spend: gateway $0.066 (193 calls, the validation extraction). GitHub, ecosyste.ms, npm
  and pypistats are free.

## Implemented admission rules (`central/src/pipeline/admission.ts`, `admission-check.mts`)

Replayed on the 240-row deep sample from cached responses only (3 cache misses), old rule against new. Weights are
packages and technologies, as above.

| Rule | Packages the old rule admitted, now parked | Share of admitted packages | Share of technologies | Matches finding |
|---|---|---|---|---|
| Freshness by release (prereleases count) | 53 | 35.9% | 22.8% | #2 (42% / 28%, which counted stable releases only) |
| Stars for the main package only (plus genuinely unused) | 8 | 5.4% | 3.0% | #3 (most borrowed-star packages are also stale and counted above) |
| Deprecated, inactive or all yanked (notice kept) | 4 | 3.5% | 0.1% | #6 (3.4%) |
| Type stubs (`@types/*`, `types-*`) | 7 | 1.0% | 0% | #7 (1%) |
| Archived repository (signal only) | 0 | 0% | 0% | #5, corrected |
| **All** | **72 of 238** | | | |

- **Main-package rule:** it flags 23 of 78 stars-only admissions (29%; 41% of the 56 whose share is readable). On
  inspection all 23 are republished forks, rebrands or minor plugins of another project. The other 22 are missing from
  the ecosyste.ms lookup and fail open.
- **No package gained admission.**
