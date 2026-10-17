# Public repositories for coverage and QA

Repositories that use coding agents (they carry an `AGENTS.md` or `CLAUDE.md`), so the population is unstale's
users, not GitHub at large. Reusable across evaluations: ecosystem coverage, client latency, coverage-job timing
(vault: Onboarding DX - Gap Hypotheses, H4 and H6) and later QA.

| File | What |
|---|---|
| `census-repos.txt` | 200 repositories from `gh search code --filename AGENTS.md` and `--filename CLAUDE.md` (100 each, deduplicated), 15 October 2026 |
| `census.py` | Ecosystems per repository from its file tree (manifests in tests, examples, docs, vendored code not counted) |
| `census.json` | The result: repository → ecosystems |
| `select.py` | A stratified subset: primary ecosystem × size tercile, up to 3 per cell, deterministic order, pinned commits |
| `set.json` | That subset: 48 repositories (npm, PyPI, Go 9 each; crates.io 7; Maven/Gradle 5; other 9), 15 October 2026 |

## Census, 15 October 2026

200 repositories read; 41 have no recognised manifest. Share of all 200 that contain each ecosystem:

| Ecosystem | Repositories | Share |
|---|---|---|
| npm | 81 | 40.5% |
| PyPI | 42 | 21.0% |
| Go modules | 24 | 12.0% |
| crates.io | 21 | 10.5% |
| Maven/Gradle | 15 | 7.5% |
| RubyGems | 8 | 4.0% |
| SwiftPM | 4 | 2.0% |
| NuGet | 4 | 2.0% |
| pub | 4 | 2.0% |
| Composer | 3 | 1.5% |
| Hex | 1 | 0.5% |

- 86 of the 159 repositories with a manifest (54%) are fully covered by npm and PyPI; 56 are npm-only.
- Against GitHub Octoverse 2025 (TypeScript, Python, JavaScript, Java, C#), agent users rank **Go and Rust above
  Java and C#**. Next ecosystem after PyPI: Go modules.
- Limits: code search returns best-match order, not a random sample, and caps at 100 results per query; 200 is
  small. Rerun with more queries (by path or language) before a decision that turns on a few points.

## Pinned set (`set.json`)

For runs that cost per repository: coverage-job timing (`eval/eta/`), client latency across stacks and sizes, and QA
on stacks beyond the replay events (which are all JavaScript). Size terciles over the census: under 2.8 MB, 2.8 to
19 MB, above 19 MB. Large Rust and Java repositories are scarce in the census, so those cells hold 1. Rerun
`select.py` only to refresh deliberately; a run that compares builds must use the same `set.json`.
