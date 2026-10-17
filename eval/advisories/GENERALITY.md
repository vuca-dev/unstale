# Advisories beyond npm: source and resolution on PyPI, crates.io, Go and Maven (15 October 2026)

**Question.** Does the advisories stage need ecosystem-specific work beyond what any ecosystem port needs anyway (a
registry adapter with a release index, a lockfile reader at the edge)? Central only; nothing is wired into onboarding.

**Run.** `eval/advisories/generality.mts` calls central's code unchanged (`fetchAdvisories`, `resolveRange`,
`fixesInWindow`, `toRecordAdvisory`) for four packages. The release index comes from a minimal release-list fetch in
the script, one function per registry (PyPI JSON API, crates.io versions API, the Go module proxy, Maven Central
search). These functions stand in for the registry adapter a port would add. The window is releases since 2023-01-01,
oldest first, yanked releases dropped. Calls: 4 OSV queries, 66 registry requests (the Go proxy needs one per
version for its date), no model calls. Output: `generality.json` (scratch, not committed).

## Results

| Package | Releases in window | Advisories (OSV, deduplicated) | Ranges resolved | Unresolved | Fixes in window |
|---|---|---|---|---|---|
| `pkg:pypi/django` | 130 | 162 | 412 (ECOSYSTEM, from OSV's version lists) | 12 (ECOSYSTEM with no list) | 59 |
| `pkg:cargo/tokio` | 80 | 5 | 15 (SEMVER) | 0 | 3 |
| `pkg:golang/golang.org/x/net` | 57 | 38 | 38 (SEMVER) | 0 | 24 |
| `pkg:maven/org.apache.logging.log4j/log4j-core` | 20 | 11 | 24 (ECOSYSTEM, from lists) | 0 | 4 |

**Hand check (11 advisories).** Each advisory's fixed-in versions were compared with its OSV page
(`api.osv.dev/v1/vulns/<id>`) and with the release dates from the registry:

- Django: GHSA-2hrw (CVE-2023-24580), GHSA-x7q2 (CVE-2024-39329), GHSA-xxj9 (CVE-2024-24680), GHSA-3h9f
  (CVE-2026-48588).
- tokio: GHSA-4q83 (RUSTSEC-2023-0005), GHSA-rr8g (RUSTSEC-2025-0023).
- x/net: GHSA-4374 (CVE-2023-39325, HTTP/2 rapid reset), GHSA-4v7x (CVE-2023-45288), GHSA-2wrh (CVE-2023-3978).
- log4j-core: GHSA-vc5p (CVE-2025-68161), GHSA-3pxv (CVE-2026-34480).

**Results:**
- Every fixed-in version we report equals an OSV `fixed` event and a release in the registry's index, on the right
  date (11 of 11; for example x/net 0.17.0 on 2023-10-10, Django 4.2.14 and 5.0.7 on 2024-07-09).
- Every affected set checked starts and ends where the range does: tokio `>= 0.2.5, < 1.38.2` resolves to 34 releases
  of the window, the last being 1.38.1.
- Some fixes are not reported. Five fixed versions on minor lines are collapsed into their major (see "Release line"
  below): Django 4.1.7; tokio 1.20.4, 1.24.2, 1.43.1 and 1.44.2. These are dating gaps on the central side. The
  edge's answer does not depend on them, because it reads the resolved versions.

## What is ecosystem-specific, and how each part fails open

- **Source: nothing specific.** One OSV query per package URL. OSV returns GHSA, PYSEC, RUSTSEC and GO ids for the
  same vulnerability. The GHSA id is kept as the advisory id. When two databases describe the same advisory, the
  ranges come from the record whose own id is the advisory id, and they are not unioned. Django's PYSEC and GHSA
  ranges for GHSA-3h9f disagree (`>= 5.2` vs `< 5.2.16` with no lower bound). Severity is read only from GHSA's
  `database_specific.severity`; without it the line has no severity.
- **Range resolution:**
  - SEMVER ranges (crates.io, Go, npm) need no ecosystem code.
  - ECOSYSTEM ranges need the ecosystem's version order. Only npm has one here (SemVer). PyPI (PEP 440) and Maven
    have none, but OSV lists the affected versions for their entries, and central uses those lists exactly.
  - When an ECOSYSTEM range has no list, or the range is a GIT range, it stays unresolved and the edge says nothing
    about it (Django: 12 of 424 ranges).
  - A version the order cannot read leaves its range unresolved; there is no fallback guess.
- **The edge: nothing specific.** It compares version strings with the published index and resolved sets. A version
  outside the index is unknown and the advisory is left out; the record is listed as before.
  - The release index and the lockfile reader must therefore spell versions the way OSV does. That is the one
    vocabulary point a port must get right.
  - Go is the example: the proxy and `go.sum` say `v0.23.0`, OSV says `0.23.0`. The script's Go adapter strips the
    `v`, and a Go lockfile reader would do the same.
  - A mismatch fails open: no version is found in the index, so nothing is said. It never produces a wrong claim.
- **Siblings (other packages from the same repository):** an optional hook per ecosystem (npm: the scope's public
  package listing, and the registry `repository` must be the technology's repository).
  - None is written for PyPI, crates.io, Go or Maven, so they query their components only. Packages the repository
    also publishes are then missed: fewer advisories, never wrong ones.
  - Where a registry has scoped package metadata, the hook would follow the same pattern: Maven's groupId plus the
    POM `scm` URL, crates.io's `repository`.
- **Release line (a product concept, not an advisory one):**
  - `releaseLine` is the major version (`0.x` uses its minor). That matches npm practice. It does not match projects
    that maintain several minor lines: Django's feature releases, tokio's LTS minors.
  - There, a fix on two minors of one major is dated once, at the earliest, and the record gets fewer backport
    releases. This affects which releases records carry, not the advisory answer at the edge.
  - A port for such ecosystems would need a line definition per ecosystem or per project. That is the same open
    question the records' `line` field already has, so it is not new work for advisories.

**Conclusion:**
- Advisories add no per-ecosystem code to the source or to the edge.
- Range resolution needs a version order only where OSV gives neither SEMVER ranges nor version lists. Of the four
  ecosystems checked, none needed it.
- The sibling hook is optional, and leaving it out costs coverage, not correctness.
- What a port needs is what it needs anyway: a release index and a lockfile reader that spell versions as OSV does.

## Release lines derived from the release index (16 October 2026)

`generality.mts` now also runs central's `lines.ts` on each release index (same window, since 2023-01-01; stable
releases only) and compares the advisories' fixes per derived line with the old rule's (major, or 0.minor). Same
calls as above (4 OSV queries, 66 registry requests), no model calls.

| Package | Stable releases | Interleavings at depth 1 / 2 / 3 | Derived depth | Lines | Fixes now dated on their own line |
|---|---|---|---|---|---|
| `pkg:pypi/django` | 112 | 28 / 0 / 0 (4.1.5 on 2023-01-02, 4.0.10 on 2023-02-14) | **2** | 9 | 24 |
| `pkg:cargo/tokio` | 80 | 54 / 0 / 0 (1.18.6 after 1.20.3) | **2** | 33 | 6 |
| `pkg:golang/golang.org/x/net` | 57 | 0 / 0 / 0 | **1** | 1 (`0`) | 0 |
| `pkg:maven/org.apache.logging.log4j/log4j-core` | 16 | 0 / 0 / 0 | **1** | 1 (`2`) | 0 |

- The five fixes the major-line rule collapsed are dated per line: Django GHSA-2hrw 4.1.7 (line 4.1, next to 4.0.10
  and 3.2.18); tokio GHSA-4q83 1.20.4 and 1.24.2, GHSA-rr8g 1.43.1 and 1.44.2.
- x/net (0.x) gets one line `0`: no 0.x minor was patched after a newer one shipped, so version order is publish order
  across all of them. The old rule split it into one line per minor, which said nothing more.
- Nothing ecosystem-specific: numeric dotted versions and publish dates. PEP 440 pre- and post-releases (`5.0a1`,
  `.post1`) are not numeric dotted and are left out of the derivation (they keep the old rule at the edge).
