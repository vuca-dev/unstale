# Expanded replay events (15 October 2026)

**Repositories used by these events. Exclude them from any other sample (term-rarity, onboarding, evaluation):**

- chmonitor/chmonitor
- navikt/aksel
- jhb-software/payload-plugins
- cohstats/coh2stats
- sigle/sigle
- cedarjs/cedar
- arthurfiorette/prisma-json-types-generator
- omar-dulaimi/prisma-zod-generator
- hmake98/nestjs-temporal-core
- xballoy/coros-api
- satisfactory-factories/application
- EUDIPLO/eudiplo

12 new upgrade events (4 each for Next.js 15 → 16, Prisma 6 → 7 and NestJS 11 → 12) in public repositories, chosen by a
written rule, with answer keys built the way the vault describes ("Replay: reviews at the commit before a real upgrade"),
and each key change marked required or optional by a stated rule. Runnable with `../run_replay.py` (`--set new|all`).
Deterministic metrics: `../RESULTS-expanded.md`.

## Selection rule (applied by script, `selection/`)

1. **Candidates:** repositories with merged PRs found by `gh search prs` (merged 2025-10-20 to 2026-10-15) whose titles
   name the major: Renovate/Dependabot major bumps ("update nextjs monorepo to v16", "bump prisma from 6", "update nest
   monorepo to v12"…) and maintainer titles ("upgrade to Next.js 16", "Prisma 7", "NestJS 12"…). about 6,000 PR hits, 3,458 repositories.
2. **Repository filter (GitHub metadata):** not a fork, template or archived; 30–3,000 stars (popular repositories are
   left to the term-rarity sample); 300+ commits; created before 2025-07-01; primary language TypeScript or
   JavaScript; description and name free of template/starter/boilerplate/tutorial/course/example/demo/portfolio/blog;
   not owned by the framework vendor (nestjs, prisma, vercel); not used anywhere in evaluation (the slice0 corpus and
   e2e repositories, `~/ati-slice2`, `~/unstale/eval`, the catalog-v2 rarity sample: none overlapped).
3. **Upgrade commit (`selection/detect.py`):** the first first-parent commit on the default branch whose diff moves the
   package's major in a `package.json` from the old to the new major (`next` 15 → 16; `prisma`/`@prisma/client` 6 → 7;
   `@nestjs/core`/`@nestjs/common` 11 → 12), ignoring manifests under example, fixture, demo, playground, sandbox,
   test, e2e and `dev`/`dev_*` directories. P = its first parent.
4. **Event filter (`selection/select.py`):** at least 3 changed files besides manifests, lockfiles and changelogs (not a
   version-only bump); at least 10 test files at P; at least 300 commits before P; upgrade at least 7 days old; the
   commit subject names the technology; not a "sample" project.
5. **Choice:** among events passing, the first 4 per technology by sha256 of the repository name. Versions are the
   locked versions at P and at the upgrade commit (`selection/versions.py`); the subdir is the app whose manifest moved,
   or the root for multi-package repositories.

Repositories rejected after the first pick, when step 3 was tightened to ignore example and fixture manifests: daniel-ac-martin/NotGovUK (the major moved only in `apps/next-example`) and DataDog/dd-trace-js (only in a test-fixture manifest). The first search left only 4 passing Next.js candidates, so a second round of title searches by date window was added for Next.js; the chosen four are the first by hash among everything passing. For Prisma, omar-dulaimi/prisma-zod-generator came in for dd-trace-js. Notable rule rejections: opral/paraglide-js (upgrade under 7 days old),
cds-snc/platform-forms-client and scaleway/ultraviolet (commit subject does not name Next), hantsy/nestjs-rest-sample
(sample project), many Renovate bumps with no code change. Passing but not chosen (reserves, in hash order):
Next: wei/socialify, boardsesh/boardsesh, Brandawg93/PeaNUT, opencollective/opencollective-frontend, godaddy/gasket,
cosmik-network/semble and others; Prisma: cmintey/wishlist, socialincome-san/public; NestJS: jmcdo29/nest-commander,
golevelup/nestjs, nest-modules/ioredis, g59/nestjs-plugins, Lokicoule/nestjs-cognito.

## Split (fixed before any scoring)

Within each technology, events sorted by sha256("split:" + event name); the first two are DEV, the other two HELD-OUT.
The original three events (workout-next16, invoicerr-prisma7, invoicerr-nest12) are DEV: they were already used for
tuning. DEV: 9 events; HELD-OUT: 6.

## Events

Pins: P (the snapshot reviewed), the upgrade commit, and the last commit within 30 days of it (the end of the key
window). Clones are not committed; `git clone https://github.com/<repo>` and check out the pins.

| Event | Repository | Split | Locked version | P | Upgrade | Window end | Subdir | Draft items | Dropped | Key | Required | Optional |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `chmonitor-next16` | [chmonitor/chmonitor](https://github.com/chmonitor/chmonitor) | HELD-OUT | 15.4.7 → 16.0.7 | `c5bbcb3395fe` | `29f368ebe189` | `8cc8a28ce830` | (root) | 11 | 0 | 13 | 8 | 5 |
| `aksel-next16` | [navikt/aksel](https://github.com/navikt/aksel) | DEV | 15.5.9 → 16.1.2 | `cb7ac11a6a90` | `745863f53d75` | `547a565afaa4` | aksel.nav.no/website | 15 | 6 | 9 | 3 | 6 |
| `payloadplugins-next16` | [jhb-software/payload-plugins](https://github.com/jhb-software/payload-plugins) | DEV | 15.4.11 → 16.2.6 | `8b2d5b725f46` | `d1320cdab3f6` | `b76360b84161` | (root) | 10 | 2 | 8 | 4 | 4 |
| `coh2stats-next16` | [cohstats/coh2stats](https://github.com/cohstats/coh2stats) | HELD-OUT | 15.5.15 → 16.2.9 | `946c242e7975` | `7207e73ab3db` | `d9e9d2ed02d2` | packages/web | 8 | 3 | 5 | 0 | 5 |
| `sigle-prisma7` | [sigle/sigle](https://github.com/sigle/sigle) | HELD-OUT | 6.14.0 → 7.4.1 | `07723e20a2e0` | `d8b2f6716d42` | `6f08fbee1122` | apps/server | 5 | 1 | 4 | 4 | 0 |
| `cedar-prisma7` | [cedarjs/cedar](https://github.com/cedarjs/cedar) | DEV | 6.19.2 → 7.4.2 | `cffa7bc50cef` | `446abbc34408` | `3e4070dc47c0` | (root) | 23 | 0 | 23 | 16 | 7 |
| `jsontypes-prisma7` | [arthurfiorette/prisma-json-types-generator](https://github.com/arthurfiorette/prisma-json-types-generator) | HELD-OUT | 6.17.1 → 7.0.0 | `9dc2fa93d196` | `be8491b096a6` | `cad46d2e1147` | (root) | 13 | 1 | 12 | 6 | 6 |
| `zodgen-prisma7` | [omar-dulaimi/prisma-zod-generator](https://github.com/omar-dulaimi/prisma-zod-generator) | DEV | 6.19.0 → 7.0.0 | `ee8ace51b15e` | `41ae03b63d1c` | `e1f3381c1aa9` | (root) | 15 | 0 | 15 | 11 | 4 |
| `temporal-nest12` | [hmake98/nestjs-temporal-core](https://github.com/hmake98/nestjs-temporal-core) | DEV | 11.2.5 → 12.1.2 | `e4d4f858802d` | `6e9fa80e2815` | `0fd9e9a2e66d` | (root) | 16 | 0 | 16 | 5 | 11 |
| `coros-nest12` | [xballoy/coros-api](https://github.com/xballoy/coros-api) | DEV | 11.2.3 → 12.0.1 | `d63f3fc4024e` | `2f0e89dbff8f` | `cc92fa747f91` | (root) | 4 | 0 | 4 | 1 | 3 |
| `satisfactory-nest12` | [satisfactory-factories/application](https://github.com/satisfactory-factories/application) | HELD-OUT | 11.2.3 → 12.0.3 | `93f06203e8ff` | `70bbf9102c1e` | `f4970dd37285` | backend | 6 | 2 | 4 | 1 | 3 |
| `eudiplo-nest12` | [EUDIPLO/eudiplo](https://github.com/EUDIPLO/eudiplo) | HELD-OUT | 11.2.1 → 12.0.1 | `68a7f6cb606d` | `57c64a05240a` | `a6a67b3beb5c` | apps/backend | 5 | 0 | 5 | 3 | 2 |

Original events (keys from `~/ati-slice0/replay/<event>/key.json`, unchanged; labels in `labels_orig.json`):

| Event | Split | Key | Required | Optional |
|---|---|---|---|---|
| `workout-next16` | DEV | 10 | 3 | 7 |
| `invoicerr-prisma7` | DEV | 16 | 16 | 0 |
| `invoicerr-nest12` | DEV | 14 | 13 | 1 |

Totals: DEV 9 events, 115 key changes (72 required, 43 optional); HELD-OUT 6 events, 43 (22 required, 21 optional).

## How the answer keys were built

- **Draft:** the slice0 method unchanged: `replay.key` (the harness's KEY prompt) through `codex exec` with
  `gpt-5.6-luna`, read-only, in a full clone, listing every change the maintainers made because of the upgrade in the
  upgrade commit and the 30 days after it, with `responds_to`. 12 calls. Raw drafts: `keys/drafts/`.
- **Review:** I read every draft item against the commits and diffs (and the upstream guides as they stand: Next.js
  `version-16.mdx`, Prisma `upgrade-prisma-orm/v7.mdx`, NestJS `migration.md`), without opening the unstale catalog.
  Decisions per item with reasons: `review/<event>.json`; applied by `selection/finalize.py`. 13 items dropped (reverted
  pairs, flip-flops with no net change, features or fixes with no link to the upgrade, adaptations to another library's
  release), 1 item rewritten and 2 added (chmonitor: `turbopack: {}` for the webpack config, removal of the `eslint`
  next.config key). Malformed draft ids (zodgen) were renumbered; `draft_id` keeps the original.

## Required vs optional (rule, not a classifier)

A key change is **required** when the project, upgraded with that change left out, would fail or behave differently,
shown by either:

- **S (source):** the official upgrade guide or release notes say the old usage is removed, now an error, a raised
  minimum (Node, TypeScript), or a changed default that this project relies on (e.g. Turbopack by default with an
  existing `webpack()` config; `revalidateTag` single-argument form is a type error; schema `url` no longer accepted;
  driver adapters required; Terminus `HealthIndicator` removed); or
- **D (diff):** the commit or diff shows it fixes a failure the upgrade caused (an error, a failed build, type check,
  test or install; e.g. Jest unable to load ESM-only packages, a peer-range conflict for a library's consumers).

Knock-on fixes of a required root cause count as required, and so does the maintainers' chosen way of fixing it
(Biome for the removed `next lint`, Vitest for Jest). **Optional:** deprecated-but-working APIs (middleware → proxy,
`images.domains`), new opt-in features (React Compiler, Activity, Turbopack caches), settings the framework writes
itself (`.next/dev/types`, `jsx: react-jsx`), moving one's own code to ESM (NestJS 12 says it is optional), cleanup,
docs, release tooling, codemods for downstream users, and knock-ons of an optional root. Each item carries
`required`, `required_rule` (with S/D) in `keys/<event>.json`.

The original 40 changes were labelled by the same rule (`labels_orig.json`): 32 required, 8 optional. This differs from
the earlier classifier labels (35 / 5) mainly on Next.js 16: middleware → proxy, `images.domains`, the redundant
`--turbopack` flag and tsconfig settings are optional by the rule.
