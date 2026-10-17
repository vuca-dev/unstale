# Applicability inside the breaking tier (job `rank`, 15 October 2026)

Question: tier 1 (breaking changes and removals) now holds 786 records across the 15 replay events. Can an order
inside it, built only from what the record and the repository give (no model at the edge, no per-technology tables),
put more required key changes in the upgrade review's first batch of 16? Vault: Relevance Engine, "Default review
order" and "Relevance funnel"; Capability Synthesis, "Breaking labels" ("the fix is applicability inside tier 1
(`requires`, usage order), not stricter labels"); Data Model Contract, `requires`, `terms`, `replaces`.

## Pre-registration (written before any variant was measured)

**Measured on:** the published catalog (`~/unstale/.store/catalog`, 1,096 records, `sample_n: 0`; same records as
`cat-v2-nosample` in `eval/replay/RESULTS-expanded.md`, so that run's Codex match maps are reused unchanged). Key
changes, required labels (written rule) and DEV/HELD-OUT split as in `eval/replay/events/EVENTS.md`.

**Metric (deterministic, no model call):** required key changes (covered by both match runs) whose catalog record is
in the first 16 of the upgrade-review queue, summed per split. Secondary: all key changes in the first 16; tier-1
size and coverage (must be unchanged: every variant only reorders).

**Whose order.** The CLI's actual order, read from the shipped binary: `unstale init` + `sync` on a copy of each
event snapshot, `unstale review --pass upgrade-review --target <pkg>@<new>` (every component of the event's
technology with a release on the new major), then `decide <id> do-now` on each handed-out record and `review --next`
until 16 records of the event's technology are out (do-now marks take records out of the open queue without a ledger
line, so the order of the rest is unchanged). Records of other technologies in the same queue are skipped (the key
covers one technology). Catalog ids are mapped to the match maps' entry ids through the Python queue (`rid`). While
iterating, an instrumented scratch build dumps the same order directly; the final variant is checked through the
plain CLI loop above. The Python harness queue (`eval/rarity-sample/rarity_queue.py`, `fallback` weights) is ported
with each variant (`eval/rank/rank_queue.py`) and compared with the CLI on the 15 events.

**Variants** (tier 1 = breaking or removal; tiers 2–4 keep type tier then score; `score` = sum of rarity weights of
matched `terms` and `replaces` literals; `hit` = a literal found by the edge's usage matcher):

| Name | Order of the upgrade review |
|---|---|
| B (shipped) | `requires` matching nothing last of the whole queue; then tier; then score |
| A0 | tier; then score (no `requires` demotion; the harness order behind the published 40) |
| A1 | tier; then `requires` matching nothing last inside the tier; then score |
| A2 | tier; then class: 0 a `replaces` or `requires` literal is in the repository, 1 another term matched, 2 nothing matched, 3 `requires` set and none of it found; then score |
| A3 | as A2, but no class for `requires` misses (they sort as 1 or 2 by their other matches) |
| A4 | tier; then `requires` miss last inside the tier; then the weight of the rarest matched literal; then score |

Siblings (same release, a shared term) stay together within one sort group, as now. Nothing is dropped.

**Decision rule.**
1. On DEV (9 events) only, pick the variant with the most required key changes in the CLI's first 16. Ties go to the
   simpler variant (A0, A1, A3, A2, A4 in that order).
2. Ship it only if it beats B on DEV by **at least 2** required changes (match runs move coverage by about 2) and
   loses no more than 1 on all key changes. Otherwise ship nothing.
3. Then report HELD-OUT once for B and the chosen variant. Ship only if the chosen variant's HELD-OUT required count
   is not below B's.
4. And only if `scripts/dogfood.sh` passes and the two dogfood repositories' outputs are no worse (the nest API's
   empty review stays empty with its reasons; next-prisma-app's first batch is listed before and after).

## Results

Run 15 October 2026 (`cli_queue.py`, `rank_queue.py`; scratch work dir is a `cp -cR` copy of the expanded replay's
`w2n`). No model calls. HELD-OUT was looked at once, for B and the chosen variant only, after the DEV choice.

**Required key changes in the first 16, CLI order** (all key changes in brackets):

| Variant | DEV (72 req) | HELD-OUT (22 req) |
|---|---|---|
| B (shipped) | 27 (44) | 4 (6) |
| A0 tier, score | 29 (46) | not run |
| A1 `requires` miss last in tier | 27 (44) | not run |
| A2 evidence classes | 27 (41) | not run |
| A3 evidence classes, no `requires` class | 29 (43) | not run |
| **A4 rarest literal first** | **32 (48)** | **4 (6)** |

- **The CLI's real first batch held 31 of 94 required changes (27 + 4), not the 40 reported from the Python
  harness queue** (`eval/replay/RESULTS-expanded.md`, held-out 8). Causes: the CLI sends records whose `requires`
  match nothing to the end of the whole queue (Prisma 7's `requires` names packages the upgrade adds, `dotenv`,
  `@prisma/adapter-pg`, so required records such as environment variables and the pg adapter drop out); and the
  harness drops some breaking records as applied (`prisma:output`, `prisma:prisma.config.ts~2`), which the CLI keeps.
  The match maps were made on the harness queue, so a CLI record the harness dropped earns no credit: 0–3 of each
  first 16 are unscorable (sigle-prisma7: 3). Both orders are undercounted by this, equally.
- **Fidelity checks.** The instrumented dump of B equals the unmodified CLI's do-now loop on all 9 DEV events; the
  A4 build's loop equals its dump on all 15 events. Restricting A4 to tier 1 (as the table above words it; the
  measured build applied it in every tier) changes no first 16 on any of the 15 events.
- **The Python port does not agree with the CLI.** First-16 overlap 73–75% on DEV and 62–68% on HELD-OUT; it ranks
  A0 best on DEV (33; B 28, A4 30) and has A4 one below B on HELD-OUT (5 vs 6). The harness matches only files that
  mention the technology and never `package.json`, dedups by key, drops breaking records as applied and picks
  releases differently. It is not a usable proxy for the CLI's order; the CLI-driven replay should replace it.

**Decision.** Rule 1–3: A4 beats B on DEV by 5 (all key changes +4) and ties on HELD-OUT, so it passed. **Rule 4
failed:** on next-prisma-app (dogfood), A4's first batch lost `prisma:output` and `prisma:prisma.config.ts~2`
(Prisma 7 migrations that copy is due) to `next:unknown-paths` (one match, `text/plain` in a route) and
`next:validaterscrequestheaders` (one match, `Content-Type` in GitHub workflow YAML). A single rare literal is often
incidental, and in a queue mixing technologies rarity weights from different catalogs are compared directly.
nest-prisma-api was unchanged (nothing to review). **No ordering change shipped.** Next steps, not tested here: a
rare literal counted only outside CI/workflow files or with a second match; per-technology normalisation of weights
in a mixed queue; and the `requires` rule itself (A0/A3 show its demotion costs 2 on DEV), which needs `requires`
written as preconditions rather than packages the upgrade introduces.

## Follow-up: the `requires` demotion (pre-registered before measuring, 15 October 2026)

**What `requires` is meant to express.** Data Model Contract: "literals without which the record cannot apply (a
driver, dialect or platform: `oracledb`) ... empty unless the evidence names a driver, dialect or platform, each value a
literal from the evidence. At the edge, a record whose `requires` matches nothing in the repository goes to the end of
the queue; it is not dropped. To test: wrongful demotions of key changes in the replay." Relevance Engine: records "that
only apply with a specific driver, dialect or platform" get a required term. So: *applies only to projects that already
use X*. A package the change has the project add is the opposite (absent until adopted, like `introduces`).

**Audit** (`requires_audit.py`, published catalog): 69 of 1,096 active records set `requires`. By a deterministic rule
(value in `introduces`, or the summary tells the user to install/load/switch to/use something → *introduced*; the
record's own component or the technology's core package → *self*; else *condition*): 6 introduced, 0 self, 63
condition. Among obligations (the upgrade review's records): 17, of which **5 introduced** (`prisma:environment-
variables` → `dotenv`, `prisma:prisma-adapter-pg~4`, `prisma:prisma-client-runtime-utils`,
`nestjs:nats-io-transport-node`, `nestjs:subscriptions-transport-ws`) and 12 conditions. Of the 12, three are written
as product names the case-sensitive matcher rarely finds in code (`PostgreSQL`, `SQLite`, `node-pg`), so they are
demoted in projects that do use those databases.

**Variants** (measured as before, CLI order, DEV first):
- B: shipped (a `requires` miss goes after the whole queue).
- A0: no `requires` demotion (already measured: DEV 29 vs 27; now checked against rule 4).
- R1: as B, but a `requires` value that is also in the record's `introduces` is ignored (a literal the change
  introduces cannot be a precondition). An edge guard; it cannot see `dotenv`, which is not in `introduces`.

**Decision rule.** Choose on DEV between A0 and R1 (tie → R1, the smaller change to the vault's rule). Ship only if
it beats B on DEV by at least 2 required changes, loses at most 1 on all key changes, the dogfood repositories'
first batches lose no migration record to a record with only incidental matches (listed before/after; nest API stays
empty with its reasons), and its HELD-OUT required count is not below B's. HELD-OUT has been looked at once already
(B and A4, 4 vs 4); this is a second look, for the final choice only. The labelling fix is proposed for central
whatever the edge result.

### Follow-up results

| Order (CLI) | DEV req (all) | HELD-OUT req (all) | Required key records demoted by `requires` (all 15 events) |
|---|---|---|---|
| B (was shipped) | 27 (44) | 4 (6) | 6 |
| A0 no demotion | 29 (46) | not run | 0 |
| **R1 ignore introduced `requires`** | **29 (46)** | **5 (7)** | 3 |

- A0 and R1 tie on DEV; R1 chosen (tie rule). +2 required and +2 all over B.
- Dogfood (rule 4): R1 on next-prisma-app brings `prisma:prisma-client-runtime-utils` and `prisma:prisma-adapter-pg~4`
  (Prisma 7 migrations with real matches) into the first batch, for `prisma:finduniqueorthrow` and
  `prisma:prismaclient`; nest-prisma-api unchanged (nothing to review, same reasons); `scripts/dogfood.sh` 48/48. A0
  would also have passed (it adds `prisma:environment-variables` too, dropping `prisma-migrate-dev-skip-seed`).
- HELD-OUT, second look (disclosed): 5 vs B's 4. **Shipped R1**; the shipped binary's do-now loop gives the same
  first 16 as the instrumented R1 build on all 15 events.
- Still demoted after R1: `prisma:environment-variables` (`dotenv`, not in `introduces`; sigle, zodgen) and
  `prisma:prismabettersqlite3` (`@prisma/adapter-better-sqlite3`, which cedar adds in the upgrade). Both are labelling
  errors the edge cannot see.

### Proposal for central labelling (not applied: `extract.ts` has someone else's uncommitted work)

The labelling step that writes `terms`/`requires` should say, in place of today's `requires` instruction:

> `requires`: literals a project must **already** use for this change to apply to it at all: a database driver or
> adapter package, a dialect, a platform (`oracledb`, `@prisma/adapter-d1`, `fastify`). Empty unless the evidence
> limits the change to such users. **Never** list what the change asks the project to add, install, load or switch
> to (`dotenv` when the CLI stops loading `.env`, `@prisma/adapter-pg` when every Postgres project must adopt it,
> `graphql-ws` replacing `subscriptions-transport-ws`); those go in `introduces`, and the old name in `replaces`.
> Write each value as a project's code or manifest contains it (`pg`, `provider = "postgresql"`, `sqlite`), not as a
> product name (`PostgreSQL`, `SQLite`, `node-pg`).

Check after relabelling: `requires_audit.py` should report 0 *introduced*; re-run the replay (DEV) and dogfood. The
three product-name conditions on obligations (`PostgreSQL`, `SQLite`, `node-pg`) are demoted today in projects that
do use those databases (the edge matches case-sensitively); the second sentence fixes that at the source rather than
by a case-folding rule at the edge.

## Second follow-up: Node-minimum block and `requires` relabel (pre-registered before measuring, 15 October 2026)

**Changes under test.**
- **N (CLI):** an obligation in the upgrade review is never blocked by a structured prerequisite; the unmet
  prerequisite is shown on the record instead ("Prerequisite not met here: …"). Fixes `*:node.js*` and
  `next:typescript` vanishing wherever the project's lowest `engines.node` (or TypeScript) is below the new minimum
  (eval/gate/MISSES.md). Opt-in and bump-digest records are still blocked.
- **L (central):** the `requires` rule of the labelling prompt rewritten as proposed above, and `requires` alone
  re-labelled for every active next/prisma/nestjs record in a side store (`.store/central-requires` →
  `.store/catalog-requires`), terms untouched. Not promoted.

**Measured with the gate** (`eval/gate`, the shipped CLI's own order; match maps reused, since ids do not change):
deterministic first-16 required count first; DEV decides. Conditions: HEAD (`1d37187` on the published catalog,
gate result `cli-1d37187`: CLI first 16 DEV 30 / HELD-OUT 6), N on the published catalog, N + L on the relabelled
catalog.

**Decision rule.**
- N ships if its DEV first-16 required count is not below HEAD's (it is a correctness fix the vault already demands:
  a floor raise is never dropped), its unit test passes and `scripts/dogfood.sh` passes.
- L (the relabelled catalog) is recommended for promotion if N + L beats N on DEV by at least 1 required change and
  loses none on all key changes; otherwise it is reported only (the prompt change stays, as the vault's meaning).
- HELD-OUT once for the final combination. The review arm (tier, K=3) runs only for the final combination and only
  if the deterministic DEV count improves over HEAD; reported against the gate baseline (tier DEV 26.3 / HELD-OUT 4.0)
  and HEAD (27.0 / 5.0).

### Second follow-up results

`requires` relabel (side store `.store/central-requires`, published to `.store/catalog-requires`; not promoted;
`npm run catalog -- relabel-requires`): **102 of 1,096 records changed** (next 7, prisma 32, nestjs 63), 35 Codex calls.
- Removed what the change has the project add: `prisma:environment-variables` `dotenv` → [], `prisma:prisma-adapter-pg~4`
  → [], `next:babel-plugin-react-compiler` → [], `nestjs:cls-req` → [].
- Product names rewritten as code writes them: `PostgreSQL` → `postgresql` (10 records), `SQL Server` → `sqlserver`,
  `node-pg` → `pg`, `SQLite` → `sqlite`.
- Added conditions (mostly fixes and bump-digest records): NestJS `fastify` (20), `kafka`, `rmq`, `redis`, `grpc`;
  Prisma `mongodb`, `mysql`. Debatable ones: `prisma:prisma-client-runtime-utils` → `prisma-client-js` (right: it
  concerns users of that generator), `nestjs:subscriptions-transport-ws` → `subscriptions-transport-ws` (right: only
  projects still on it), `nestjs:nats-io-transport-node` → `nats`. Values such as `rmq` or `kafka` are lowercase while
  projects write `Transport.RMQ`; the case-sensitive matcher will miss them, which only matters for obligations.

Gate (`eval/gate/results/rank-node*.md`; required key changes; CLI first 16 is deterministic, review is the tier arm K=3):

| Condition | CLI first 16 DEV / HELD-OUT | Review tier DEV / HELD-OUT |
|---|---|---|
| gate baseline (published, 2877f2c) | 28 / 5 | 26.3 / 4.0 |
| HEAD 1d37187 | 30 / 6 | 27.0 / 5.0 |
| **N: obligations never blocked** | **31 / 6** | **27.7 [26–29] / 5.0** |
| N + L (relabelled catalog) | 31 / 7 | not run |

- **N shipped**: DEV +1 over HEAD (zodgen's `prisma:node.js`, K11, now in the first 16); HELD-OUT unchanged; the
  dogfood repositories' first batches are identical to HEAD's; `scripts/dogfood.sh` 48/48. The gate script prints
  both splits at once, so HELD-OUT was seen for N and N + L together (one look each).
- **L not recommended for promotion yet**: no DEV change over N (rule: at least +1); HELD-OUT +1 is not a decision
  input. The prompt change stays in `extract.ts` because it states the vault's meaning; the catalog stays as it is
  until a rebuild or an explicit promotion.
- Codex: 35 (relabel) + 18 (review; 27 cache hits) = 53 calls. No other model calls.

## Follow-up: file roles (pre-registered before measuring, 15 October 2026)

**Why.** The AuditAI rehearsal (vault: Onboarding DX - Gap Hypotheses, H1) showed matches in CI workflows, QA maps,
evaluation corpora and test files taking the evidence and the score. The first follow-up above already names "a rare
literal counted only outside CI/workflow files" as the next thing to test. `usage::Role` (application, test,
tooling, example, docs, generated, vendored; path conventions plus `.gitattributes` linguist lines) now orders the
evidence application-first. That change does not affect the order. This follow-up measures letting roles into the
score and the applied check.

**Variants** (everything else as shipped):

| Name | Score | Applied check (introduced literal as a whole token) |
|---|---|---|
| B (shipped) | sum of rarity weights of matched literals | any file |
| R1 | a literal matched **only** outside application files counts half its weight | only application files, or test files that are code (not `.json`/`.yaml`/`.toml`/`.sql` data) |
| R2 | as R1, but such a literal counts 0 | as R1 |

`requires` misses are unchanged: a driver named in a compose or CI file still means the project uses it.

**Decision rule.** The motivation is evidence quality on repositories with fixtures and tooling, and the replay
events are mostly application repositories, so this is a non-inferiority test, not a gain test:
1. On DEV, pick R1 or R2 by required key changes in the CLI's first 16. Ties go to R1 (milder).
2. Ship it only if, against B, DEV required is not lower and DEV all-key is at most 1 lower.
3. Then HELD-OUT once for B and the chosen variant. Ship only if its HELD-OUT required is not lower than B's.
4. And only if `scripts/dogfood.sh` passes, the dogfood repositories' first batches are no worse (listed before and
   after), and the AuditAI rehearsal copy's evidence keeps its application-first share.

Measured with the gate's deterministic stages only (`gate.py` cliqueue, reused match maps, score; no review calls),
catalog `.store/catalog-adv2`.

### File roles: results

Run 15 October 2026 with the gate's deterministic stages (`gate.py` cliqueue, match reused from `eval/gate/match`,
score), catalog `.store/catalog-adv2`, no model calls. B reproduces the last recorded gate (`advisories-osv`) exactly.

| Variant | DEV required / all (first 16) | HELD-OUT required / all |
|---|---|---|
| B (shipped order) | 31 / 46 | 6 / 11 |
| **R1** | **32 / 47** | **5 / 10** |
| R2 | 29 / 43 | not looked at |

**Decision: nothing ships.** Rules 1–2: R1 is chosen on DEV (+1 / +1). Rule 3 fails: HELD-OUT required 5 < 6. The
score weighting and the applied-check filter were reverted. Evidence ordering by role stays (it does not change the
order).

**Why (diagnosis, after the decision).** chmonitor-next16 K6 (`next:webpack~2`) fell from rank 12 to 36.
chmonitor's `docs/` is its own Next.js application (`docs/package.json`: `next build`, `docs/next.config.mjs`). The
conventions class root-level `docs/` as documentation, so its real Next.js usage counted half and three records
matched in the root application moved ahead. Roles from path conventions alone are wrong for a directory that is
itself a package declaring the technology.

**Next (not tested here):** compute a file's role relative to the nearest manifest that declares the technology. A
file under a package that depends on the technology is application code for that technology, whatever the parent
directory is called; conventions apply only within the package. For AuditAI this keeps `scripts/autoresearch/`
demoted for `docx` (`scripts/package.json` does not declare it). HELD-OUT has now been seen once for this family,
so the next variant must be decided on DEV, the dogfood repositories and AuditAI, and report HELD-OUT as
already-seen.

## Follow-up: package-relative roles (pre-registered before measuring, 15 October 2026)

**Variant R3:** R1 (a literal matched only outside application files counts half its weight; the applied check
counts only application files and test code, not fixtures, tooling or docs), with each file's role computed **for
the technology**. The role is taken relative to the deepest package whose manifest declares one of the technology's
components (`stack::Package.declared`); with no such package, the path's own role. `.gitattributes` linguist lines
still win. Evidence ordering uses the same roles.

**Decision rule.** HELD-OUT has already been seen for this family (R1 failed rule 3 on it), so it cannot be an
independent decision input:
1. DEV required first-16 not below B (31) and DEV all-key at most 1 below B (46).
2. HELD-OUT reported. Because it is the diagnosed failure, it must also not be below B (6). That is a confirmation
   of the fix, not an independent test.
3. The dogfood repositories' first batches are no worse (listed before and after), and on AuditAI the evidence's
   application-first share holds and `docx` evidence does not come from `scripts/autoresearch/`.

**Baseline note.** The working tree now also holds another session's lockfile-choice changes, so B is rebuilt from it
with R3 switched off (**B2**: equal weights, applied on any file, roles by path only). R3 is compared with B2, not with
the earlier B binary.

**Variant R4** (pre-registered with R3, before either was measured): R3 plus a language rule. A technology's literals
never count in source code of another supported ecosystem's language (`.py` for an npm technology, `.ts` for a PyPI
one); shared config and data files still count. Reason: since the PyPI adapter added `.py` to the read set, Next.js and
Pulumi terms match Python files on AuditAI. Same decision rule as R3, against B2. R4 ships only if R3 passes.

### Package-relative roles: results

Run 15 October 2026, deterministic gate stages, catalog `.store/catalog-adv2`, no model calls.

| Variant | DEV required / all | HELD-OUT required / all (already seen) |
|---|---|---|
| B2 (current tree, roles off) | 31 / 46 | 6 / 11 |
| **R3** | **32 / 47** | **6 / 11** |

**Decision: R3 ships.**
- Rule 1: DEV +1 / +1. Into the first 16: cedar-prisma7 K21 and K23 (rank 21 → 13). Out: zodgen-prisma7 K3 (9 → 21).
- Rule 2: HELD-OUT equals B2. chmonitor K6, R1's failure, is back in the first 16.
- Rule 3: `scripts/dogfood.sh` gives identical decisions in both repositories under B and R3. Both have 24 passes and the same 1 failure, which is central-side ("baseline publish is byte-identical"), not the CLI.
- AuditAI: same shortlist as B2. Evidence moved to the package that declares each technology (Pulumi `.pulumi-config/`, Playwright `integration-tests/`, `jose` `scripts/exterminator-auth.mjs`), and `docx` cites `ui/` production code.

**R4 (R3 + language rule): ships.** The order is identical to R3's on all 15 events (DEV 32 / 47, HELD-OUT 6 / 11):
the replay repositories are JavaScript-only. Its effect is on mixed-language repositories. On AuditAI, Next.js and
Pulumi terms no longer cite Python files, and the Next.js `connection` card cites `next/server` in an API route.

## Follow-up: import co-occurrence and term specificity (pre-registered before measuring, 15 October 2026)

Baseline: **R4** (shipped). Two independent levers, each its own variant. Both are new families, so HELD-OUT is used
once, after the DEV decision.

| Name | Change on top of R4 |
|---|---|
| R5 (import co-occurrence) | A literal keeps its full weight only if one of its application files is either not source code (config, schema, data) or **imports one of the technology's packages** (JS/TS `from`/`require`/`import()` of the package or a subpath; Python `import`/`from`). Otherwise half, like a non-application match. |
| R6 (term specificity) | A plain lowercase word literal (`connection`, `cookies`) counts half its rarity weight. |
| R56 | Both. |

**Why not entry-point reachability itself.** Entry points are framework-defined (Next.js routes, Nest modules, Django URL
configs). Finding them needs per-framework knowledge, which the design rule excludes. R5 is the generic part: whether
the file touches the technology at all.

**Decision rule.**
1. On DEV, pick the best of R5, R6 and R56 by required key changes in the first 16 (ties to the simpler: R6, R5, R56).
2. Ship only if it is at least +1 required on DEV over R4, and all-key is not lower.
3. Then HELD-OUT once for R4 and the choice: ship only if required is not lower than R4's.
4. And only if dogfood decisions are no worse and AuditAI's shortlist has no new card with weaker evidence.
Otherwise nothing ships, and the reason is stated.

### Import co-occurrence and term specificity: results

Deterministic gate stages, catalog `.store/catalog-adv2`, no model calls.

| Variant | DEV required / all | HELD-OUT required / all |
|---|---|---|
| R4 (shipped) | 32 / 47 | 6 / 11 |
| R5 | 35 / 50 | 5 / 10 |
| R6 | 32 / 47 | not looked at |
| R56 | 34 / 49 | not looked at |

**Decision: nothing ships.** Rules 1–2 chose R5 (+3 / +3 on DEV: payloadplugins K2 and K3, zodgen K3 into the first
16). Rule 3 failed: HELD-OUT required 5 < 6 (sigle-prisma7 K2, rank 15 → 17). R6 moved no key change, so it fails
rule 2. All code for both was removed.

**Why, and why this family stops here.** sigle reaches Prisma through a local re-export (`~/lib/prisma`, 22 imports).
That module imports `PrismaClient` from `~/__generated__/prisma/client`, Prisma 7's generated client at a custom
output, which is gitignored and not in the repository. No file names `@prisma/client`, so a per-file import check
discounts real usage.
- Re-exports and path aliases could be followed by a generic per-language module resolver.
- Generated code cannot: the module is absent, and tying `__generated__/prisma/client` to Prisma means reading
  Prisma's generator configuration, which is per-technology knowledge the design rule excludes.
- Entry-point reachability meets the same limit: entry points are framework-defined.

These are judgement limits, not effort. Without per-technology knowledge, the signal discounts real usage on
held-out data.

**Dogfood note.** The earlier "baseline publish" failure was a harness artifact. With `TMPDIR` set to a long scratch
path, `tsx`'s IPC socket path (111 bytes) exceeded macOS's 104-byte limit (`listen EINVAL`), and the dogfood run
stopped after the first repository. With the default `TMPDIR`, the final build passes 97/97 across both repositories.
