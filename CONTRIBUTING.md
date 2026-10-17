# Contributing

## Layout

| Path | What |
|---|---|
| `local/cli/` | The `unstale` client (Rust): stack detection, catalog sync, ranking, reports, agent skills |
| `local/schema/` | Rust types that define the catalog and ledger contract; `schema/` is generated from them |
| `central/` | The catalog service (TypeScript): collection, extraction, matching, classification, publishing |
| `gateway/` | The public address (Cloudflare Worker): the exported catalog as static files, the coverage protocol, the registration queue |
| `npm/` | npm packaging of the prebuilt client binaries |
| `scripts/` | Development and end-to-end scripts (below) |
| `eval/` | Evaluation harnesses and results; several import a private replay harness and are kept for reference |

## Tests

```sh
cargo test --manifest-path local/Cargo.toml       # client unit and end-to-end tests
npm --prefix central run typecheck
npm --prefix central test
npm --prefix central run check:schema             # generated schema and Zod match the Rust types
npm --prefix gateway run typecheck && npm --prefix gateway test
```

A client following a fast-track run can be previewed locally: `node gateway/scripts/preview.ts --new pkg:npm/picocolors`
runs the gateway with a played coverage run in place of GitHub (catalog and known statuses from the live gateway) and
keeps running; in a second terminal, run `unstale init --service http://127.0.0.1:8787` in a repository that depends on
that package. `--declined` and `--stall`
play the other outcomes.

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
| `.github/workflows/ci.yml` | every pull request and push to `main` | The commands under [Tests](#tests) (Rust job; central job with Rust for the schema checks; gateway job with a `wrangler deploy --dry-run` bundle), Node 24 |
| `.github/workflows/release.yml` | tag `v*` | Checks the tag equals the crate version; `npm/build.sh <platform>` per platform (darwin on macOS, linux and win32 with cargo-zigbuild on Ubuntu); runs every binary on a native runner; `npm publish` per package (`--dry-run` until `NPM_PUBLISH` is `true`; `--provenance` while the repository is public); generates the Homebrew formula (`npm/homebrew-formula.sh`) and commits it to the tap when publishing for real |
| `.github/workflows/ingest.yml` | daily while the repository is private (every 3 hours once public), manually, and from the gateway (fast-track) | Restores the central store; runs `pipeline --refresh` (catalog technologies) and `drain` (registrations pulled from the gateway, refreshes, new technologies by demand, ties broken by adoption, under the coverage budget); exports and verifies the static catalog; deploys it with the gateway; saves the store; acknowledges the registrations it took |

Secrets and variables (Settings > Secrets and variables > Actions):

| Name | Kind | Used by | What for |
|---|---|---|---|
| `UNSTALE_DEFAULT_SERVICE` | variable | release | Compiled into the client as the service `init` uses by default; the release fails when it is empty or not `https://` |
| `UNSTALE_CATALOG_KEY` | variable | release, ingest | The catalog's Ed25519 public key, 64 hex characters. Compiled into the client, which then refuses an HTTP catalog whose root or indexes are not signed with the matching private key; ingest verifies the export against it before deploying. Create the pair once: `openssl genpkey -algorithm ed25519 -out unstale-signing.pem`, then `openssl pkey -in unstale-signing.pem -pubout -outform DER \| tail -c 32 \| xxd -p -c 64` prints this value |
| `UNSTALE_SIGNING_KEY` | secret | ingest | The private key, the whole of `unstale-signing.pem`: `catalog export` signs `v1/root.json` and every `v1/tech/*.json` (`<file>.sig`, hex). Keep a copy offline; rotating it needs a client release with the new public key |
| `NPM_PUBLISH` | variable | release | `true` publishes to npm (trusted publishing) and to the Homebrew tap; anything else is a dry run |
| `HOMEBREW_TAP` | variable | release | The tap repository the formula is committed to (`owner/homebrew-tap`); unset, the formula is only an artifact |
| `HOMEBREW_TAP_TOKEN` | secret | release | Fine-grained token with Contents: write on the tap repository only |
| `INGEST_GITHUB_TOKEN` | secret | ingest | Optional. Passed to central as `GITHUB_TOKEN`: a fine-grained token with public read-only access (5,000 requests an hour). Without it the workflow token is used, limited to 1,000 an hour per repository |
| `JEV_API_KEY` | secret | ingest | Jev classifier |
| `AI_GATEWAY_API_KEY` | secret | ingest | Extraction (`UNSTALE_EXTRACT_MODEL=vercel:openai/gpt-6-luna`, set in the workflow) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secrets | ingest | `wrangler deploy` of the gateway with the exported catalog |
| `GATEWAY_DRAIN_TOKEN` | secret | ingest | Reads and acknowledges the gateway's queue and reports a run's progress on the packages it pulled; the same value is the Worker's `DRAIN_TOKEN` secret |
| `UNSTALE_GATEWAY_URL` | variable | ingest | The deployed Worker's address (`https://unstale.<subdomain>.workers.dev`, or a custom domain) |
| `UNSTALE_BUDGET_TOKENS` | variable | ingest | Release-note tokens a day the coverage budget allows (default 250,000 in the workflow) |
| `ASSET_FILE_LIMIT` | variable | ingest | Static files a Worker version may hold: 20,000 on the free plan (default), 100,000 on the paid plan |

The Worker's own settings are in `gateway/wrangler.jsonc` (`RATE_PER_HOUR`, `VOTES_PER_HOUR`, `NEW_PER_HOUR`,
`MAX_PENDING`, `FAST_TRACK_PER_DAY`, `FAST_TRACK_INTERVAL_MINUTES`). Its secrets are set once with `npx wrangler secret put` in `gateway/`: `DRAIN_TOKEN`,
and for fast-track `GITHUB_DISPATCH_TOKEN`, a fine-grained token with **Actions: write** on this repository only.

The workflow's own token (`github.token`) manages the state release; nothing else is needed for CI. npm publishing
needs no secret: each of `@unstale/cli`, `@unstale/create` and `@unstale/cli-*` names this repository and
`release.yml` as its trusted publisher on npmjs.com, and every `npm/*/package.json` has a `repository` field naming
this repository (checked before a real publish). `release.yml`'s header has the details.


**Ingest state.** The central store (`UNSTALE_STORE`: `central/` and `catalog/`) survives the ephemeral runner as
assets of a draft release tagged `catalog-state`: each generation is `state-<stamp>.tar.zst.aa, .ab, …` (a zstd
tarball split under the 2 GiB asset limit) plus `state-<stamp>.sha256`, uploaded last, so a generation without it is
ignored. The newest three are kept. The state is saved after a failed pipeline or drain too (paid model calls are
kept), but a catalog is deployed only after the pipeline, the drain, the export and the verification (every index's
shards present with the stated size and sha256) all pass, and the gateway's queue is acknowledged only after the
deploy and the save. actions/cache is not used for it: entries are evicted after 7 days without
access and share a 10 GB limit. With no saved state the run fails unless started manually with `bootstrap`, which
re-ingests from scratch with every model call uncached; to start from an operator's store instead:

```sh
gh release create catalog-state --draft --title "catalog state" --notes "Central store snapshots for the ingest workflow."
gen="state-$(date -u +%Y%m%dT%H%M%SZ)-seed-1"; mkdir -p /tmp/seed
COPYFILE_DISABLE=1 tar -C .store --exclude='./central/records/*.lock' --exclude='./central/sample' --exclude='./central/onboarding/documents' \
  -cf - ./central ./catalog | zstd -T0 -10 -q | split -b 1900m -a 2 - "/tmp/seed/$gen.tar.zst."
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
