# Match audit: held-out technology (Nuxt)

## Pre-registration (written and committed before the held-out run)

**Why.** The matching guards (quote, advisory, breaking) and their constants were tuned on the 83 within-source
matches of the first run (`docs/match-audit.md`), and the cross-source threshold `CROSS_SAME_P` on Prisma and NestJS
(`docs/match-audit-guides.md`). Neither number is an independent measurement. This audit runs ingest matching,
unchanged, on data no tuning step has seen.

**Held-out data.** A fourth npm technology chosen by rule, not by hand: the first candidate, in the order vite,
@tanstack/query, astro, fastify, nuxt, whose stable `vX.Y.Z` GitHub releases since 2025-10-15 are a single tag series
(not per-package changeset tags) with substantive bodies (median body over 1,000 characters, i.e. the notes are in the
release, not a pointer to a CHANGELOG), and which has an official upgrade guide at a predictable path.
- vite: 57 `vX.Y.Z` releases, median body 114 characters ("Please refer to CHANGELOG.md").
- @tanstack/query, astro: per-package changeset tags (`@tanstack/vue-query@5.104.3`, `astro@7.4.0`); 1 and 0
  `vX.Y.Z` releases.
- fastify: 25 releases, median body 957 characters.
- **nuxt: 29 stable releases (v4.2.0 … v4.6.1 and the v3.20/3.21 backport line), median body 5,636 characters;
  upgrade guide `docs/1.getting-started/18.upgrade.md` in nuxt/nuxt.** Chosen.

Releases published after the tuning snapshot (2026-10-15 06:57Z) for next, prisma and nestjs: none on the day of the
run, so the held-out set is Nuxt alone. Nuxt is run in its own side store (`.store/central-trust-nuxt`), never
published, never added to `TECHNOLOGIES`.

**What runs.** The committed pipeline (fetch, Codex extraction and labelling, Jev labels, Jev same-or-new judge with
the guards) with every constant as tuned: `SAME_P` 0.7, `CROSS_SAME_P` 0.85, `QUOTE_GUARD_BELOW` 0.95,
`QUOTE_SIMILARITY` 0.9. Nothing is changed for or after looking at Nuxt.

**What is audited.**
- Every merge the judge plus guards made (within source and across sources).
- Near-misses: every pair with p in [0.5, threshold) (threshold 0.7 within source, 0.85 across), and every pair a
  guard blocked at p ≥ 0.7; all of them if there are at most 80, else a random sample of 80 (seeded by the pair key).
- Reference: Codex `gpt-5.6-luna` under the vault's v3 identity rules (`dm_match.py` RULES_V3, "different" when
  unsure), 12 pairs per call. I read every pair where Codex and the pipeline disagree and every pair where either side
  mentions a security fix or an advisory id, and give the final verdict (SAME / DIFFERENT / UNSURE). Security pairs are
  also checked against the GitHub Advisory Database entries for `nuxt`.

**Acceptance rule (decided now).** The guards pass the held-out check when both hold:
1. **No hidden security change:** no merge joins two distinct security advisories, or folds a security fix into a
   record that is not about that fix. One such merge fails the check, whatever the rate.
2. **False merges at most 5 per 100 merges:** (DIFFERENT + 0.5 × UNSURE) / merges × 100 ≤ 5.

Reported, not part of the rule: missed duplicates (near-misses I judge SAME) per 100 ingested items, and the rate per
split (within source, across sources).

**If it fails:** propose a fix and tune it on the tuning data only (the 83 within-source cases and the 104 cross-source
pairs), then re-run the held-out check once with the fixed rule and report both results.

## Result (15 October 2026): **pass**

Run: `eval/heldout/nuxt.mts` on an export of commit 840c77a (the committed pipeline, constants unchanged) into
`.store/central-trust-nuxt`; audit `eval/heldout/audit.mts` (pairs rebuilt from the records' history, each candidate
as it stood when the item was judged); table and counts `eval/heldout/table.py` from `pairs.json` and my
`verdicts.json`.

- 29 releases and the guide gave **794 items**; Jev made **168 merges** (163 within release notes, 5 guide ↔ notes),
  626 records. Guards blocked 23 pairs at p ≥ 0.7 (quote 18, cross 3, breaking 2, advisory 0); 20 more pairs scored
  p in [0.5, threshold). All 43 near-misses were audited (fewer than 80, so no sampling).
- **Rule 1, hidden security change: none.** The 8 merges that touch a security fix are the 4.5.1 ↔ 3.21.10 backports of
  one security release, item for item (#152–#156, #162) and two unrelated items whose text matched the keyword filter
  (#90, #106); each pair is the same advisory on two lines. The two pairs where distinct Nuxt advisories met were kept
  apart: #151 (GHSA-hxvh vs GHSA-mm7m, p 0.52, below the threshold; Codex said same) and #169 (GHSA-7c4v vs
  GHSA-rq7w, p 0.78, blocked by the quote guard; Codex said same). #150 (island-props RCE vs the island request hash
  fix) was blocked by the quote guard.
- **Rule 2, false merges: 0.6 per 100 merges** (0 DIFFERENT, 2 UNSURE, 168 merges; the limit is 5). The two UNSURE are
  cross-source (#196, #198): the 4.6.0 notes put a Nuxt 5 behaviour behind `compatibilityVersion: 5`, the guide says it
  is on by default in Nuxt 5.
- Reported, not part of the rule: **11 missed duplicates** (near-misses I judge SAME) and 10 UNSURE, 1.4 per 100
  items. Six of them (#4–#16) are the 4.2.0 highlights (prose) against the 3.20.0 bullets of the same features: the
  quote guard blocks paraphrases within one source, which is its designed cost.
- Codex and my verdicts disagree on 16 pairs, all near-misses (Codex said same where I said different or unsure, among
  them both security pairs above); on all 168 merges Codex and I agree except the 2 UNSURE.

**How much this tests.** 145 of the 168 merges carry a quote identical to the target's: Nuxt ships every fix on the
v4 and v3 lines with the same bullet, so most of the held-out set exercises the easy path (identical quotes, any
p ≥ 0.7). The paraphrase path is 23 merges (18 within source with p ≥ 0.95 or a near-identical quote, 5 across
sources); 2 of them are UNSURE. The cross-source part is small (5 merges, 3 blocked), so it adds little to the
Next.js hold-out of `docs/match-audit-guides.md` (21 merges, 1 DIFFERENT, 2 UNSURE).

**One setup slip, no effect on the verdict.** The file at the guide path is now Nuxt's upgrade guide to Nuxt 5, not 4;
the run named it major 4. Since 4.0.0 is outside the window the items were dated to the guide's commit, as for any
guide whose major release is outside the window; matching does not use the major.

Model calls: Codex 77 (extraction and labelling, 1.29M input tokens, 0.79M of them cached) plus 18 (audit reference,
0.24M input); Jev 1,562 (labels and same-or-new). Every call cached by request hash in the side store.

No fix was needed, so nothing was tuned or re-run.

## Table

All 211 pairs: 168 merges, 20 near-misses (p in [0.5, threshold)), 23 guard blocks at p ≥ 0.7. "Codex" is the
reference, "verdict" mine (a merge without a note is a Codex "same" I read and accept; every non-merge is mine).
Quote similarity: the best Ratcliff/Obershelp ratio between the normalised incoming quote and the candidate's quotes.

| # | pair | record (candidate) | incoming | p | outcome | Codex | verdict | quote similarity | note |
|---|---|---|---|---|---|---|---|---|---|
| 1 | merge | nuxt:declarationpath | nuxt@3.20.0#0.0 | 0.96 | same | same | SAME | 0.61 |  |
| 2 | merge | nuxt:resolvemodule-extensions | nuxt@3.20.0#0.1 | 0.97 | same | same | SAME | 0.42 |  |
| 3 | blocked | nuxt:useasyncdata-signal | nuxt@3.20.0#0.2 | 0.79 | guard:quote | different | UNSURE | 0.62 | abortController option (3.20.0) vs AbortController signals in useAsyncData (4.2.0 highlights); probably one PR |
| 4 | blocked | nuxt:development-error-overlay | nuxt@3.20.0#0.3 | 0.72 | guard:quote | same | SAME | 0.49 | same feature: 3.20.0 bullet vs 4.2.0 highlight prose (parallel releases) |
| 5 | blocked | nuxt:experimental.typescriptplugin | nuxt@3.20.0#0.4 | 0.73 | guard:quote | same | SAME | 0.58 | as 4 |
| 6 | blocked | nuxt:experimental.extractasyncdatahandlers | nuxt@3.20.0#0.5 | 0.89 | guard:quote | same | SAME | 0.63 | as 4 |
| 7 | merge | nuxt:setglobalhead | nuxt@3.20.0#0.6 | 0.99 | same | same | SAME | 0.52 |  |
| 8 | blocked | nuxt:experimental.viteenvironmentapi | nuxt@3.20.0#0.7 | 0.86 | guard:quote | same | SAME | 0.66 | as 4 |
| 9 | merge | nuxt:renderer-dependencies | nuxt@3.20.0#0.8 | 0.97 | same | same | SAME | 0.76 |  |
| 10 | merge | nuxt:routerules | nuxt@3.20.0#0.9 | 0.99 | same | same | SAME | 0.75 |  |
| 11 | merge | nuxt:nuxtlink-href | nuxt@3.20.0#0.10 | 0.98 | same | same | SAME | 0.71 |  |
| 12 | merge | nuxt:mergemodels | nuxt@3.20.0#0.11 | 0.99 | same | same | SAME | 1.00 |  |
| 13 | merge | nuxt:shortpath | nuxt@3.20.0#0.12 | 0.99 | same | same | SAME | 1.00 |  |
| 14 | merge | nuxt:nuxtlink | nuxt@3.20.0#0.13 | 0.98 | same | same | SAME | 1.00 |  |
| 15 | merge | nuxt:isprerendered | nuxt@3.20.0#0.15 | 1 | same | same | SAME | 1.00 |  |
| 16 | blocked | nuxt:h | nuxt@3.20.0#0.16 | 0.93 | guard:quote | same | SAME | 0.71 | as 4 |
| 17 | merge | nuxt:nuxttime-numeric | nuxt@3.20.0#0.17 | 0.99 | same | same | SAME | 1.00 |  |
| 18 | merge | nuxt:nuxttime-relativestyle | nuxt@3.20.0#0.18 | 0.99 | same | same | SAME | 1.00 |  |
| 19 | merge | nuxt:app-config-arrays | nuxt@3.20.0#0.19 | 0.99 | same | same | SAME | 0.60 |  |
| 20 | merge | nuxt:extend | nuxt@3.20.0#0.20 | 0.98 | same | same | SAME | 1.00 |  |
| 21 | merge | nuxt:extendconfig | nuxt@3.20.0#0.21 | 1 | same | same | SAME | 1.00 |  |
| 22 | merge | nuxt:configresolved | nuxt@3.20.0#0.22 | 1 | same | same | SAME | 1.00 |  |
| 23 | merge | nuxt:importpresetwithdeprecation | nuxt@4.2.1#0.0 | 0.99 | same | same | SAME | 1.00 |  |
| 24 | merge | nuxt:moduleentrypaths | nuxt@4.2.1#0.2 | 1 | same | same | SAME | 1.00 |  |
| 25 | merge | nuxt:error-overlay | nuxt@4.2.1#0.3 | 1 | same | same | SAME | 1.00 |  |
| 26 | merge | nuxt:scanned-components | nuxt@4.2.1#0.5 | 1 | same | same | SAME | 1.00 |  |
| 27 | merge | nuxt:pages-resolved | nuxt@4.2.1#0.6 | 1 | same | same | SAME | 1.00 |  |
| 28 | merge | nuxt:vite.proxy | nuxt@4.2.1#0.7 | 0.99 | same | same | SAME | 1.00 |  |
| 29 | merge | nuxt:pretty-error-handler | nuxt@4.2.2#0.0 | 1 | same | same | SAME | 1.00 |  |
| 30 | merge | nuxt:component-declaration-items | nuxt@4.2.2#0.1 | 1 | same | same | SAME | 1.00 |  |
| 31 | merge | nuxt:page-finish | nuxt@4.2.2#0.2 | 1 | same | same | SAME | 1.00 |  |
| 32 | merge | nuxt:tsconfig.server.json | nuxt@4.2.2#0.4 | 1 | same | same | SAME | 1.00 |  |
| 33 | merge | nuxt:useasyncdata | nuxt@4.2.2#0.5 | 1 | same | same | SAME | 1.00 |  |
| 34 | merge | nuxt:moduledependencies | nuxt@4.2.2#0.6 | 1 | same | same | SAME | 1.00 |  |
| 35 | merge | nuxt:d.vue.ts | nuxt@4.2.2#0.7 | 0.99 | same | same | SAME | 1.00 |  |
| 36 | merge | nuxt:callonce | nuxt@4.2.2#0.8 | 1 | same | same | SAME | 1.00 |  |
| 37 | merge | nuxt:useasyncdata-watch | nuxt@4.2.2#0.9 | 0.99 | same | same | SAME | 1.00 |  |
| 38 | merge | nuxt:development-error-page-stack-trace | nuxt@4.2.2#0.10 | 0.99 | same | same | SAME | 1.00 |  |
| 39 | merge | nuxt:installmodule-moduledependencies | nuxt@4.2.2#0.11 | 0.96 | same | same | SAME | 1.00 |  |
| 40 | merge | nuxt:routerules-applayout | nuxt@4.3.0#0.0 | 0.93 | same | same | SAME | 1.00 |  |
| 41 | merge | nuxt:payload-extraction | nuxt@4.3.0#0.1 | 1 | same | same | SAME | 1.00 |  |
| 42 | merge | nuxt:payload-extraction~2 | nuxt@4.3.0#0.2 | 0.99 | same | same | SAME | 1.00 |  |
| 43 | merge | nuxt:module-options | nuxt@4.3.0#0.3 | 0.95 | same | same | SAME | 1.00 |  |
| 44 | merge | nuxt:route.meta.groups | nuxt@4.3.0#0.4 | 0.99 | same | same | SAME | 1.00 |  |
| 45 | merge | nuxt:setpagelayout | nuxt@4.3.0#0.5 | 1 | same | same | SAME | 1.00 |  |
| 46 | merge | nuxt:server | nuxt@4.3.0#0.6 | 0.98 | same | same | SAME | 1.00 |  |
| 47 | merge | nuxt:error-overlay~2 | nuxt@4.3.0#0.7 | 0.99 | same | same | SAME | 1.00 |  |
| 48 | merge | nuxt:async-plugin-constructors | nuxt@4.3.0#0.8 | 0.89 | same | same | SAME | 1.00 |  |
| 49 | merge | nuxt:inlinestyles | nuxt@4.3.0#0.10 | 1 | same | same | SAME | 1.00 |  |
| 50 | merge | nuxt:statuscode | nuxt@4.3.0#0.11 | 0.99 | same | same | SAME | 0.25 |  |
| 51 | merge | nuxt:statusmessage | nuxt@4.3.0#0.12 | 0.99 | same | same | SAME | 0.25 |  |
| 52 | merge | nuxt:head-key | nuxt@4.3.0#0.13 | 0.99 | same | same | SAME | 1.00 |  |
| 53 | merge | nuxt:asyncdata | nuxt@4.3.0#0.14 | 0.96 | same | same | SAME | 1.00 |  |
| 54 | merge | nuxt:usecookie | nuxt@4.3.0#0.15 | 1 | same | same | SAME | 1.00 |  |
| 55 | merge | nuxt:nuxtpage | nuxt@4.3.0#0.16 | 1 | same | same | SAME | 1.00 |  |
| 56 | merge | nuxt:route-aliases | nuxt@4.3.0#0.17 | 1 | same | same | SAME | 1.00 |  |
| 57 | merge | nuxt:suspense | nuxt@4.3.0#0.18 | 1 | same | same | SAME | 1.00 |  |
| 58 | merge | nuxt:allowarbitraryextensions | nuxt@4.3.0#0.19 | 1 | same | same | SAME | 1.00 |  |
| 59 | merge | nuxt:nouncheckedindexedaccess | nuxt@4.3.0#0.20 | 1 | same | same | SAME | 1.00 |  |
| 60 | merge | nuxt:route-rules-compilation | nuxt@4.3.0#0.21 | 1 | same | same | SAME | 1.00 |  |
| 61 | merge | nuxt:moduledependencies | nuxt@3.21.1#0.18 | 0.95 | same | same | SAME | 0.77 |  |
| 62 | merge | nuxt:nuxterror-status | nuxt@4.3.1#0.0 | 1 | same | same | SAME | 1.00 |  |
| 63 | merge | nuxt:default-ignore | nuxt@4.3.1#0.1 | 0.7 | same | same | SAME | 1.00 |  |
| 64 | merge | nuxt:hash-links | nuxt@4.3.1#0.3 | 1 | same | same | SAME | 1.00 |  |
| 65 | merge | nuxt:x-nitro-prerender | nuxt@4.3.1#0.4 | 1 | same | same | SAME | 1.00 |  |
| 66 | merge | nuxt:builder-watch | nuxt@4.3.1#0.5 | 1 | same | same | SAME | 1.00 |  |
| 67 | merge | nuxt:error.message | nuxt@4.3.1#0.6 | 0.99 | same | same | SAME | 1.00 |  |
| 68 | merge | nuxt:nuxterror | nuxt@4.3.1#0.7 | 1 | same | same | SAME | 1.00 |  |
| 69 | merge | nuxt:h3error | nuxt@4.3.1#0.8 | 1 | same | same | SAME | 1.00 |  |
| 70 | merge | nuxt:app | nuxt@4.3.1#0.9 | 0.99 | same | same | SAME | 1.00 |  |
| 71 | merge | nuxt:custom-routes | nuxt@4.3.1#0.10 | 1 | same | same | SAME | 1.00 |  |
| 72 | merge | nuxt:vnode | nuxt@4.3.1#0.11 | 0.97 | same | same | SAME | 1.00 |  |
| 73 | merge | nuxt:css | nuxt@4.3.1#0.12 | 1 | same | same | SAME | 1.00 |  |
| 74 | merge | nuxt:view-transition | nuxt@4.3.1#0.13 | 1 | same | same | SAME | 1.00 |  |
| 75 | merge | nuxt:nuxttime | nuxt@4.3.1#0.15 | 1 | same | same | SAME | 1.00 |  |
| 76 | merge | nuxt:middleware-error-status | nuxt@4.3.1#0.16 | 1 | same | same | SAME | 1.00 |  |
| 77 | merge | nuxt:buildid | nuxt@4.3.1#0.17 | 1 | same | same | SAME | 1.00 |  |
| 78 | merge | nuxt:ssr-context-url | nuxt@4.3.1#0.18 | 1 | same | same | SAME | 1.00 |  |
| 79 | merge | nuxt:moduledependencies | nuxt@4.3.1#0.19 | 0.98 | same | same | SAME | 1.00 |  |
| 80 | merge | nuxt:components | nuxt@4.3.1#0.20 | 1 | same | same | SAME | 1.00 |  |
| 81 | merge | nuxt:node.res | nuxt@4.3.1#0.21 | 0.98 | same | same | SAME | 1.00 |  |
| 82 | merge | nuxt:path-encoding | nuxt@4.3.1#0.22 | 1 | same | same | SAME | 1.00 |  |
| 83 | near | nuxt:payload-extraction | nuxt@4.4.0#0.10 | 0.55 | below | different | DIFFERENT | 0.18 | in-memory LRU payload cache vs payload extraction for ISR/SWR |
| 84 | blocked | nuxt:path-encoding | nuxt@3.21.3#0.19 | 0.74 | guard:quote | different | DIFFERENT | 0.48 | re-encode ssrContext.url vs align path encoding; a follow-up fix |
| 85 | merge | nuxt:usefetch-cache | nuxt@4.4.3#0.0 | 0.99 | same | same | SAME | 1.00 |  |
| 86 | merge | nuxt:clearnuxtstate~2 | nuxt@4.4.3#0.1 | 1 | same | same | SAME | 1.00 |  |
| 87 | merge | nuxt:async-data | nuxt@4.4.3#0.2 | 0.96 | same | same | SAME | 1.00 |  |
| 88 | merge | nuxt:response-status | nuxt@4.4.3#0.3 | 0.86 | same | same | SAME | 1.00 |  |
| 89 | merge | nuxt:manifest-fetch | nuxt@4.4.3#0.5 | 1 | same | same | SAME | 1.00 |  |
| 90 | merge | nuxt:packagepreset | nuxt@4.4.3#0.6 | 0.99 | same | same | SAME | 1.00 |  |
| 91 | merge | nuxt:devonly | nuxt@4.4.3#0.7 | 1 | same | same | SAME | 1.00 |  |
| 92 | merge | nuxt:nuxttime~2 | nuxt@4.4.3#0.8 | 1 | same | same | SAME | 1.00 |  |
| 93 | merge | nuxt:callonce~2 | nuxt@4.4.3#0.9 | 1 | same | same | SAME | 1.00 |  |
| 94 | merge | nuxt:styles.mjs | nuxt@4.4.3#0.11 | 0.98 | same | same | SAME | 1.00 |  |
| 95 | merge | nuxt:usefetch | nuxt@4.4.3#0.12 | 0.99 | same | same | SAME | 1.00 |  |
| 96 | merge | nuxt:dev-server-logs | nuxt@4.4.3#0.14 | 0.99 | same | same | SAME | 1.00 |  |
| 97 | merge | nuxt:callonce-navigation-mode | nuxt@4.4.3#0.15 | 0.99 | same | same | SAME | 1.00 |  |
| 98 | merge | nuxt:test | nuxt@4.4.3#0.16 | 0.99 | same | same | SAME | 1.00 |  |
| 99 | merge | nuxt:ssrcontext.url | nuxt@4.4.3#0.19 | 1 | same | same | SAME | 1.00 |  |
| 100 | merge | nuxt:layer-aliases | nuxt@4.4.3#0.20 | 0.99 | same | same | SAME | 1.00 |  |
| 101 | merge | nuxt:error-handler~2 | nuxt@4.4.3#0.21 | 0.99 | same | same | SAME | 1.00 |  |
| 102 | merge | nuxt:layer-roots | nuxt@4.4.5#0.0 | 1 | same | same | SAME | 1.00 |  |
| 103 | merge | nuxt:payload-route-rule | nuxt@4.4.5#0.2 | 0.99 | same | same | SAME | 1.00 |  |
| 104 | merge | nuxt:prerendering | nuxt@4.4.5#0.3 | 1 | same | same | SAME | 1.00 |  |
| 105 | merge | nuxt:css-link | nuxt@4.4.5#0.4 | 1 | same | same | SAME | 1.00 |  |
| 106 | merge | nuxt:suspense-remount | nuxt@4.4.5#0.5 | 1 | same | same | SAME | 1.00 |  |
| 107 | merge | nuxt:env | nuxt@4.4.5#0.6 | 1 | same | same | SAME | 1.00 |  |
| 108 | merge | nuxt:serverhandlers | nuxt@4.4.5#0.7 | 1 | same | same | SAME | 1.00 |  |
| 109 | merge | nuxt:css-inlining | nuxt@4.4.5#0.8 | 1 | same | same | SAME | 1.00 |  |
| 110 | blocked | nuxt:usefetch~2 | nuxt@4.4.5#0.10 | 0.7 | guard:quote | same | UNSURE | 0.65 | respect factory fetch/baseURL in server useFetch (4.4.5) vs use factory options everywhere (4.4.3) |
| 111 | merge | nuxt:auto-imports | nuxt@4.4.5#0.11 | 1 | same | same | SAME | 1.00 |  |
| 112 | merge | nuxt:island-transform | nuxt@4.4.5#0.12 | 1 | same | same | SAME | 1.00 |  |
| 113 | merge | nuxt:css-inlining~2 | nuxt@4.4.5#0.13 | 1 | same | same | SAME | 1.00 |  |
| 114 | merge | nuxt:head-dom-updates | nuxt@4.4.5#0.14 | 1 | same | same | SAME | 1.00 |  |
| 115 | merge | nuxt:head | nuxt@4.4.5#0.15 | 1 | same | same | SAME | 1.00 |  |
| 116 | merge | nuxt:css-inlining~3 | nuxt@4.4.5#0.16 | 1 | same | same | SAME | 1.00 |  |
| 117 | merge | nuxt:builder-server-dependencies | nuxt@4.4.6#0.3 | 0.99 | same | same | SAME | 1.00 |  |
| 118 | merge | nuxt:payload-cache-items | nuxt@4.4.6#0.6 | 0.99 | same | same | SAME | 1.00 |  |
| 119 | merge | nuxt:app-manifest | nuxt@4.4.6#0.7 | 0.99 | same | same | SAME | 1.00 |  |
| 120 | merge | nuxt:external-redirect-body | nuxt@4.4.6#0.8 | 0.99 | same | same | SAME | 1.00 |  |
| 121 | merge | nuxt:setpagelayout-props | nuxt@4.4.6#0.9 | 0.99 | same | same | SAME | 1.00 |  |
| 122 | merge | nuxt:buildassetsdir | nuxt@4.4.6#0.10 | 1 | same | same | SAME | 1.00 |  |
| 123 | merge | nuxt:useloadingindicator | nuxt@4.4.6#0.11 | 1 | same | same | SAME | 1.00 |  |
| 124 | merge | nuxt:island-request-hash | nuxt@4.4.6#0.12 | 1 | same | same | SAME | 1.00 |  |
| 125 | merge | nuxt:component-less-parent-routes | nuxt@4.4.6#0.15 | 1 | same | same | SAME | 1.00 |  |
| 126 | merge | nuxt:page-islands | nuxt@4.4.6#0.17 | 1 | same | same | SAME | 1.00 |  |
| 127 | merge | nuxt:nossr | nuxt@4.4.7#0.0 | 1 | same | same | SAME | 1.00 |  |
| 128 | merge | nuxt:allowdirs | nuxt@4.4.7#0.1 | 1 | same | same | SAME | 1.00 |  |
| 129 | merge | nuxt:compilation-errors | nuxt@4.4.7#0.6 | 1 | same | same | SAME | 1.00 |  |
| 130 | merge | nuxt:navigateto-open | nuxt@4.4.7#0.7 | 0.99 | same | same | SAME | 1.00 |  |
| 131 | merge | nuxt:navigateto | nuxt@4.4.7#0.8 | 0.97 | same | same | SAME | 1.00 |  |
| 132 | merge | nuxt:nuxtclientfallback | nuxt@4.4.7#0.9 | 1 | same | same | SAME | 1.00 |  |
| 133 | merge | nuxt:noscript | nuxt@4.4.7#0.11 | 0.96 | same | same | SAME | 1.00 |  |
| 134 | merge | nuxt:route-rules | nuxt@4.4.7#0.12 | 0.99 | same | same | SAME | 1.00 |  |
| 135 | merge | nuxt:nuxtlink-href~2 | nuxt@4.4.7#0.13 | 1 | same | same | SAME | 1.00 |  |
| 136 | merge | nuxt:reloadnuxtapp~2 | nuxt@4.4.7#0.14 | 0.96 | same | same | SAME | 1.00 |  |
| 137 | near | nuxt:reloadnuxtapp | nuxt@4.4.7#0.14 | 0.58 | below | different | DIFFERENT | 0.48 | reject cross-origin paths vs validate protocols in reloadNuxtApp: two fixes |
| 138 | merge | nuxt:same-origin-signals | nuxt@4.4.7#0.15 | 0.94 | same | same | SAME | 1.00 |  |
| 139 | merge | nuxt:chrome-devtools-workspace-endpoint | nuxt@4.4.7#0.16 | 1 | same | same | SAME | 1.00 |  |
| 140 | merge | nuxt:vite-node-ipc | nuxt@4.4.7#0.17 | 1 | same | same | SAME | 1.00 |  |
| 141 | merge | nuxt:dev-server-socket-name | nuxt@4.4.8#0.0 | 1 | same | same | SAME | 1.00 |  |
| 142 | merge | nuxt:findpath-type | nuxt@4.4.8#0.1 | 1 | same | same | SAME | 1.00 |  |
| 143 | merge | nuxt:vite-node | nuxt@3.21.9#0.0 | 0.99 | same | same | SAME | 0.92 |  |
| 144 | merge | nuxt:future.compatibilityversion | nuxt@4.5.0#0.0 | 0.95 | same | same | SAME | 0.62 |  |
| 145 | merge | nuxt:definenuxtcomponent | nuxt@4.5.0#0.28 | 1 | same | same | SAME | 0.80 |  |
| 146 | merge | nuxt:inlinestyles~2 | nuxt@4.5.0#1.22 | 0.99 | same | same | SAME | 0.95 |  |
| 147 | merge | nuxt:definepagemeta-keepalive | nuxt@4.5.0#1.23 | 0.99 | same | same | SAME | 0.94 |  |
| 148 | merge | nuxt:usefetch-body | nuxt@4.5.0#1.24 | 0.98 | same | same | SAME | 0.91 |  |
| 149 | merge | nuxt:usefetch-error | nuxt@4.5.0#1.25 | 0.99 | same | same | SAME | 0.93 |  |
| 150 | blocked | nuxt:island-request-hash | nuxt@3.21.10#0.0 | 0.74 | guard:quote | different | DIFFERENT | 0.29 | security: island-props RCE (GHSA-9473/48hr, 3.21.10) vs island request hash (GHSA-g8wj, 3.21.6); guard blocked |
| 151 | near | nuxt:route-rules | nuxt@3.21.10#0.20 | 0.52 | below | same | DIFFERENT | 0.42 | security: case-fold route rule keys (GHSA-hxvh, 3.21.10) vs case-insensitive route rules (GHSA-mm7m, 3.21.7); Codex said same |
| 152 | merge | nuxt:server-island-props | nuxt@4.5.1#0.1 | 0.89 | same | same | SAME | 1.00 |  |
| 153 | merge | nuxt:route-rules~2 | nuxt@4.5.1#0.2 | 0.99 | same | same | SAME | 1.00 |  |
| 154 | merge | nuxt:server-components | nuxt@4.5.1#0.3 | 0.99 | same | same | SAME | 1.00 |  |
| 155 | merge | nuxt:dev-server | nuxt@4.5.1#0.5 | 1 | same | same | SAME | 1.00 |  |
| 156 | merge | nuxt:nuxt-devtools | nuxt@4.5.1#0.6 | 0.98 | same | same | SAME | 0.63 |  |
| 157 | near | nuxt:nossr | nuxt@4.5.1#0.10 | 0.65 | below | different | DIFFERENT | 0.31 | skip payload revival when ssr:false vs assign noSSR before payload extraction |
| 158 | merge | nuxt:pages-extend | nuxt@4.5.1#0.11 | 1 | same | same | SAME | 1.00 |  |
| 159 | merge | nuxt:useroute | nuxt@4.5.1#0.12 | 1 | same | same | SAME | 1.00 |  |
| 160 | merge | nuxt:client-components | nuxt@4.5.1#0.13 | 1 | same | same | SAME | 1.00 |  |
| 161 | merge | nuxt:usefetch~4 | nuxt@4.5.1#0.14 | 0.96 | same | same | SAME | 1.00 |  |
| 162 | merge | nuxt:cached-route-payloads | nuxt@4.5.1#0.15 | 1 | same | same | SAME | 1.00 |  |
| 163 | merge | nuxt:nuxtlink~4 | nuxt@4.5.1#0.17 | 0.99 | same | same | SAME | 1.00 |  |
| 164 | merge | nuxt:useasyncdata-cache | nuxt@4.5.1#0.18 | 1 | same | same | SAME | 1.00 |  |
| 165 | merge | nuxt:external-component-directories | nuxt@4.5.1#0.19 | 1 | same | same | SAME | 1.00 |  |
| 166 | merge | nuxt:layout-types | nuxt@4.5.1#0.22 | 1 | same | same | SAME | 1.00 |  |
| 167 | merge | nuxt:app.buildassetsdir | nuxt@4.5.1#0.24 | 1 | same | same | SAME | 1.00 |  |
| 168 | merge | nuxt:route-rule-keys | nuxt@4.5.1#0.26 | 1 | same | same | SAME | 1.00 |  |
| 169 | blocked | nuxt:chrome-devtools-workspace-endpoint | nuxt@4.5.1#0.27 | 0.78 | guard:quote | same | DIFFERENT | 0.62 | security: loopback peer for devtools workspace (GHSA-7c4v, 4.5.1) vs gate to local requests (GHSA-rq7w, 4.4.7); guard blocked; Codex said same |
| 170 | merge | nuxt:template | nuxt@4.5.1#0.28 | 0.99 | same | same | SAME | 1.00 |  |
| 171 | merge | nuxt:as | nuxt@4.5.1#0.29 | 1 | same | same | SAME | 1.00 |  |
| 172 | near | nuxt:async-data | nuxt@3.21.11#0.5 | 0.69 | below | different | DIFFERENT | 0.31 | settle asyncData status when bailing vs in-flight requests overwriting cleared data |
| 173 | merge | nuxt:client-side-navigation | nuxt@4.5.2#0.4 | 1 | same | same | SAME | 1.00 |  |
| 174 | merge | nuxt:island-payload-serialization | nuxt@4.5.2#0.6 | 1 | same | same | SAME | 1.00 |  |
| 175 | merge | nuxt:island-rendering | nuxt@4.5.2#0.7 | 1 | same | same | SAME | 1.00 |  |
| 176 | merge | nuxt:preview-mode | nuxt@4.5.2#0.13 | 0.99 | same | same | SAME | 1.00 |  |
| 177 | merge | nuxt:asyncdata-status | nuxt@4.5.2#0.14 | 0.98 | same | same | SAME | 1.00 |  |
| 178 | merge | nuxt:route-rules~3 | nuxt@4.5.2#0.18 | 1 | same | same | SAME | 1.00 |  |
| 179 | blocked (cross) | nuxt:experimental.viteenvironmentapi | nuxt@4.0.0+guide.f6d0e597#0.2 | 0.77 | guard:cross | same | UNSURE | 0.31 | guide: environment API as the Nuxt 5 model vs 4.2.0 opt-in flag |
| 180 | blocked (cross) | nuxt:vite | nuxt@4.0.0+guide.f6d0e597#0.3 | 0.82 | guard:cross | same | UNSURE | 0.21 | guide: Vite 8 bundles with Rolldown vs 4.5.0 runs on Vite 8 |
| 181 | near (cross) | nuxt:rolldown-replace | nuxt@4.0.0+guide.f6d0e597#0.3 | 0.54 | below | different | DIFFERENT | 0.46 |  |
| 182 | near (cross) | nuxt:experimental.viteenvironmentapi | nuxt@4.0.0+guide.f6d0e597#0.4 | 0.54 | below | different | DIFFERENT | 0.34 |  |
| 183 | merge (cross) | nuxt:clearnuxtstate | nuxt@4.0.0+guide.f6d0e597#0.12 | 0.99 | same | same | SAME | 0.59 |  |
| 184 | near (cross) | nuxt:experimental.watcher | nuxt@4.0.0+guide.f6d0e597#0.16 | 0.63 | below | same | UNSURE | 0.28 | guide: watcher defaults to builder vs 4.5.0 opt-in shared watcher |
| 185 | near (cross) | nuxt:vue-optionsapi | nuxt@4.0.0+guide.f6d0e597#0.23 | 0.64 | below | same | UNSURE | 0.45 | guide: Options API compiled out vs 4.5.1 adds vue.optionsApi, off for v5+ |
| 186 | near (cross) | nuxt:tsconfig | nuxt@4.0.0+guide.f6d0e597#0.25 | 0.59 | below | different | DIFFERENT | 0.24 |  |
| 187 | near (cross) | nuxt:extendconfig | nuxt@4.0.0+guide.f6d0e597#1.2 | 0.5 | below | same | UNSURE | 0.48 | guide: use a Vite plugin instead of the hooks vs 4.2.0 deprecates the hooks |
| 188 | near (cross) | nuxt:experimental.viteenvironmentapi | nuxt@4.0.0+guide.f6d0e597#1.3 | 0.6 | below | different | DIFFERENT | 0.44 |  |
| 189 | near (cross) | nuxt:vite-environment-api | nuxt@4.0.0+guide.f6d0e597#1.3 | 0.51 | below | different | DIFFERENT | 0.52 |  |
| 190 | blocked (cross) | nuxt:statusmessage | nuxt@4.0.0+guide.f6d0e597#1.28 | 0.73 | guard:breaking | same | DIFFERENT | 0.59 | breaking (statusMessage gone in Nuxt 5) vs deprecation; breaking guard |
| 191 | blocked (cross) | nuxt:vue-optionsapi | nuxt@4.0.0+guide.f6d0e597#3.1 | 0.7 | guard:breaking | same | UNSURE | 0.46 | breaking default in the guide vs the option and its v5 default in 4.5.1 |
| 192 | near (cross) | nuxt:node.js | nuxt@4.6.0#0.8 | 0.55 | below | same | UNSURE | 0.48 | Nuxt CLI v4 Node floor vs Nuxt 5 Node floor (same numbers, different products) |
| 193 | near (cross) | nuxt:nuxt-server~2 | nuxt@4.6.0#0.10 | 0.51 | below | same | SAME | 0.55 | nuxt/server import source |
| 194 | merge (cross) | nuxt:sendredirect | nuxt@4.6.0#0.14 | 0.95 | same | same | SAME | 0.53 |  |
| 195 | merge (cross) | nuxt:createerror | nuxt@4.6.0#0.15 | 0.91 | same | same | SAME | 0.52 |  |
| 196 | merge (cross) | nuxt:experimental.extractserializablepagemeta-extractserializablepagemeta | nuxt@4.6.0#1.2 | 0.98 | same | same | UNSURE | 0.46 | 4.6.0 notes: feature gated behind compatibilityVersion 5; guide: enabled by default in Nuxt 5 (opt-in vs default) |
| 197 | blocked | nuxt:future.compatibilityversion | nuxt@4.6.0#1.9 | 0.89 | guard:quote | same | SAME | 0.47 | compatibilityVersion 5 opt-in |
| 198 | merge (cross) | nuxt:experimental.navigatetoearlyreturn-navigatetoearlyreturn | nuxt@4.6.0#1.13 | 0.89 | same | same | UNSURE | 0.32 | as 196: navigateToEarlyReturn opt-in in 4.6.0 vs on by default in the Nuxt 5 guide |
| 199 | blocked | nuxt:uselayout | nuxt@4.6.0#1.24 | 0.79 | guard:quote | different | DIFFERENT | 0.40 | useLayout exported from nuxt/app vs the composable added |
| 200 | blocked | nuxt:uselayout~2 | nuxt@4.6.0#1.24 | 0.78 | guard:quote | different | DIFFERENT | 0.45 | as 199 |
| 201 | near (cross) | nuxt:typescript.servertsconfig | nuxt@4.6.0#1.29 | 0.55 | below | same | UNSURE | 0.28 | serverTsConfig overrides vs use the Nuxt option instead of Nitro's |
| 202 | near | nuxt:nuxt-upgrade-dedupe | nuxt@4.6.0#2.0 | 0.58 | below | same | SAME | 0.53 | upgrade command recommendation |
| 203 | near | nuxt:nuxt-upgrade-dedupe~2 | nuxt@4.6.0#2.0 | 0.57 | below | different | DIFFERENT | 0.70 | general upgrade advice vs security-release upgrade advice |
| 204 | near (cross) | nuxt:nuxt-server~2 | nuxt@4.6.0#2.20 | 0.62 | below | same | SAME | 0.21 |  |
| 205 | near (cross) | nuxt:fetch~5 | nuxt@4.6.0#2.21 | 0.66 | below | same | SAME | 0.64 |  |
| 206 | blocked (cross) | nuxt:fetch~5 | nuxt@4.6.0#2.22 | 0.72 | guard:cross | same | SAME | 0.64 |  |
| 207 | blocked | nuxt:uselayout~2 | nuxt@4.6.0#2.33 | 0.88 | guard:quote | same | DIFFERENT | 0.39 | as 199 |
| 208 | blocked | nuxt:uselayout | nuxt@4.6.0#2.33 | 0.88 | guard:quote | same | DIFFERENT | 0.39 | as 199 |
| 209 | blocked | nuxt:adddevserverhandler-handler | nuxt@4.6.1#0.9 | 0.77 | guard:quote | different | DIFFERENT | 0.39 |  |
| 210 | blocked | nuxt:nuxt-server~6 | nuxt@4.6.1#0.11 | 0.87 | guard:quote | different | DIFFERENT | 0.51 |  |
| 211 | blocked | nuxt:requestevent | nuxt@4.6.1#0.11 | 0.7 | guard:quote | different | DIFFERENT | 0.26 | dev handlers get RequestEvent vs utilities typed against RequestEvent |
