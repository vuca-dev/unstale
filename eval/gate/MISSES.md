# Why required key changes are missed (published catalog, 15 October 2026)

Catalog: the published `~/unstale/.store/catalog` (next/prisma/nestjs indexes `f7909463…`, `ba36a596…`, `fe486b75…`;
1,096 records), copied before use. Order: the shipped CLI (`git HEAD` 2877f2c, `unstale 0.1.0`) through
`eval/gate/gate.py cliqueue`. Coverage: the expanded replay's two Codex match runs (a key change is covered when both
runs map it to an entry). Key and required/optional labels: `eval/replay/events/` (rule-based). HELD-OUT events were
read here for diagnosis only. Nothing was tuned on them.

94 required key changes. 60 are covered, which leaves **34 with no catalog entry** (Part 1). Of the 60 covered,
**33 are in the CLI's first batch of 16** and **27 are not** (Part 2).

Sources checked for every Part 1 item: the stored release notes (`.store/central/releases/<tech>/*.md`: next
14.2.35 to 16.4.1, prisma 6.18.0 to 7.10.0, nestjs 10.4.21 to 12.1.3, all published on or after 2025-10-15) and the
three upgrade guides (`.store/central/guides/<tech>/`). Where those sources had nothing, I also checked the obvious
GitHub release notes outside them: Next.js v15.5.0, @nestjs/swagger 12.x and @nestjs/throttler. I read the sources
myself and made no model call for this.

## Part 1: the 34 required key changes with no catalog entry

Buckets: **1** no official source carries it (1b: a source exists, but it is the notes of a companion package the
catalog does not fetch); **2** a source carries it but extraction made no record; **3** a record exists but matching
missed it; **4** a record would exist, but the source is outside the fetch window; **5** out of scope (a knock-on of
another change, test, CI or Docker plumbing, or another library's change).

| Event | Split | Key | Change (short) | Bucket | Evidence |
|---|---|---|---|---|---|
| invoicerr-prisma7 | DEV | K8 | DB reset test runs Prisma via npx, ignores failures | 5 | Test plumbing after the CLI/env change. The root (`prisma:environment-variables`, `prisma:prisma.config.ts~2`) covers K3/K7/K9. |
| invoicerr-prisma7 | DEV | K10 | Cypress before:run reset disabled | 5 | Same root, test plumbing |
| invoicerr-prisma7 | DEV | K11 | Cypress promise resolved on disabled path | 5 | Knock-on of K10 |
| invoicerr-prisma7 | DEV | K12 | Cypress setupNodeEvents hook removed | 5 | Knock-on of K10 |
| invoicerr-prisma7 | DEV | K14 | Dockerfile copies build output to backend root | 5 | Docker layout after `output` (`prisma:output`; one match run maps it) |
| invoicerr-prisma7 | DEV | K16 | Dockerfile also copies prisma.config.ts to prisma/ and src/ | 5 | Docker. The sibling K15 is covered by `prisma:prisma.config.ts~2`, and one match run maps K16 to it too. |
| invoicerr-nest12 | DEV | K3 | SWC decorator metadata / NodeNext for Vitest | 5 | Knock-on of the Jest→Vitest move (root K1/K2 covered by `nestjs:esm-packages~2`) |
| invoicerr-nest12 | DEV | K4 | ESM spies → module mocks | 5 | Vitest API detail |
| invoicerr-nest12 | DEV | K5 | async `vi.importActual` factories | 5 | Vitest API detail |
| invoicerr-nest12 | DEV | K6 | explicit Playwright mock and reset | 5 | Vitest API detail |
| invoicerr-nest12 | DEV | K7 | `describe.skip` return type | 5 | Vitest typing detail |
| invoicerr-nest12 | DEV | K11 | PDF warm-up hook, hook budget | 5 | Test timing under Vitest |
| invoicerr-nest12 | DEV | K13 | CI Node floor 24 | 5 | Vitest 5 requires Node 22.12 (another library, CI) |
| invoicerr-nest12 | DEV | K14 | spec timeouts 20 s | 5 | Test timing |
| chmonitor-next16 | HELD-OUT | K2 | route `host` param typed number → string | 4 | Next.js **v15.5.0** (2025-08-20): "feat: automatically generate route types: #81396". The event spans 15.4.7 → 16.0.7, but the catalog fetches only releases from 2025-10-15 on. The line is thin (it does not say number params now fail the type check). |
| chmonitor-next16 | HELD-OUT | K8 | Cypress component tests disabled | 5 | Cypress's webpack internals vs Turbopack-by-default (another tool). The root record `next:turbopack` exists. |
| chmonitor-next16 | HELD-OUT | K10 | production build pinned to webpack (OpenNext Cloudflare) | 3 | `next:turbopack` ("Turbopack becomes the default bundler, with a webpack opt-out flag") and `next:webpack` (16.0.0: "Add a --webpack flag and default --turbopack to true") exist, and payloadplugins K2 (the same fix) is matched to them. Neither match run mapped this one. |
| aksel-next16 | DEV | K8 | NextLink client wrapper (vercel/next.js#85604, #85470) | 1 | No release note or guide line mentions either issue or a `next/link` regression (grep of 16.0.0 to 16.4.1). It is a workaround for an open bug. |
| payloadplugins-next16 | DEV | K1 | widen plugins' `next` peer range to `^15 \|\| ^16` | 1 | No source can carry it: every library needs it on any peer major |
| cedar-prisma7 | DEV | K12 | SQLite default URL `file:./dev.db` → `file:./db/dev.db` | 1 | The guide's adapter example still uses `file:./dev.db`. No line says relative SQLite paths now resolve from the config or cwd instead of the schema. |
| jsontypes-prisma7 | HELD-OUT | K8 | `Prisma.`-prefixed update-operation types | 1 | No mention of `Prisma.`/`runtime.` qualified generated type names in the 6.18 to 7.4 notes or the guide (grep "namespace", "FieldUpdateOperationsInput", "NullValueInput") |
| jsontypes-prisma7 | HELD-OUT | K9 | Int/Float signatures | 1 | Same cause as K8 |
| jsontypes-prisma7 | HELD-OUT | K10 | `StringNullableListFilter` signatures | 1 | Same cause as K8 |
| jsontypes-prisma7 | HELD-OUT | K11 | strip `Prisma.`/`runtime.` qualifiers | 1 | Same cause as K8 |
| jsontypes-prisma7 | HELD-OUT | K13 | `NullableJsonNullValueInput` namespace | 1 | Same cause as K8 |
| zodgen-prisma7 | DEV | K6 | generation test timeouts raised | 5 | Test timing |
| zodgen-prisma7 | DEV | K7 | augment `GetConfigOptions.ignoreEnvVarErrors` | 1 | `@prisma/internals` type change. No notes line mentions `ignoreEnvVarErrors` or `getConfig`. |
| zodgen-prisma7 | DEV | K8 | tsconfig loads the augmentation | 1 | Knock-on of K7 |
| zodgen-prisma7 | DEV | K9 | include local .d.ts in compilation | 1 | Knock-on of K7 |
| zodgen-prisma7 | DEV | K10 | legacy `getConfig` declaration | 1 | Same as K7 |
| coros-nest12 | DEV | K4 | pnpm minimum-release-age exclusion for nest-commander | 5 | pnpm policy versus another library's release |
| satisfactory-nest12 | HELD-OUT | K1 | `imports: []` on `ThrottlerModule.forRootAsync` | 1b | @nestjs/throttler release: "Import shared interfaces from the public Nest package entry point for Nest 12 compatibility". The Nest 12 guide mentions only `resolvePackageJsonExports` in the optional ESM section. |
| eudiplo-nest12 | HELD-OUT | K2 | pnpm packageExtension: TypeScript peer for @nestjs/swagger | 1b | @nestjs/swagger 12.x: "fix: declare typescript as an optional peer dependency" |
| eudiplo-nest12 | HELD-OUT | K3 | OpenAPI test asserts `type: [.., 'null']` | 1b | @nestjs/swagger 12.0.0: "3.1.0 and later — the `nullable` keyword … is gone. Typed schemas become a type union". It also says snapshot tests "will need updating". |

**Counts:**

| Bucket | All | DEV | HELD-OUT |
|---|---|---|---|
| 1, no official source | 12 | 7 | 5 |
| 1b, companion package's notes (not fetched) | 3 | 0 | 3 |
| 2, source but no record | **0** | 0 | 0 |
| 3, record but match missed | 1 | 0 | 1 |
| 4, outside the fetch window | 1 | 0 | 1 |
| 5, out of scope (knock-on, test, CI, Docker, another library) | 17 | 16 | 1 |
| **Total** | **34** | **23** | **11** |

Extraction never dropped a change its sources carry. Every required key change whose text is in a fetched source has
a record (`eval/sets/extraction-recall.json`: 61 of 61 required, 96 of 96 overall).

## Part 2: the 27 covered required changes outside the CLI's first 16

| Reason | All | DEV | HELD-OUT | Items |
|---|---|---|---|---|
| Not in the upgrade review at all: the record is not an obligation (route) | 5 | 5 | 0 | invoicerr-nest12 K9, K10, K12 (`nestjs:vitest`, tooling); cedar K5 (`prisma:prisma.config.ts~3`, new_api); zodgen K2 (`prisma:prisma-client-provider`, non-breaking default_change) |
| Not in the upgrade review: **blocked by the Node prerequisite check** | 1 | 1 | 0 | zodgen K11 (`prisma:node.js`, node ≥ 20.19.0, project `engines.node >=18.18.0`) |
| In the queue, rank 17 to 19 (just below the cut) | 8 | 7 | 1 | invoicerr-prisma7 K13 (17); aksel K7 (17); payloadplugins K2 (17), K3 (18); cedar K13 (17), K21 (18), K23 (18); sigle K2 (19) |
| In the queue, rank 20 to 68 (crowding inside tier 1) | 13 | 8 | 5 | invoicerr-prisma7 K6 (23); chmonitor K1 (20), K4 (36); aksel K2 (44); payloadplugins K8 (43); sigle K1 (34), K3 (68); cedar K9 (23), K22 (23); jsontypes K6 (23); zodgen K1 (31), K4 (65), K5 (29) |

Every ranked miss is a tier-1 record (breaking or removal), behind 16 to 66 other tier-1 records. For Next.js and Prisma
the CLI's upgrade review is 70 to 80 records, nearly all tier 1. So the type tier does not separate them, and the order
is decided by the rarity-weighted usage score. All 21 ranked misses have matched terms. The ones ranked deep, such as
`next:revalidatetag~2` at 36 and 43 and `next:publicruntimeconfig~2` at 44, match a term that many other records
also carry.

**Crowding by other technologies (as invoked).** `unstale review --target next@16…` leaves the repository's other
catalog technologies at their default target, the newest release, so their obligations share the batch: 3 of 16 in
workout-next16, 6 of 16 in invoicerr-prisma7 and 8 of 16 in sigle-prisma7. Measured, it costs 1 required change in the
first 16 (33 → 32), because the event technology's required records already sit high in those three.

## What would fix each bucket, and the return on it

| Bucket (count) | Fix | Cost | Return |
|---|---|---|---|
| 5, knock-ons and plumbing (17) | Measurement, not product: score a knock-on as found when its root key change is found (the key already names `responds_to`), or drop test, CI and Docker knock-ons from the required set | none | Large on the metric (up to 17 of 34), none for users. Do it first so the gate measures the product. |
| Part 2, tier-1 crowding (21 ranked out) | Rank inside tier 1: put a record whose `replaces` or `introduces` literals occur in the code above one matched only on common terms. Down-weight terms carried by many tier-1 records. Separate removals of things the code uses from breaking changes to things it does not use. | low (funnel order only, no model) | Highest product return. 8 are at ranks 17 to 19, so a small reordering moves them into the batch. |
| Part 2, a prerequisite blocks the obligation (1 here; it is also why `nestjs:node.js`, `next:node.js-runtime` and `prisma:node.js` drop out of 8 events' queues, and `next:typescript`, the TypeScript minimum, out of coh2stats) | In `funnel::blocked`, never block an obligation (breaking, removal) for a platform or toolchain minimum: the raised minimum *is* the obligation | trivial | Restores the Node-floor record wherever the lowest `engines.node` in the repository is below the new minimum, which is exactly where it matters. Reported to the orchestrator because agent B owns `funnel.rs`. |
| Part 2, not an obligation type (5) | `nestjs:vitest` and `prisma:prisma.config.ts~3` are required for these projects but labelled tooling or new_api. Route guide-sourced records that say "required"/"must" into the review, or let the label read "required for projects that use X". | medium (label prompt change, re-label) | 5 DEV items. Risk: grows the queue. |
| 1b, companion packages (3) | Fetch the release notes of the technology's companion packages the project uses (same GitHub organisation or npm scope: @nestjs/swagger, @nestjs/throttler, @nestjs/terminus). Discover them automatically from the lockfile and scope, with no curated list. | medium (more sources and extraction) | 3 of the 11 held-out misses. Also catches the `nullable` and peer-range changes that recur across Nest apps. |
| 4, fetch window (1) | Fetch back to the oldest version installed in the projects being served (or the previous major's .0), not a fixed date | low | 1 here. It grows with older projects: workout (15.2.6) and chmonitor (15.4.7) skip all of 15.3 to 15.5. |
| 3, match missed (1) | Instrument variance (the gate's coverage is the two-run intersection). Also `next:turbopack` is a non-breaking default_change, so it would not reach the upgrade review even if matched. | none | 1 |
| 1, no source (12) | Mostly libraries adapting to generated-code or internals shapes (jsontypes 5, zodgen 4) and one upstream bug workaround (aksel). Options: diff the published `.d.ts` of the generated client or `@prisma/internals` between versions; read the issue tracker. For peer ranges (payloadplugins K1), the CLI could emit a deterministic "widen `peerDependencies`" item when a library's peer range excludes the target major. | high (type diffing), low (peer range) | Low except the peer-range rule (cheap, recurs in every library). Type-shape changes affect only generator libraries. |
