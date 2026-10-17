# Contributing

## Layout

| Path | What |
|---|---|
| `local/cli/` | The `unstale` client (Rust): stack detection, catalog sync, ranking, reports, agent skills |
| `local/schema/` | Rust types that define the catalog and ledger contract; `schema/` is generated from them |
| `central/` | The catalog service (TypeScript): collection, extraction, matching, classification, publishing |
| `npm/` | npm packaging of the prebuilt client binaries |
| `scripts/` | Development and end-to-end scripts (below) |
| `eval/` | Evaluation harnesses and results; several import a private replay harness and are kept for reference |

## Tests

```sh
cargo test --manifest-path local/Cargo.toml       # client unit and end-to-end tests
npm --prefix central run typecheck
npm --prefix central test
npm --prefix central run check:schema             # generated schema and Zod match the Rust types
```

## Scripts

| Script | Purpose |
|---|---|
| `scripts/prepare-dogfood.sh` | Build the client for this platform, install it under `.dev/`, start the local service |
| `scripts/dev-central.sh start\|stop` | Run the catalog service on `127.0.0.1:47831` (state in `.store/`) |
| `scripts/dev-onboard.sh <repo>` | Run the locally installed client's `init` against a repository |
| `npm/build.sh [platform…]` | Cross-build release binaries and pack the npm packages into `npm/dist/` (publishes nothing) |
| `scripts/dogfood.sh`, `scripts/http-sync-e2e.sh`, `npm/rehearse-npx.sh` | End-to-end checks; pass fixture repositories by environment variable (`DOGFOOD_E2E`, `HTTP_E2E_REPO`, `NPX_REPO`) |

Central's operator commands: `npm --prefix central run catalog -- <command>` (pipeline and publish), `run docs`,
`run serve`. Ingestion needs a GitHub token and a model CLI on the operator's side.

## Continuous integration and release

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | every push and pull request | The four commands under [Tests](#tests) (Rust job; central job with Rust for the schema checks), Node 24 |
| `.github/workflows/release.yml` | tag `v*` | Checks the tag equals the crate version; `npm/build.sh <platform>` per platform (darwin on macOS, linux and win32 with cargo-zigbuild on Ubuntu); runs every binary on a native runner; `npm publish --dry-run --provenance` per package. Publishes nothing |
| `.github/workflows/ingest.yml` | every 3 hours, and manually | Restores the central store, runs `pipeline --refresh`, exports the static catalog, verifies it, saves the store, deploys to GitHub Pages |

Secrets and variables (Settings > Secrets and variables > Actions):

| Name | Kind | Used by | What for |
|---|---|---|---|
| `UNSTALE_DEFAULT_SERVICE` | variable | release | Compiled into the client as the service `init` uses by default; the release fails when it is empty or not `https://` |
| `INGEST_GITHUB_TOKEN` | secret | ingest | Passed to central as `GITHUB_TOKEN`: a fine-grained token with public read-only access. Not the workflow token, which is limited to 1,000 API requests an hour per repository and is an installation token (the rarity sample uses repository and code search); a personal token gets 5,000 |
| `JEV_API_KEY` | secret | ingest | Jev classifier |
| `OPENAI_API_KEY` | secret | ingest | Codex CLI login (`codex login --with-api-key`); the CLI version is pinned in the workflow (`CODEX_VERSION`) |

The workflow's own token (`github.token`) manages the state release; nothing else is needed for CI. Real npm
publishing is not enabled; `release.yml`'s header says what changes (npm trusted publishing for this repository and
workflow, preferred, or an `NPM_TOKEN` secret; both need a `repository` field in each `npm/*/package.json`).

Repository settings: Pages > Source = **GitHub Actions**; the `github-pages` environment (created with Pages) must
allow deployments from `main`, the branch the schedule runs on.

**Ingest state.** The central store (`UNSTALE_STORE`: `central/` and `catalog/`) survives the ephemeral runner as
assets of a draft release tagged `catalog-state`: each generation is `state-<stamp>.tar.zst.aa, .ab, …` (a zstd
tarball split under the 2 GiB asset limit) plus `state-<stamp>.sha256`, uploaded last, so a generation without it is
ignored. The newest three are kept. The state is saved after a failed pipeline too (paid model calls are kept), but
a catalog is deployed only after the pipeline, the export and the verification (every index's shards present with
the stated size and sha256) all pass. actions/cache is not used for it: entries are evicted after 7 days without
access and share a 10 GB limit. With no saved state the run fails unless started manually with `bootstrap`, which
re-ingests from scratch with every model call uncached; to start from an operator's store instead:

```sh
gh release create catalog-state --draft --title "catalog state" --notes "Central store snapshots for the ingest workflow."
gen="state-$(date -u +%Y%m%dT%H%M%SZ)-seed-1"; mkdir -p /tmp/seed
tar -C .store --exclude='./central/records/*.lock' -cf - ./central ./catalog | zstd -T0 -10 -q | split -b 1900m -a 2 - "/tmp/seed/$gen.tar.zst."
(cd /tmp/seed && shasum -a 256 "$gen".tar.zst.* > "$gen.sha256")
gh release upload catalog-state /tmp/seed/"$gen".tar.zst.* && gh release upload catalog-state "/tmp/seed/$gen.sha256"
```

GitHub disables a public repository's scheduled workflows after 60 days without repository activity, and ingest
commits nothing; re-enable it with `gh workflow enable ingest.yml`.

## Design rules

- **No per-technology code or tables.** Knowledge lives in one adapter per ecosystem (npm, PyPI, …); a new package in
  a supported ecosystem must work with no change.
- **What cannot be checked automatically fails open.** It is shown as prose; it never hides a record.
- **Model calls run centrally, once per record or source**, never per repository on a user's machine.
- **Ranking changes are pre-registered** and measured on the replay gate (`eval/gate/`), with a held-out split that is
  never used for tuning.
