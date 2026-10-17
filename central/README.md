# central

The central pipeline: the **collector**, which checks upstream docs, feeds and pricing pages and reports what changed, and the **catalog pipeline**, which turns official release notes into published capability records.

```sh
npm install
npm test                      # unit and local-server tests
npm run typecheck
npm run collect -- test/fixtures/live-sources.json --store .store   # check 103 live sources
npm run replay:node           # acceptance test (needs the Slice 2 corpus in ~/Library/Caches/ati-slice2)
```

## Catalog pipeline

```sh
npm run pipeline                         # fetch → extract → label → classify → match → publish, all technologies
npm run pipeline -- --tech next --limit 3   # smoke run: one technology, its 3 oldest releases in the window
npm run pipeline -- --refresh            # re-list GitHub releases even inside the 12-hour freshness window
npm run catalog -- show <id>
npm run catalog -- correct <id> change_type=removal replaces=a,b [--claim] [--note text]
npm run catalog -- merge <from-id> <into-id>
npm run catalog -- retract <id> [--note text]
npm run catalog -- publish [--tech next]
npm run catalog -- usage                 # model calls and tokens from the usage log
npm run catalog -- prune [--dry-run]     # delete shards no index has referenced for 7 days (history in catalog/history/)
npm run catalog -- export <dir>          # prune, then a static copy of v1/ (with components, .nojekyll) for GitHub Pages
```

State and caches live in `../.store/central/` (override the root with `UNSTALE_STORE`); the catalog is written to
`../.store/catalog/v1/` (root, per-technology index, content-addressed shards). Every model call is cached and every
ingested extraction is recorded, so a rerun makes no uncached calls and writes byte-identical files.

| File | Role |
|---|---|
| `src/pipeline/fetch.ts` | Stable GitHub releases since 2025-10-15 (`GITHUB_TOKEN`, else `gh auth token`), stored raw with a `sha256:` snapshot |
| `src/pipeline/extract.ts`, `llm.ts` | Extraction and free-text labels (subject, summary, terms, replaces, requires, prerequisites, conditions) |
| `src/pipeline/classify/adapter.ts` | Classifier adapter: Jev first, the extraction model answering choices as the per-request fallback, cache, usage log |
| `src/pipeline/classify/labels.ts`, `vocab.ts`, `thresholds.ts` | change_type, surface, breaking and benefit questions; thresholds |
| `src/pipeline/match.ts`, `store.ts` | Matching at ingest, id minting, revision and label counters, merge and retraction |
| `src/pipeline/publish.ts` | Shards per technology and release line, index, root; every line validated by the generated Zod |
| `src/pipeline/prune.ts` | Shard history (`catalog/history/<tech>.json`, outside `v1/`) and the 7-day grace-period prune |
| `src/pipeline/export.ts` | Static export: verified copy of `v1/` with the served `components`, built aside and swapped in |

## Operator environment

Every variable is optional; the defaults suit a developer machine.

| Variable | Default | What it does |
|---|---|---|
| `UNSTALE_STORE` | `<repo>/.store` | Root of the central state (`central/`) and the published catalog (`catalog/`) |
| `UNSTALE_CENTRAL_DIR` | `$UNSTALE_STORE/central` | Central state and caches alone (a rebuild into a side store) |
| `UNSTALE_CATALOG_DIR` | `$UNSTALE_STORE/catalog` | The published catalog alone |
| `UNSTALE_HOST` | `127.0.0.1` | `serve`: listen address (`0.0.0.0` in a container) |
| `UNSTALE_PORT` | `47831` | `serve`: listen port |
| `GITHUB_TOKEN` | output of `gh auth token` | GitHub API token for release lists, docs resolution, admission signals and the sample |
| `UNSTALE_EXTRACT_MODEL` | `vercel:openai/gpt-6-luna` | Extraction and the classifier's fallback, `provider:model` (`vercel` is the AI gateway, flex tier; `openai` the OpenAI API) |
| `AI_GATEWAY_API_KEY` | read from `~/.config/ati/vercel.env` | AI gateway key |
| `JEV_API_KEY` | read from `UNSTALE_JEV_ENV_FILE` | Jev classifier key |
| `UNSTALE_JEV_ENV_FILE` | `~/.config/ati/jev.env` | Env file holding `JEV_API_KEY=` when the variable itself is unset |
| `UNSTALE_RATE_PER_HOUR` | `250` | `serve`: new technologies one client address may register per hour (a known one is never refused) |
| `UNSTALE_VOTES_PER_HOUR` | `1000` | `serve`: votes (requests for a known technology) one client address may cast per hour, a bucket apart from new technologies; over it a vote is not counted |
| `UNSTALE_NEW_PER_DAY` | `100` | `serve`: new technologies accepted per UTC day, all clients together |
| `UNSTALE_RUNS_PER_DAY` | `1000` | `serve`: coverage job runs (first analysis, retries, refreshes) started per UTC day |
| `UNSTALE_BUDGET_TOKENS` | `1000000` | Release-note tokens (characters / 4) extracted per budget period, all technologies together; 0 stops extraction. The ingest workflow sets 2,500,000 |
| `UNSTALE_BUDGET_PERIOD` | `day` | The token budget's UTC period: `day`, `week` or `month` |
| `UNSTALE_TECH_QUARTER_TOKENS` | `50000` | Release-note tokens one technology may use per calendar quarter before the rest waits behind other technologies |
| `UNSTALE_TRUST_PROXY` | `0` | `serve`: number of proxies in front whose `X-Forwarded-For` entry is trusted (`true` = 1); 0 uses the socket address |
| `UNSTALE_NO_ADVISORIES` | unset | `1` skips the advisories stage after a technology's history is published |
| `UNSTALE_LOCK_TIMEOUT_MS` | `1200000` (20 minutes) | How long a writer waits for a technology's lock before failing |
| `UNSTALE_BIN` | `<repo>/local/target/release/unstale` | Client binary used for `count-terms` by the rarity sample |
| `UNSTALE_GATEWAY_URL`, `UNSTALE_GATEWAY_TOKEN` | unset | `drain`: the gateway whose held registrations are pulled and acknowledged; unset, only the saved queue is worked |

## Deploy

```sh
docker build -t unstale-central central
docker run -d -p 47831:47831 -v unstale-store:/data -e GITHUB_TOKEN -e JEV_API_KEY -e AI_GATEWAY_API_KEY unstale-central
```

Node 24 runs `src/` directly (type stripping), so there is no build step. The image runs as `node` (uid 1000) with
`UNSTALE_STORE=/data` on a volume and `UNSTALE_HOST=0.0.0.0`; the healthcheck calls `GET /health`. Coverage jobs
need `GITHUB_TOKEN`, `JEV_API_KEY` and `AI_GATEWAY_API_KEY`; serving the catalog needs no secrets.

Without an always-on host, coverage runs in batches (`.github/workflows/ingest.yml`): `npm run drain -- [--minutes
240] [--taken <file>]` pulls the gateway's registrations, works the queue until nothing more can start or the
deadline passes, and writes each job's status for `catalog export`; `npm run drain -- ack <file>` acknowledges them
after the deploy. The gateway (`gateway/`) is the public address in that setup.

## How a check works

1. Fetch with pinned headers (`Accept` per format), a conditional request when a snapshot exists, and per-host and global concurrency limits. Redirects are followed manually and every hop is checked against private and reserved addresses.
2. Skip if the raw bytes match the last run and the watch config is unchanged.
3. Extract text by format: HTML to Markdown (content selector or `main`, chrome removed), Markdown and plain text as-is, JSON with sorted keys, feeds as one block per item, and sitemaps as sorted URLs. A response in the wrong format is a failure, not a change.
4. Normalize (per-watch drop and replace rules; canonical Markdown for generated copies), store content-addressed, and diff against the previous snapshot.

Outcomes: `first_seen`, `not_modified`, `unchanged`, `changed` (with the line diff, flagged when it reverts to an earlier snapshot), `rebaseline` (watch config changed), or `failed` with a closed failure kind. A failure keeps the last good snapshot.

`discover.ts` finds a docs page's Markdown copy and accepts it only if it covers at least 90% of the page's content words. `template.ts` groups identical diffs on several pages of one host into one template event.

## Layout

| File | Role |
|---|---|
| `src/collector/schema.ts` | Watch specs, outcomes and state (Zod) |
| `src/collector/http.ts`, `url-safety.ts`, `decode.ts` | Fetching |
| `src/collector/extract.ts`, `normalize.ts`, `diff.ts` | Text and comparison |
| `src/collector/store.ts` | Snapshot and state store (filesystem; interface for object storage) |
| `src/collector/collector.ts` | The check loop and worker pool |
| `src/collector/discover.ts`, `template.ts` | Markdown copy discovery; template events |
| `scripts/` | Replay acceptance, scale test, discovery and archive analysis |
