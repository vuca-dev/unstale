# Match audit (83 'same' matches)

Source: record history entries action=match, detail `<incoming key> p=<p>` in ~/unstale/.store/central/records/<tech>.json; target = the extraction that created the record (history 'created'). Incoming/target quotes from .store/central/extractions. Judged from quotes/summaries.

| # | tech | record id | incoming (release) | target (release) | p | verdict | quote similarity | reason |
|---|---|---|---|---|---|---|---|---|
| 0 | next | next:beforeinteractive-scripts | next@16.2.5#0.7 (16.2.5) | next@15.5.16#0.7 (15.5.16) | 1.0 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 1 | next | next:beforeinteractive-scripts | next@15.5.18#0.8 (15.5.18) | next@15.5.16#0.7 (15.5.16) | 0.98 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 2 | next | next:beforeinteractive-scripts | next@16.2.6#0.7 (16.2.6) | next@15.5.16#0.7 (15.5.16) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 3 | next | next:cache-components | next@16.2.5#0.2 (16.2.5) | next@15.5.16#0.2 (15.5.16) | 0.98 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 4 | next | next:cache-components | next@15.5.18#0.3 (15.5.18) | next@15.5.16#0.2 (15.5.16) | 0.98 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 5 | next | next:cache-components | next@16.2.6#0.2 (16.2.6) | next@15.5.16#0.2 (15.5.16) | 0.94 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 6 | next | next:cachehandlers | next@16.2.6#0.16 (16.2.6) | next@16.2.5#0.16 (16.2.5) | 0.95 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 7 | next | next:client-param-parsing | next@16.2.6#0.17 (16.2.6) | next@16.2.5#0.17 (16.2.5) | 1.0 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 8 | next | next:clientsegmentcache~2 | next@16.1.0#0.2 (16.1.0) | next@16.0.3#0.2 (16.0.3) | 1.0 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 9 | next | next:create-next-app | next@16.3.0#0.4 (16.3.0) | next@16.2.2#0.2 (16.2.2) | 1.0 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 10 | next | next:cross-site-dev-only-websocket-connections | next@16.2.0#2.7 (16.2.0) | next@16.1.7#0.5 (16.1.7) | 0.99 | SAME | 0.99 | identical/near-identical quote; same change on another release line or repeated |
| 11 | next | next:csp-nonces | next@16.2.5#0.6 (16.2.5) | next@15.5.16#0.6 (15.5.16) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 12 | next | next:csp-nonces | next@15.5.18#0.7 (15.5.18) | next@15.5.16#0.6 (15.5.16) | 0.95 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 13 | next | next:csp-nonces | next@16.2.6#0.6 (16.2.6) | next@15.5.16#0.6 (15.5.16) | 0.93 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 14 | next | next:csp-nonces | next@16.3.5#0.3 (16.3.5) | next@15.5.16#0.6 (15.5.16) | 0.73 | DIFFERENT | 0.20 | GHSA XSS fix vs new feature (CSP nonce on loading/template script tags) |
| 15 | next | next:dynamicparams | next@16.3.8#0.1 (16.3.8) | next@15.5.27#0.0 (15.5.27) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 16 | next | next:experimental.runtimeserverdeploymentid | next@16.2.0#0.31 (16.2.0) | next@16.1.0#0.11 (16.1.0) | 0.96 | UNSURE | 0.80 | adds option (16.1.0) vs 'stub adapterPath with' the option (16.2.0); possibly a follow-up stub, not clearly the same change |
| 17 | next | next:fallback-route-params | next@16.2.6#0.13 (16.2.6) | next@16.2.5#0.13 (16.2.5) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 18 | next | next:formdata | next@16.2.7#0.6 (16.2.7) | next@15.5.19#0.0 (15.5.19) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 19 | next | next:get-routes | next@16.1.0#0.3 (16.1.0) | next@16.0.3#0.5 (16.0.3) | 1.0 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 20 | next | next:http-access-fallbacks | next@16.2.6#0.12 (16.2.6) | next@16.2.5#0.12 (16.2.5) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 21 | next | next:http-proxy | next@16.1.7#0.7 (16.1.7) | next@15.5.13#0.0 (15.5.13) | 1.0 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 22 | next | next:image-optimization-api~5 | next@16.4.1#0.1 (16.4.1) | next@15.5.28#0.0 (15.5.28) | 0.96 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 23 | next | next:images.maximumdiskcachesize | next@16.2.0#0.27 (16.2.0) | next@16.1.7#0.4 (16.1.7) | 0.98 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 24 | next | next:images.maximumdiskcachesize | next@15.5.14#0.1 (15.5.14) | next@16.1.7#0.4 (16.1.7) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 25 | next | next:lru-disk-cache | next@15.5.14#0.0 (15.5.14) | next@16.1.7#0.3 (16.1.7) | 0.98 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 26 | next | next:middleware-proxy | next@16.2.5#0.1 (16.2.5) | next@15.5.16#0.1 (15.5.16) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 27 | next | next:middleware-proxy | next@15.5.18#0.1 (15.5.18) | next@15.5.16#0.1 (15.5.16) | 0.95 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 28 | next | next:middleware-proxy | next@16.2.6#0.1 (16.2.6) | next@15.5.16#0.1 (15.5.16) | 0.79 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 29 | next | next:middleware-proxy-redirects | next@16.2.5#0.11 (16.2.5) | next@15.5.16#0.11 (15.5.16) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 30 | next | next:middleware-proxy-redirects | next@15.5.18#0.12 (15.5.18) | next@15.5.16#0.11 (15.5.16) | 0.95 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 31 | next | next:middleware-proxy-redirects | next@16.2.6#0.11 (16.2.6) | next@15.5.16#0.11 (15.5.16) | 0.91 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 32 | next | next:middleware-proxy~2 | next@16.2.5#0.3 (16.2.5) | next@15.5.16#0.3 (15.5.16) | 0.98 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 33 | next | next:middleware-proxy~2 | next@15.5.18#0.4 (15.5.18) | next@15.5.16#0.3 (15.5.16) | 0.96 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 34 | next | next:middleware-proxy~2 | next@16.2.6#0.3 (16.2.6) | next@15.5.16#0.3 (15.5.16) | 0.9 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 35 | next | next:middleware-proxy~3 | next@16.2.5#0.5 (16.2.5) | next@15.5.16#0.5 (15.5.16) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 36 | next | next:middleware-proxy~3 | next@15.5.18#0.6 (15.5.18) | next@15.5.16#0.5 (15.5.16) | 0.94 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 37 | next | next:middleware-proxy~3 | next@16.2.6#0.5 (16.2.6) | next@15.5.16#0.5 (15.5.16) | 0.9 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 38 | next | next:minimal-mode-response-cache | next@15.5.11#0.6 (15.5.11) | next@16.1.6#0.0 (16.1.6) | 1.0 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 39 | next | next:next-build-analyze | next@16.1.0#0.4 (16.1.0) | next@16.0.3#0.4 (16.0.3) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 40 | next | next:next-dev-inspect | next@16.1.0#0.1 (16.1.0) | next@16.0.3#0.1 (16.0.3) | 0.87 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 41 | next | next:next-swc-wasm-web | next@16.2.10#0.0 (16.2.10) | next@15.5.20#0.0 (15.5.20) | 0.92 | SAME | 0.81 | identical/near-identical quote; same change on another release line or repeated |
| 42 | next | next:partial-pre-rendering | next@16.1.5#0.1 (16.1.5) | next@15.5.10#0.1 (15.5.10) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 43 | next | next:react-server-component-cache-busting | next@16.2.5#0.10 (16.2.5) | next@15.5.16#0.10 (15.5.16) | 1.0 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 44 | next | next:react-server-component-cache-busting | next@15.5.18#0.11 (15.5.18) | next@15.5.16#0.10 (15.5.16) | 0.98 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 45 | next | next:react-server-component-cache-busting | next@16.2.6#0.10 (16.2.6) | next@15.5.16#0.10 (15.5.16) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 46 | next | next:react-server-component-responses | next@16.2.5#0.9 (16.2.5) | next@15.5.16#0.9 (15.5.16) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 47 | next | next:react-server-component-responses | next@15.5.18#0.10 (15.5.18) | next@15.5.16#0.9 (15.5.16) | 0.88 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 48 | next | next:react-server-component-responses | next@16.2.6#0.9 (16.2.6) | next@15.5.16#0.9 (15.5.16) | 0.91 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 49 | next | next:react-server-components~2 | next@16.1.5#0.2 (16.1.5) | next@15.5.10#0.2 (15.5.10) | 0.9 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 50 | next | next:react-server-components~2 | next@15.5.15#0.0 (15.5.15) | next@15.5.10#0.2 (15.5.10) | 0.93 | DIFFERENT | 0.26 | 15.5.15 new high-severity CPU-exhaustion advisory vs the earlier 15.5.10 Server Function DoS batch; different advisory |
| 51 | next | next:remotepatterns | next@16.1.5#0.0 (16.1.5) | next@15.5.10#0.0 (15.5.10) | 0.88 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 52 | next | next:remotepatterns | next@15.5.16#0.8 (15.5.16) | next@15.5.10#0.0 (15.5.10) | 0.85 | DIFFERENT | 0.42 | GHSA-h64f Image Optimization DoS (May 2026) merged into CVE-2025-59471 remotePatterns memory DoS (Jan 2026); distinct advisories |
| 53 | next | next:remotepatterns | next@16.2.5#0.8 (16.2.5) | next@15.5.10#0.0 (15.5.10) | 0.84 | DIFFERENT | 0.42 | same as 52 (GHSA-h64f vs CVE-2025-59471) |
| 54 | next | next:remotepatterns | next@15.5.18#0.9 (15.5.18) | next@15.5.10#0.0 (15.5.10) | 0.86 | DIFFERENT | 0.42 | same as 52 (GHSA-h64f vs CVE-2025-59471) |
| 55 | next | next:remotepatterns | next@16.2.6#0.8 (16.2.6) | next@15.5.10#0.0 (15.5.10) | 0.76 | DIFFERENT | 0.42 | same as 52 (GHSA-h64f vs CVE-2025-59471) |
| 56 | next | next:route-level-rsc-requests | next@16.2.6#0.14 (16.2.6) | next@16.2.5#0.14 (16.2.5) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 57 | next | next:server-actions~4 | next@15.5.28#0.1 (15.5.28) | next@16.2.11#0.0 (16.2.11) | 0.97 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 58 | next | next:server-actions~4 | next@16.4.1#0.2 (16.4.1) | next@16.2.11#0.0 (16.2.11) | 0.97 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 59 | next | next:server-components | next@16.2.5#0.0 (16.2.5) | next@15.5.16#0.0 (15.5.16) | 0.94 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 60 | next | next:server-components | next@15.5.18#0.0 (15.5.18) | next@15.5.16#0.0 (15.5.16) | 0.74 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 61 | next | next:server-components | next@16.2.6#0.0 (16.2.6) | next@15.5.16#0.0 (15.5.16) | 0.9 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 62 | next | next:server-hmr~2 | next@16.3.0#0.0 (16.3.0) | next@16.2.2#0.4 (16.2.2) | 0.95 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 63 | next | next:serverfastrefresh | next@16.3.0#0.7 (16.3.0) | next@16.2.2#0.3 (16.2.2) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 64 | next | next:setheader | next@16.2.6#0.15 (16.2.6) | next@16.2.5#0.15 (16.2.5) | 0.99 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 65 | next | next:ssg-isr-rendering | next@16.3.8#0.2 (16.3.8) | next@15.5.27#0.3 (15.5.27) | 0.74 | UNSURE | 0.36 | same SSG/ISR cache-poisoning advisory family, but incoming quote is the short title, target the long title; probably one advisory, unclear |
| 66 | next | next:staletimes-static | next@16.1.0#0.0 (16.1.0) | next@16.0.3#0.0 (16.0.3) | 0.96 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 67 | next | next:use-cache~2 | next@16.3.1#0.3 (16.3.1) | next@16.1.0#0.17 (16.1.0) | 0.8 | UNSURE | 0.64 | 'allow exporting literals again' (16.1.0) vs 'allow literal exports' (16.3.1); could be a later regression fix |
| 68 | next | next:websocket-upgrades | next@16.2.5#0.4 (16.2.5) | next@15.5.16#0.4 (15.5.16) | 1.0 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 69 | next | next:websocket-upgrades | next@15.5.18#0.5 (15.5.18) | next@15.5.16#0.4 (15.5.16) | 0.98 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 70 | next | next:websocket-upgrades | next@16.2.6#0.4 (16.2.6) | next@15.5.16#0.4 (15.5.16) | 0.98 | SAME | 1.00 | identical/near-identical quote; same change on another release line or repeated |
| 71 | prisma | prisma:columnnotfound | prisma@7.9.0#0.17 (7.9.0) | prisma@7.6.0#0.9 (7.6.0) | 0.85 | DIFFERENT | 0.59 | generic ColumnNotFound parsing (7.6.0) vs adapter-ppg P2022 parsing incl. names with spaces (7.9.0); a distinct adapter fix |
| 72 | prisma | prisma:datasource | prisma@7.0.0#0.26 (7.0.0) | prisma@6.18.0#0.1 (6.18.0) | 0.84 | DIFFERENT | 0.39 | 6.18 optional datasource in prisma.config.ts vs 7.0 datasource.url moved to config (breaking move); related, not the same |
| 73 | prisma | prisma:executeraw | prisma@7.10.0#0.14 (7.10.0) | prisma@7.9.0#0.9 (7.9.0) | 0.75 | UNSURE | 0.46 | 7.9.0 fail fast with validation error vs 7.10.0 throw PrismaClientValidationError instead of generic error; may be restatement or a second fix |
| 74 | prisma | prisma:partial-index-predicate-comparison | prisma@7.5.0#0.8 (7.5.0) | prisma@7.4.2#0.8 (7.4.2) | 0.88 | DIFFERENT | 0.47 | 7.4.2 predicate comparison fix for PG/MSSQL vs 7.5.0 quoted/unquoted identifier handling; a second fix to same area |
| 75 | prisma | prisma:prisma-cli | prisma@7.9.1#0.0 (7.9.1) | prisma@7.0.1#0.5 (7.0.1) | 0.86 | DIFFERENT | 0.36 | generic dependency vulnerabilities (7.0.1) vs specific @prisma/dev transitive advisory (7.9.1) |
| 76 | prisma | prisma:queryraw | prisma@7.10.0#0.13 (7.10.0) | prisma@7.9.0#0.8 (7.9.0) | 0.9 | UNSURE | 0.46 | as 73 |
| 77 | nestjs | nestjs:head | nestjs@12.1.3#0.18 (12.1.3) | nestjs@11.1.17#0.1 (11.1.17) | 0.78 | DIFFERENT | 0.35 | auto-run middleware for HEAD on Fastify vs GET middleware exclusion covering HEAD; different change |
| 78 | nestjs | nestjs:middie | nestjs@11.1.14#0.0 (11.1.14) | nestjs@11.1.11#0.0 (11.1.11) | 0.79 | UNSURE | 0.54 | 11.1.11 middie decoded-chars bypass vs 11.1.14 'fastify middleware bypass cve'; maybe the CVE for the same fix, maybe a follow-up |
| 79 | nestjs | nestjs:nested-transient-provider-isolation | nestjs@12.1.3#0.22 (12.1.3) | nestjs@11.1.8#0.0 (11.1.8) | 0.76 | DIFFERENT | 0.61 | nested transient isolation (core, 11.1.8) vs isolation for transient providers injected into properties (12.1.3); distinct fix |
| 80 | nestjs | nestjs:optional-constructor-parameters | nestjs@12.1.3#0.60 (12.1.3) | nestjs@12.1.0#0.0 (12.1.0) | 0.86 | DIFFERENT | 0.31 | inherit optional ctor params vs keep inherited @Optional() properties optional; different mechanism |
| 81 | nestjs | nestjs:pending-requests | nestjs@12.0.4#0.1 (12.0.4) | nestjs@12.0.3#0.1 (12.0.3) | 0.91 | DIFFERENT | 0.97 | generic pending requests on close vs RMQ-specific (NATS handled separately in same release); different transport fix |
| 82 | nestjs | nestjs:string-file-types | nestjs@12.1.3#0.57 (12.1.3) | nestjs@11.2.0#0.1 (11.2.0) | 0.7 | DIFFERENT | 0.51 | match string file types with regex metacharacters vs isolate file-type regexp state; different bug |
