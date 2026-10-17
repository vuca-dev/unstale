# Match audit: upgrade guides against release notes (104 pairs, 15 October 2026)

Every cross-source pair Jev scored p ≥ 0.5 when each upgrade-guide item (Next.js 16, Prisma 7, NestJS 12; 167 items)
was judged against its retrieved candidates in the release-notes-only v2 store (a dry run: `eval/guides/audit.mts`, no
store writes). Reference: Codex `gpt-5.6-luna` per pair under the v3 identity rules (`dm_match.py` RULES_V3,
"different" when unsure), 12 pairs per call. My verdict column is mine: I read every pair (quotes and summaries); the
six where I disagree with Codex are #59, #60, #62, #64, #71, #87. Data: `eval/guides/pairs.json`,
`eval/guides/verdicts.json`; simulation: `eval/guides/rule_eval.py`.

Agreement, Codex vs me, where I am not unsure: 91 of 97. My verdicts: 79 SAME, 18 DIFFERENT, 7 UNSURE.

## The rule chosen

- Quote guard only within one evidence kind (a release-notes quote is compared with the target's release-notes quotes).
- Across kinds: the breaking guard (a breaking record never merges into a non-breaking one) and the advisory guard
  unchanged, and "same" only at **p ≥ 0.85** (`CROSS_SAME_P`).
- Matching's snapshot exclusion also acts across a guide: a record that already took an item of this guide is not a
  candidate for the next item, so one guide merges at most one item into a record.
- Requests that involve a guide name each side's source and add one sentence ("The same change described in release
  notes and in an upgrade guide is the same change ..."); release-notes-only requests are byte-identical to before.

**Tuned in-sample.** The threshold was picked on Prisma and NestJS (the smallest p with no false merge there) and Next.js
was held out. Simulated per item in ingest order, best surviving candidate:

| Threshold | Tuning set (Prisma + NestJS): merges / false / missed SAME | Held out (Next.js): merges / DIFFERENT / UNSURE / missed SAME |
|---|---|---|
| 0.70 | 56 / 2 / 4 | 22 / 2 / 2 / 3 |
| 0.80 | 55 / 1 / 4 | 22 / 2 / 2 / 3 |
| **0.85** | **53 / 0 / 5** | **21 / 1 / 2 / 3** |
| 0.90 | 53 / 0 / 5 | 19 / 0 / 2 / 5 |
| 0.95 | 51 / 0 / 7 | 16 / 0 / 1 / 7 |

Out of sample at 0.85: 1 merge of 21 is DIFFERENT (#57: the `middleware.ts` deprecation into the `proxy.ts` record, the
same migration's other half) and 2 are UNSURE (#47, #56). Without the cross-kind threshold (0.7, the within-source
gate) the held-out set has 2 DIFFERENT and the tuning set 2.

**Actual ingest** (`npm run pipeline -- --offline` on the v2 store; candidate sets shift as items merge, so 75 judge
calls were new): 76 of 167 guide items merged (Next 21, Prisma 21, NestJS 34), 91 became new records. Against my
verdicts: 72 SAME, 1 DIFFERENT (#57), 2 UNSURE (#47, #56), and 1 pair outside the audit (`nestjs:validationpipe~2`, the
`errorFormat` option; I read it: SAME). Guards blocked 6 cross merges and 4 breaking ones.

**Within source unchanged.** The guide items were ingested after every release-notes item (their keys were the only
new ones), so no release-notes match was re-judged; the 83-case audit tests in `central/test/match.test.ts` pass
unchanged.

## Table

| # | tech | guide item (chunk.index, subject) | release-notes record | p | best | guard | Codex | verdict | note |
|---|---|---|---|---|---|---|---|---|---|
| 1 | nestjs | 0.1 Node.js runtime requirements | nestjs:node.js | 0.99 | yes | - | same | SAME |  |
| 2 | nestjs | 0.2 nest new | nestjs:nest-new | 1.00 | yes | - | same | SAME |  |
| 3 | nestjs | 0.3 Vitest | nestjs:vitest | 0.99 | yes | - | same | SAME |  |
| 4 | nestjs | 0.4 oxlint | nestjs:oxlint | 1.00 | yes | - | same | SAME |  |
| 5 | nestjs | 0.5 schema | nestjs:route-parameter-decorators-schema | 1.00 | yes | - | same | SAME |  |
| 6 | nestjs | 0.6 StandardSchemaValidationPipe | nestjs:standardschemavalidationpipe | 0.99 | yes | - | same | SAME |  |
| 7 | nestjs | 0.7 StandardSchemaSerializerInterceptor | nestjs:standardschemaserializerinterceptor | 1.00 | yes | - | same | SAME |  |
| 8 | nestjs | 0.8 graphiql | nestjs:graphiql | 0.72 | yes | breaking | same | SAME | same; breaking guard blocks (guide breaking, notes not) |
| 9 | nestjs | 0.9 subscriptions-transport-ws | nestjs:subscriptions-transport-ws | 1.00 | yes | - | same | SAME |  |
| 10 | nestjs | 0.11 nats | nestjs:nats-io-transport-node | 1.00 | yes | - | same | SAME |  |
| 11 | nestjs | 0.13 lifecycle hooks | nestjs:lifecycle-hooks~2 | 1.00 | yes | - | same | SAME |  |
| 12 | nestjs | 0.15 validationSchema | nestjs:configmodule.forroot-validationschema | 0.99 | yes | - | same | SAME |  |
| 13 | nestjs | 0.16 validationOptions.libraryOptions | nestjs:validationoptions-libraryoptions | 0.84 | yes | - | same | SAME |  |
| 14 | nestjs | 0.20 Rspack | nestjs:rspack | 1.00 | yes | - | same | SAME |  |
| 15 | nestjs | 0.21 --webpack | nestjs:webpack | 1.00 | yes | - | same | SAME |  |
| 16 | nestjs | 0.21 --webpack | nestjs:builder | 0.51 | no | - | different | DIFFERENT | --webpack deprecation vs --builder rspack record (replacement) |
| 17 | nestjs | 0.22 bun | nestjs:bun | 1.00 | yes | - | same | SAME |  |
| 18 | nestjs | 0.24 angular | nestjs:angular | 1.00 | yes | - | same | SAME |  |
| 19 | nestjs | 0.25 nest deploy | nestjs:nest-deploy | 1.00 | yes | - | same | SAME |  |
| 20 | nestjs | 0.26 --rspackPath | nestjs:nest-build-rspackpath | 0.55 | yes | - | same | SAME |  |
| 21 | nestjs | 0.27 --emit-declarations | nestjs:nest-build-emit-declarations | 1.00 | yes | - | same | SAME |  |
| 22 | nestjs | 0.28 --no-type-check | nestjs:nest-build-no-type-check | 0.99 | yes | - | same | SAME |  |
| 23 | nestjs | 0.30 --parallel | nestjs:nest-build-parallel | 0.95 | yes | - | same | SAME |  |
| 24 | nestjs | 0.31 includeLibraryAssets | nestjs:nest-cli.json-includelibraryassets | 1.00 | yes | - | same | SAME |  |
| 25 | nestjs | 0.33 routeResolutionStrategy | nestjs:routeresolutionstrategy | 0.99 | yes | - | same | SAME |  |
| 26 | nestjs | 0.34 errorCode | nestjs:httpexceptionoptions-errorcode | 1.00 | yes | - | same | SAME |  |
| 27 | nestjs | 0.35 structuredParams | nestjs:consolelogger-structuredparams | 1.00 | yes | - | same | SAME |  |
| 28 | nestjs | 0.36 flattenParams | nestjs:flattenparams | 0.99 | yes | - | same | SAME |  |
| 29 | nestjs | 0.37 @nestjs/observe | nestjs:nestjs-observe | 1.00 | yes | - | same | SAME |  |
| 30 | nestjs | 0.38 instrument | nestjs:nestfactory.create-instrument | 0.99 | yes | - | same | SAME |  |
| 31 | nestjs | 0.40 ArgumentMetadata | nestjs:argumentmetadata | 1.00 | yes | - | same | SAME |  |
| 32 | nestjs | 0.41 GrpcExceptionFilter | nestjs:grpcexceptionfilter | 1.00 | yes | - | same | SAME |  |
| 33 | nestjs | 0.42 RegExp | nestjs:messagepattern | 0.55 | yes | - | same | SAME |  |
| 34 | nestjs | 0.43 request-scoped WebSocket gateways | nestjs:request | 1.00 | yes | - | same | SAME |  |
| 35 | nestjs | 0.44 handleDisconnect | nestjs:handledisconnect | 1.00 | yes | - | same | SAME |  |
| 36 | nestjs | 0.45 microservices pre-request hook | nestjs:microservices-pre-request-hook | 1.00 | yes | - | same | SAME |  |
| 37 | nestjs | 0.46 Express graceful shutdown | nestjs:express-graceful-shutdown | 1.00 | yes | - | same | SAME |  |
| 38 | next | 0.1 AGENTS.md | next:agents.md | 0.60 | yes | - | different | DIFFERENT | guide: point AGENTS.md at docs; notes: create-next-app generates AGENTS.md |
| 39 | next | 0.3 TypeScript | next:typescript | 1.00 | yes | - | same | SAME |  |
| 40 | next | 0.4 Turbopack | next:turbopack | 0.95 | yes | - | same | SAME |  |
| 41 | next | 0.4 Turbopack | next:turbopack~2 | 0.63 | no | - | different | DIFFERENT | CNA no longer passes --turbopack; a different change |
| 42 | next | 0.5 --webpack | next:webpack | 0.98 | yes | - | same | SAME |  |
| 43 | next | 0.11 experimental.turbopackFileSystemCacheForDev | next:filesystem-cache | 0.69 | yes | - | same | SAME |  |
| 44 | next | 0.12 experimental.turbopackFileSystemCacheForBuild | next:turbopackfilesystemcacheforbuild~2 | 0.53 | yes | - | same | SAME |  |
| 45 | next | 0.13 Async Request APIs | next:sync-access-to-dynamic-apis | 0.86 | yes | - | same | SAME |  |
| 46 | next | 0.14 params | next:params | 0.84 | yes | - | different | DIFFERENT | image-generating functions only (finer) vs route params broadly |
| 47 | next | 0.18 reactCompiler | next:reactcompiler | 0.96 | yes | - | same | UNSURE | reactCompiler promoted to stable vs the create-next-app prompt for it; record summary mixes both |
| 48 | next | 0.19 babel-plugin-react-compiler | next:reactcompiler | 0.68 | yes | - | different | DIFFERENT | installing the Babel plugin vs the config option |
| 49 | next | 0.21 updateTag | next:updatetag | 0.54 | yes | - | different | DIFFERENT | updateTag only vs a record that also changes revalidateTag (finer; notes record is breaking) |
| 50 | next | 0.22 middleware | next:middleware | 0.99 | yes | - | same | SAME |  |
| 51 | next | 0.23 experimental_ppr | next:experimental-ppr | 1.00 | yes | - | same | SAME |  |
| 52 | next | 1.1 cacheLife | next:unstable-cachelife | 0.97 | yes | - | same | SAME |  |
| 53 | next | 1.2 cacheTag | next:unstable-cachetag | 0.98 | yes | - | same | SAME |  |
| 54 | next | 1.4 incremental prefetching | next:partialprefetching | 0.69 | yes | - | different | DIFFERENT | incremental prefetching default vs Partial Prefetching opt-in (16.3) |
| 55 | next | 1.5 experimental_ppr | next:experimental-ppr | 0.71 | yes | - | different | UNSURE | guide removes the PPR flag and the segment option; record is the segment option only |
| 56 | next | 1.6 cacheComponents | next:cachecomponents | 0.90 | yes | - | different | UNSURE | opt into PPR via cacheComponents vs cacheComponents moving to top level |
| 57 | next | 1.7 middleware.ts | next:proxy.ts | 0.86 | yes | - | different | DIFFERENT | deprecation of middleware.ts vs the proxy.ts replacement record |
| 58 | next | 1.7 middleware.ts | next:middleware | 0.68 | no | - | same | SAME |  |
| 59 | next | 1.8 proxy.ts | next:proxy.ts | 0.99 | yes | - | different | SAME | Codex: different (record quote is the codemod); the record is the proxy.ts convention |
| 60 | next | 1.8 proxy.ts | next:middleware | 0.82 | no | - | same | DIFFERENT | proxy.ts (replacement) vs middleware deprecation; Codex said same |
| 61 | next | 1.9 middleware | next:middleware | 0.96 | yes | - | different | DIFFERENT | named-export deprecation (finer) vs the convention deprecation |
| 62 | next | 1.10 proxy | next:proxy.ts | 0.94 | yes | - | same | DIFFERENT | proxy named export (finer) vs proxy.ts convention; Codex said same |
| 63 | next | 1.11 edge | next:middleware-runtime | 0.90 | yes | - | same | SAME | same change; labels differ (guide not breaking, notes breaking) |
| 64 | next | 1.13 images.localPatterns | next:images.localpatterns-localpatterns | 0.99 | yes | - | different | SAME | localPatterns.search requirement; Codex said different |
| 65 | next | 1.14 images.minimumCacheTTL | next:images.minimumcachettl-minimumcachettl | 1.00 | yes | - | same | SAME |  |
| 66 | next | 1.15 images.imageSizes | next:images.imagesizes-imagesizes | 1.00 | yes | - | same | SAME |  |
| 67 | next | 1.17 images.dangerouslyAllowLocalIP | next:images.dangerouslyallowlocalip-dangerouslyallowlocalip | 0.70 | yes | breaking | different | UNSURE | default block vs adding the option (one PR); breaking guard blocks |
| 68 | next | 1.18 images.maximumRedirects | next:images.maximumredirects-maximumredirects | 0.75 | yes | breaking | different | UNSURE | default 3 redirects vs adding the limit (one PR); breaking guard blocks |
| 69 | next | 1.19 next/legacy/image | next:next-legacy-image | 0.93 | yes | - | same | SAME |  |
| 70 | next | 1.20 images.domains | next:images.domains-domains | 0.99 | yes | - | same | SAME |  |
| 71 | next | 1.23 next internal trace | next:next-turbopack-tracing-path | 0.66 | yes | - | same | DIFFERENT | internal trace command vs NEXT_TURBOPACK_TRACING_PATH; Codex said same |
| 72 | next | 1.25 @next/eslint-plugin-next | next:next-eslint-plugin-next | 0.98 | yes | - | same | SAME |  |
| 73 | next | 1.32 amp | next:amp | 0.87 | yes | - | same | SAME |  |
| 74 | next | 1.36 next build | next:automatic-linting | 1.00 | yes | - | same | SAME |  |
| 75 | next | 2.6 experimental.dynamicIO | next:dynamicio | 0.99 | yes | - | same | SAME |  |
| 76 | prisma | 0.0 MongoDB support | prisma:mongodb | 1.00 | yes | - | same | SAME |  |
| 77 | prisma | 0.4 prisma-client | prisma:prisma-client-provider | 0.90 | yes | - | same | SAME |  |
| 78 | prisma | 0.4 prisma-client | prisma:prisma-client | 0.78 | no | - | same | UNSURE | 6.19 prep move vs v7 provider; not the best candidate |
| 79 | prisma | 0.5 prisma-client-js | prisma:prisma-client | 0.55 | yes | - | different | DIFFERENT | deprecation of prisma-client-js vs move to prisma-client |
| 80 | prisma | 0.6 generator client | prisma:output | 0.99 | yes | - | same | SAME |  |
| 81 | prisma | 0.8 datasource | prisma:datasource.url | 0.93 | yes | - | same | SAME |  |
| 82 | prisma | 0.10 datasource | prisma:datasource.shadowdatabaseurl | 0.99 | yes | - | same | SAME |  |
| 83 | prisma | 0.15 environment variables | prisma:environment-variables | 1.00 | yes | - | same | SAME |  |
| 84 | prisma | 0.18 Metrics | prisma:metrics | 1.00 | yes | - | same | SAME |  |
| 85 | prisma | 0.19 mapped enum values | prisma:map~2 | 0.82 | yes | breaking | same | UNSURE | v7 enum names vs the 7.3.0 revert; breaking guard blocks |
| 86 | prisma | 0.21 prisma migrate dev | prisma:prisma-seed | 0.95 | yes | - | same | SAME |  |
| 87 | prisma | 0.22 prisma db seed | prisma:prisma-seed | 0.92 | yes | - | different | SAME | explicit db seed = consequence of #86; Codex said different |
| 88 | prisma | 0.26 prisma generate | prisma:prisma-generate | 0.96 | yes | - | same | SAME |  |
| 89 | prisma | 0.29 prisma migrate diff | prisma:prisma-migrate-diff-from-to-url | 0.84 | yes | - | different | DIFFERENT | one flag vs the --from/--to pair record (finer) |
| 90 | prisma | 0.30 prisma migrate diff | prisma:prisma-migrate-diff-from-to-url | 0.81 | yes | - | different | DIFFERENT | as 89 |
| 91 | prisma | 0.31 prisma migrate diff | prisma:prisma-migrate-diff-from-to-schema-datasource | 0.70 | yes | - | different | DIFFERENT | as 89 |
| 92 | prisma | 0.32 prisma migrate diff | prisma:prisma-migrate-diff-from-to-schema-datasource | 0.75 | yes | - | different | DIFFERENT | as 89 |
| 93 | prisma | 0.34 PRISMA_CLI_QUERY_ENGINE_TYPE | prisma:prisma-cli-query-engine-type | 1.00 | yes | - | same | SAME |  |
| 94 | prisma | 0.35 PRISMA_CLIENT_ENGINE_TYPE | prisma:prisma-client-engine-type | 1.00 | yes | - | same | SAME |  |
| 95 | prisma | 0.36 PRISMA_QUERY_ENGINE_BINARY | prisma:prisma-query-engine-binary | 1.00 | yes | - | same | SAME |  |
| 96 | prisma | 0.37 PRISMA_QUERY_ENGINE_LIBRARY | prisma:prisma-query-engine-library | 1.00 | yes | - | same | SAME |  |
| 97 | prisma | 0.38 PRISMA_GENERATE_SKIP_AUTOINSTALL | prisma:prisma-generate-skip-autoinstall | 1.00 | yes | - | same | SAME |  |
| 98 | prisma | 0.39 PRISMA_SKIP_POSTINSTALL_GENERATE | prisma:prisma-skip-postinstall-generate | 1.00 | yes | - | same | SAME |  |
| 99 | prisma | 0.40 PRISMA_GENERATE_IN_POSTINSTALL | prisma:prisma-generate-in-postinstall | 1.00 | yes | - | same | SAME |  |
| 100 | prisma | 0.41 PRISMA_GENERATE_DATAPROXY | prisma:prisma-generate-dataproxy | 1.00 | yes | - | same | SAME |  |
| 101 | prisma | 0.42 PRISMA_GENERATE_NO_ENGINE | prisma:prisma-generate-no-engine~2 | 1.00 | yes | - | same | SAME |  |
| 102 | prisma | 0.43 PRISMA_CLIENT_NO_RETRY | prisma:prisma-client-no-retry | 1.00 | yes | - | same | SAME |  |
| 103 | prisma | 0.44 PRISMA_MIGRATE_SKIP_GENERATE | prisma:prisma-migrate-skip-generate | 1.00 | yes | - | same | SAME |  |
| 104 | prisma | 0.45 PRISMA_MIGRATE_SKIP_SEED | prisma:prisma-migrate-skip-seed | 1.00 | yes | - | same | SAME |  |
