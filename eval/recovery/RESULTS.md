# 0.2.8 recovery validation (2026-10-26)

Five interrupted fixes (#155, #156, #158–#160) were integrated over main cdfd402 (#150 and #161 included), resolving
their central pipeline hook overlaps. Main's subsequent #162 changes only the website. The crate and seven npm
packages are bumped together to 0.2.8.

## Replay gate

`GATE_K=0`, the combined client and full-store catalog with deduplication, advisory APIs and type-stub records:
**DEV 27/72, HELD-OUT 6/22**, equal to the full-store reference. All 15 queues completed. The match stage reused
30 cached maps, with no new model calls. Raw data: `../gate/results/recovery-combined.*`.

## Frozen v3 panel

Attempts 27, 28, 31, 33–38, 40, 42, 44–51 (19 repositories), pinned to their saved commits. A scratch copy of
scout.db retains the frozen v3 pool and labels. Each clean checkout is seeded only with its saved coverage jobs
(package-to-technology mappings), then initialized against the frozen local catalog. Registry metadata is reused
from a copied cache. No new labels or model judgements are made. A first fixture without the coverage mappings
undercounted the catalog and was discarded; it is not the evidence below.

| Full-list metric | Main | Combined |
|---|---:|---:|
| A+B findings / frozen pool | 118/260 | 118/260 |
| Tier-A findings / frozen pool | 53/117 | 53/117 |
| Weighted findings | 224/494 | 224/494 |
| Client context tokens | 164,633 | 164,730 |
| Labelled A+B in top eight | 40/140 | 38/140 |

The required full-list and tier-A counts do not fall; context cost rises 0.06%. Top-eight precision is not improved:
an added type-stub lead displaces a previously labelled item, and an advisory lead changes; newly worded findings
remain unlabelled. Precision tuning remains paused. This is a regression check, not a fresh accuracy estimate.

### Identity correction, with raw results retained

The uncorrected text-key comparison reads 118→116 A+B findings, with tier-A flat. The two apparently lost findings
are still present at the same cited files, with the same source URL and byte-identical evidence-bearing lead:
Electron's clipboard change in Insomnia and Nx's targetDefaults change in Material UI. Deduplication changes only
the count-bearing prefix of these upgrade lines (for example Nx's 7 advisories becomes 5). The older harness assigns
a new item key because of those counts.

`identity.py` links only unique reference items at the same commit, package, installed and target versions, source
URL and full lead (which must name a record and a cited file). Other records' broad related-file lists may change.
It changes item-key links only; the frozen pool, label values, tiers and rendered reports remain unchanged. Tests
reject changed versions, sources, lead records, cited files and lead text. Every link is saved in `identity-links.json`.
`raw-totals.json` preserves the uncorrected measurement; `linked-totals.json` gives the conservative linked result.

## Other checks

- Central: 521 tests and typecheck; Rust/JSON/Zod schema consistency.
- Rust: 321 unit, 19 end-to-end and 12 schema tests pass (one intentional live measurement ignored).
- Gateway with #162: 58 tests and typecheck.
- Original wavesurfer.js cdef4ac: no cy.stub lead at its zero-argument calls with the combined binary.
- All npm versions and internal package pins match 0.2.8.

Local suites that bind loopback sockets or inspect processes require execution outside the sandbox. Their
restricted-environment failures were rerun with that access; the passing runs above are the relevant checks.

## Remaining scope

The ts-jest globals release bound/configuration subject and the remaining matcher/coverage backlog are explicitly
deferred. The scout pause and the user's uncommitted main checkout are preserved. This release does not close the
whole known-bugs backlog.
