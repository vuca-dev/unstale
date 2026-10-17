# Bump-digest security lines against the GitHub Advisory Database (15 October 2026)

**Question.** Do the catalog's security records and the bump digest agree with the reviewed advisories in the GitHub
Advisory Database for next, prisma and nestjs?

**Data.**
- Advisories: `GET /advisories?ecosystem=npm&type=reviewed&affects=<pkg>`, all pages, for every package of each
  technology. Packages are the components plus the repository's `packages/*`, so nestjs includes
  `@nestjs/platform-fastify` and `@nestjs/microservices`. Withdrawn advisories are dropped. Cached in
  `.store/central-trust/advisories/`.
- Counts: next 73 reviewed, 42 in the catalog window; nestjs 11 and 9; prisma 0.
- Units: 87 pairs of advisory × release line whose first patched version is a stable release in the catalog's
  release index.

**Reference.** Which records describe each advisory's fix comes from Codex `gpt-5.6-luna`, one advisory per call. The
candidates are records naming the id, records released in a patched version, and security records within three
releases of it on the line. Calls are cached.
- That is 51 calls before and 50 after, with 1.36M input tokens in total (1.01M of them cached).
- The reference is fuzzy where two advisories have near-identical titles; see (b).

**Scripts.**
- `measure.mts` computes the metrics.
- `digest.sh` runs `unstale init/sync/digest` on copies of both dogfood repositories.
- Outputs: `before.json` and `after.json`, plus `before/` and `after/` (digest text).

**Before** is the published catalog (`.store/catalog`) and the committed CLI before this change. **After** is the
side store `.store/central-trust` with advisories attached (`npm run catalog -- advisories`), republished to
`.store/catalog-trust`, plus the CLI at 5967928.

## Results

| | Before | After |
|---|---|---|
| (a) advisory × line units with a security record dated to the first patched release on that line | **69 / 87** (17 line missing, 1 advisory with no record) | **87 / 87** |
| (b) records dated to a release the advisory says is still affected (reference mapping) | 1 | 3 (see below; 2 with the records' own advisory ids) |
| Security records that describe a reviewed advisory | 62 / 96 (next 57/75, nestjs 5/11, prisma 0/10) | 72 / 112 (next 61/85, nestjs 11/17, prisma 0/10) |
| **(c) next-prisma-app** (next 16.2.1 → 16.4.1): advisories fixed by the bump, by the ranges | 31 | 31 |
| Digest security lines | 39 | 43 |
| Lines that are a fixed advisory: **line precision** | 26 / 39 = **0.67** | 31 / 43 = **0.72** |
| Advisories listed: **recall** | 26 / 31 = **0.84** | 31 / 31 = **1.00** |
| Advisories listed: **precision** | 26 / 27 = **0.96** | 31 / 31 = **1.00** |
| **(c) nest-prisma-api** (at the newest versions, `@nestjs/platform-express`) | 0 fixed; digest empty | 0 fixed; digest empty |

After the change, the digest lists exactly the 31 advisories the bump fixes, one line per GHSA id with its CVE, severity
and the database's summary. A second check, independent of the Codex reference, compares the GHSA ids printed in
`after/next-prisma-app.txt` with the set computed from the ranges: identical, 31 = 31. The 12 remaining lines carry no
advisory (below), which is why line precision is 0.72 and not 1.

## Errors, with examples

**Before:**
- **A fix on one line only (backports).** `next:app-router` (GHSA-q4gf, DoS with Server Components) was dated
  15.5.15 only; its 16.2.3 release was missing. For next 16.2.1 the funnel then took the change as already installed,
  and the digest missed it. 26hh, 4633, 68g3 and 6gpp were missed for similar reasons.
- **A fix not labelled security.** GHSA-3x4c (unbounded `next/image` disk cache) is described by
  `next:images.maximumdiskcachesize`, which is labelled `new_option`, benefit `none`. GHSA-68g3 and GHSA-4633 (cache
  confusion of response bodies) are in `next:request-bodies`, labelled `fix` / `correctness`. GHSA-6gpp is in
  `next:turbopack~9`, also labelled `fix`. None of these showed as security.
- **Listed but not affected.** GHSA-3w37 (`use cache` draft-mode leak) affects `>= 16.3.0, < 16.3.8`. The record's
  release 16.3.8 is above the installed 16.2.1, so the digest listed it, but 16.2.1 was never vulnerable.
- **No record at all.** GHSA-6v32 (Nest middleware bypass on Fastify via a trailing slash, 11.1.24): the release notes
  do not mention it.
- **(b) wrong date.** Codex maps GHSA-wf42 (Fastify HEAD-request middleware bypass, patched 11.1.16) to
  `nestjs:fastify-middleware`, which is dated 11.1.14 (GHSA-r4wm's release). This may be a reference ambiguity: the
  record's text is generic.

**After:**
- **(b), the remaining dating errors.**
  - `next:middleware-proxy` holds GHSA-267c (fixed 15.5.16 / 16.2.5) and GHSA-26hh, its "incomplete fix follow-up"
    (fixed 15.5.18 / 16.2.6). It got both because the first run's matching merged the 15.5.18 and 16.2.6 items into
    it: their quotes equal the earlier titles once the ids, which were in the links, are removed. The record's
    `releases` therefore claim 26hh at 15.5.16, which is wrong. The digest is still right, because it reads 26hh's
    own range.
  - The other two reference-only errors are fuzzy reference calls: GHSA-8h8q mapped to `next:app-router` (GHSA-q4gf's
    record), and GHSA-wf42 as before.
- **Security lines without an advisory** (12 on next-prisma-app):
  - prisma 7: a transitive-dependency bump, credentials-file permissions, the AI "safety checkpoint" for `db push`,
    Studio binding to 127.0.0.1, a Bytes buffer fix. None of them is a reviewed advisory (prisma has none).
  - next 5: two RCE fixes in 16.4.1 (released 14 October; no reviewed advisory yet), GHSA-h694 (named in the 16.3.8
    notes, not in the reviewed database), and two hardening items (dev request-id headers, CSP nonces on loading
    scripts).
  - These lines stay as they were: the database lags new releases, and dropping them could hide a real fix.

## What changed (central, schema, CLI)

- `central/src/pipeline/advisories.ts`:
  - fetch and cache advisories;
  - attach by id from the notes line the quote came from, else judge at ingest, else a new record;
  - add the advisory, its evidence, benefit `security`, and the patched release on every line.
- Runs after ingest in the pipeline and as `npm run catalog -- advisories`.
- Side store: next 42 in window (38 by id, 2 judged, 2 new records, 28 releases added); nestjs 9 (5 judged, 4 new);
  18 Jev calls.
- Schema 1: an optional record field `advisories` (id, aliases, severity, summary, url, affected ranges per package)
  and the evidence kind `advisory`, through the seam with contract fixtures both ways.
- CLI:
  - `review::advisory_fixes` and `in_advisory_range` decide from the ranges and the installed version of the affected
    package;
  - `digest_lines` prints one line per advisory;
  - `funnel::Outcome.versions` (the stack's versions) is the only funnel change.

## Not fixed

- **The `next:middleware-proxy` false merge.** Splitting it is a manual `catalog` action. Proposed: give the
  advisory guard the ids of the source line (`idsAtQuote`) at ingest, as the advisory step does. Not done here: it
  changes matching, and the match audit's cases would need re-running.
- **Mislabelled records.** `next:images.maximumdiskcachesize` and similar now carry the advisory and benefit
  `security`, but `change_type` is unchanged.

## Generalised: OSV source, ranges resolved centrally, per-technology lock (pre-registered 15 October 2026, 20:20)

**Change.** Source = OSV (`api.osv.dev/v1/query` by package URL, no token) instead of GitHub REST `ecosystem=npm`;
siblings through an ecosystem hook on registry metadata (npm: same scope and `repository` = the technology's
repository) instead of the repository's `packages/*`; each affected range resolved in central against the
technology's release index and published as `index` + per-range `versions`, so the edge compares version strings and
parses no ranges (unknown → nothing said, the record listed as before). `next:middleware-proxy` is not touched.

**Run.** Side store `.store/central-adv2` (a `cp -cR` of the live store at 20:19, after the onboarding service and
`resolve.mts` were stopped) and `.store/catalog-adv2`: `npm run catalog -- advisories` for next, prisma, nestjs, then
`digest.sh` with the new CLI and `measure.mts` (reference calls cached; new advisories or candidates may cost a few).

**Decision rule, fixed before running.** Accept when all hold: (a) every advisory × line unit dated correctly
(the previous run: 87/87; the count may differ if OSV or the release index changed; then all units of the new count);
(c) next-prisma-app digest recall = 1.0 (previous 31/31), advisory precision 1.0, line precision ≥ 0.72; (b) no record
dated to a still-affected release beyond the 3 known (no new false merge); nestjs keeps `@nestjs/platform-fastify` and
`@nestjs/microservices` among its packages; gate DEV not below the current baseline (CLI first 16 DEV 31, `tier`
review DEV 27.7); HELD-OUT reported once at the end.

### Results (side store `.store/central-adv2` → `.store/catalog-adv2`, CLI at 1a353e4)

| | Previous (GitHub REST, edge ranges) | Now (OSV, central resolution) |
|---|---|---|
| Advisories: next / nestjs / prisma | 73 / 11 / 0 | 73 / 11 / 1 (`@prisma/sdk`, 2021, out of window) |
| In window: next / nestjs | 42 / 9 | 42 / 9 |
| nestjs packages | 9 (repository `packages/*`) | the same 9 (scope listing + registry `repository`) |
| (a) advisory × line units dated correctly | 87 / 87 | **87 / 87** |
| (b) units with a record dated to a still-affected release (reference) | 3 | **2** (GHSA-8h8q on `next:app-router`, both lines; the reference's GHSA-wf42 call changed with the new candidates) |
| (c) next-prisma-app: advisories the bump fixes (ranges) | 31 | 31 (target now 16.4.2) |
| recall / advisory precision | 31/31 / 1.00 | **31/31 / 1.00** |
| line precision | 31/43 = 0.72 | **31/43 = 0.72** |
| nest-prisma-api | 0, digest empty | 0, digest empty |

- The digest's 31 GHSA ids are now decided by string lookup in the resolved versions (16.2.1 and 16.4.2 are in next's
  index). The 12 lines without an advisory are the same records as before (prisma 7, next 5).
- Stage cost on the side store: 21 OSV requests, 2 npm scope listings and ~204 registry `latest` reads (nestjs 59,
  prisma 145 packages), 18 Jev calls (judge; the side store's classifier cache did not have the trust run's), 0
  Codex. A rerun with `--offline` changes nothing (byte-identical stores, 0 calls).
- Reference (measure.mts): 51 Codex calls, all uncached (the reference's cache lives in the store copied, and the
  prompts' description text now comes from OSV's `details`); 694k input tokens, 512k of them cached.
- `next:middleware-proxy` (two advisories in one record from a first-run false merge) is unchanged: splitting it
  needs a manual merge undo plus the ingest guard change; not done (optional item, not small).
- Dogfood (`scripts/dogfood.sh` on a copy of the side stores): 48 passed, 0 failed.

Decision: accepted on (a), (b), (c) and the package check; the gate below.

### Gate (`eval/gate/run_gate.sh .store/catalog-adv2 advisories-osv`, CLI at 1a353e4, K = 3)

Required key changes, compared with the current baseline (`results/rank-node.md`, the HEAD row of the 15 October build report):

| Split | CLI first 16 | `tier` review found | `all` review found |
|---|---|---|---|
| DEV (72) | **31** (baseline 31) | **27.3 [25–29]** (baseline 27.7 [26–29]) | 38.0 [37–39] |
| HELD-OUT (22), reported once | 6 | 5.0 [5–5] | 10.0 [9–11] |

- **CLI first 16 holds at 31.** Per event, DEV queues and first-16 contents are unchanged.
- **The `tier` review mean is 0.4 below the baseline.** Every DEV event has the same per-run found counts as the
  baseline, except one `tier` run of temporal-nest12, which found 4 instead of 5 with the same first 16 keys (two
  optional keys moved from rank 2 to 6).
- **Against the rule:** literally read, the pre-registered rule ("not below the current baseline") is missed on this
  review mean by one finding in one of 27 runs. The deterministic measure is unchanged, and the gap is inside the
  run-to-run spread (sd 2.8). I report it as is and have not rerun that event.
- **Coverage on DEV drops by 1** (invoicerr-nest12 K10, required). K10 was covered but never queued, so no queue
  metric moves. The nestjs window now holds 4 advisory records, so the match calls were redone.
- **Cost:** 50 new Codex calls (60 cache hits), 10.8M new input tokens.

### Live store: not written (20:48)

The conditions for writing live did not hold at the end of the run.
- The onboarding service had been restarted at 20:26 (pid 33705, from `central/src/onboarding/cli.ts`). It is
  running this working tree's code, so it takes the lock and runs the advisories stage itself; 16 technologies
  already carry advisories.
- Nearly 2,000 files under `.store/central` changed in the last 10 minutes.

Next has a queued job in the service, so the service will attach next's advisories itself when that job's history
completes. Prisma and nestjs have no service job.

To publish by hand when nothing else writes the live store (each command waits for the technology's lock):

    cd ~/unstale/central && for t in next prisma nestjs; do npx tsx src/pipeline/cli.ts advisories --tech $t; done
    cd ~/unstale && scripts/dogfood.sh && eval/advisories/digest.sh $PWD/.store/catalog <out dir>

## Attachment at the best-matching item, recomputed links, one advisory per record (pre-registered 16 October 2026, 21:40)

**Finding.** `next:middleware-proxy` is not a false merge. Next's security notes are cumulative: 15.5.18 and 16.2.6
re-list GHSA-267c next to the new GHSA-26hh ("... segment-prefetch routes - Incomplete Fix Follow-Up"). `idsAtQuote`
took ids from every line containing the quote, and 267c's title is a prefix of 26hh's, so 26hh was attached to
middleware-proxy as well as to its own record `middleware-proxy~4`. The same prefix effect put GHSA-4633 ("... with
bodies containing invalid UTF-8 byte sequences") on `request-bodies` and `response-bodies`. 15 advisories sat on more
than one record: 13 in next (twin records with identical quotes, one per release line), axios GHSA-6CHQ and lodash
GHSA-F23M.

**Change.** (1) `idsAtQuote` locates the quote at the best-matching item only: link targets and ids stripped, each
window of up to 4 lines containing the quote scored by coverage (quote length / window text length); the best gives
the ids; a tie between windows naming different ids gives none (the advisory is then judged). (2) Id-based links are
recomputed on every run with no model call; a link whose basis no longer holds is removed (history
`advisory-removed`) and, if no record holds the advisory, it is judged once (cached by request hash). Judged links and
records made from an advisory stay while their record is active. (3) One advisory, one record: holders whose
release-notes quotes are near-identical (`nearIdenticalQuote`) and whose releases are all fix releases of the
advisory are twins and merge deterministically (`mergeInto`, history, no model call); other multi-holders are
reported in the run output.

**Decision rule, fixed before running.** On the side store `.store/central-lines` (a `cp -cR` of the live store at
21:25) → `.store/catalog-lines`, with the CLI built from HEAD plus the release-lines edge change: (a) every advisory ×
line unit dated correctly (87/87 by the old lines; all units of the new count by derived lines); (c) next-prisma-app
digest recall 31/31, advisory precision 1.0, line precision ≥ 0.72; `next:middleware-proxy` no longer holds GHSA-26hh;
no advisory on more than one record except reported cases with a stated reason; 0 Jev and 0 Codex calls in the
advisories stage on a store whose advisories are already attached; gate as in eval/lines/RESULTS.md.

### Results (side store `.store/central-lines3` → `.store/catalog-lines3`, 7b71334; CLI HEAD + release-lines edge)

| | Before (live) | After |
|---|---|---|
| Advisories on more than one record (next / other) | 13 / 2 | **0 / 2** (axios GHSA-6CHQ, lodash GHSA-F23M: reported, see below) |
| Id links removed (basis no longer holds) | | 3: GHSA-26HH from `next:middleware-proxy`, GHSA-4633 from `next:request-bodies` and `next:response-bodies` |
| Twin merges (next) | | 14 (list below) |
| (a) advisory × line units dated | 87/87 | **87/87** (103/103 by derived lines) |
| (b) units with a record dated to a still-affected release | 2 | 2 (unchanged) |
| next-prisma-app: recall / advisory precision | 31/31 / 1.0 | **31/31 / 1.0** |
| line precision | 31/43 = 0.72 | **31/44 = 0.70** (old edge on this catalog: 31/43 = 0.72) |
| `next:middleware-proxy` holds | 267C, 26HH | **267C only** (26HH on `middleware-proxy~4`) |
| Stage calls (each technology, every run) | | **0 Jev, 0 Codex**; a rerun changes nothing |

Twin merges (from → into, advisory): image-optimization-api~5 → ~4 (2XP9); lru-disk-cache →
images.maximumdiskcachesize (3X4C); response-bodies~2 → request-bodies~2 (4633); server-action-payload → edge-runtime
(4C39); ssg and ssg-and-isr-pages → isr (4JQV); response-bodies → request-bodies (68G3); turbopack~9 →
middleware-proxy~5 (6GPP: the 15.5.21 backport names it at the same item, though OSV lists only 16.2.11 as fixed);
server-actions~5 → ~3 (89XV); server-function-endpoints~2 → server-function-endpoints (955P); server-actions~4 → ~2
(M99W); windows-hosted-servers~2 → windows-hosted-servers (P293); rewrites~3 → ~2 (P9J2); image-optimization-api~3 →
~2 (Q8WF). All in `next:`.

Reported, not merged (dry run of the stage over all 94 technologies of the live store, offline, no calls): axios
GHSA-6CHQ on `data.getheaders` and `isformdata`, lodash GHSA-F23M on `omit` and `unset`. In both, one release-notes
item that names the advisory was extracted as two changes; each record describes part of the fix, so both keep it.
The same dry run removes nothing outside next and makes no judge call; releases change for react (4 records),
@auth0/nextjs-auth0 (1) and extend-ai-react-xlsx (1) when the service next runs their stage.

A variant that took the id from any release naming the advisory (not only fix releases) was tried first and dropped:
astro 6.4.7 says it "preserves the security fix for CVE-2025-66202", which would have attached GHSA-WHQG to an
unrelated record. The twin rule covers the backport case instead.

**Decision:** the attachment criteria hold; line precision misses 0.72 by one line (eval/lines/RESULTS.md, the
`next:next-og` line the new edge shows, which is correct and not a duplicate). Accepted by the user and published live
on 16 October at 02:00 (eval/lines/RESULTS.md, "Live").
