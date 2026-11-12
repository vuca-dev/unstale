# Edge inference: execution tracker

> Single source of truth for the sprint. The PM is the only writer; EMs and verifiers report in their exit
> summaries and the PM transcribes. Verify §1 against reality before acting on it.
> Lives on branch `sprint/edge-tracker` in `/Users/jason/unstale-edge-sprint` (pushed after every update; merged at
> program close).

## §1 Active state

- **Shape:** INDEPENDENT PRs to `main`. Every chunk is additive and behind one switch (README, "One switch").
- **Ground truth:** GitHub PR state. Repo `vuca-dev/unstale`.
- **Base:** `origin/main` @ `d0fa368` (#250 merge)
- **Base health:** PR checks are `rust`, `central`, `gateway`; re-query before every merge.
- **Open PRs:** #231 (no-key eval draft, blocked on the ingest decision), #240 (docs and site, DRAFT at `48b9c6d`, CI green; HELD for the CEO, never merged by agents; conflicts expected with the CEO's `smooth-wordmark` branch in `README.md` and `gateway/site/build.ts`)
- **Live worktrees (sprint):** `/Users/jason/unstale-edge-sprint` (tracker), `/Users/jason/unstale-ws6b` (#238), `/Users/jason/unstale-ws9-no-key` + `/Users/jason/unstale-ws9-scout` (#231), `/Users/jason/unstale-parity` (paid answer caches; keep)
- **Live subagents:** #238 reviewer (Fable). Idle, resumable: matrix EM, no-key eval agent.
- **Merged + verified:** WS0 → #213 `673c191`
- **Merged since last update:** #237 parity fixes `7bb7e6d`; #236 parity results `b778876`; #239 measured figures `8b2fe69`
- **Next:** #238 review → fixes, rebase, merge; small product-fix PR for bugs the matrix confirmed; CEO go-ahead on the ingest starvation fix (unblocks the no-key eval); docs-and-site PR last, as a held draft
- **Sprint API spend so far:** ≈ $0.28 of $10

## §2 CEO directives (durable; read every iteration)

- **11 November, merges:** "allow agent merges, but remember to hold the README/site copy one for my review". Reviewed sprint PRs with green CI and zero unresolved threads may be admin-merged by agents or the PM. The docs-and-site PR stays a draft and is merged only by the CEO. (The permission system refused a subagent's merge of #239 twice; the PM merged it under this directive.)

### Scope and authority
- Central keeps deterministic work only. Model steps run on the client, on the user's key or Codex plan.
- WS7 (release, cutover) is CEO-run; agents do not release. Publishing to npm or Homebrew is allowed only when a
  test needs a published build.
- WS8 (docs and site) is opened as a **draft and held for CEO review. Never admin-merge it.**
- Other PRs: admin merge is authorised once the pre-merge gates hold.
- No open decisions. If a new one appears, the EM stops that item, reports it, and carries on with the rest.
- Experiments have a pass rule and a stopping rule written before the run. One run, at most one revision, a final
  run. No open-ended tuning.
- Solutions generalise: no per-technology hand work; fixtures are test cases only.

### CEO decisions, 11 November (playback review)
- Terminal output follows `docs/edge-inference/terminal-principles.md`. It supersedes earlier copy rules where
  they differ.
- Session-start hooks and sync go behind the switch until the release.
- The monthly token limit is a user setting, not a fixed limit.
- No provider usable: prompt, with the trade quantified; never a silent default.
- Degraded states are warnings in plain words, not neutral "deferred" lines.
- Review bot quota: not raised; fresh reviewers and verifiers do the review.
- PR #219 was merged by the CEO. Central has no hosting decision pending (build from the repo root is fine).
- First live ingest on the change-events code: run 42940631609 on `725b8c1`, success.

### Hard rules
- Never add a `Co-Authored-By` trailer for any AI tool.
- Commit only your own paths: `git add <paths>` / `git commit -- <paths>`. Never `git add -A`. Never `git stash`.
- One worktree per PR, off `origin/main`, at `/Users/jason/unstale-ws<N>-<name>`. Never work in
  `/Users/jason/unstale` (the CEO's checkout, with uncommitted work).
- The repo is public: no business, vendor or distribution motives in code, docs, commits or PRs.
- Never read or modify auth files (`~/.codex/auth.json` and the like). Never read other repos' env files.
- Keys: use only this repo's own environment. Never print a key value.
- **Spend:** before any run that calls a paid API, estimate the cost and report it. The sprint total is capped at
  $10; past that, stop and ask. Cache every call on disk.
- Terminal copy states only what the user trades: cost with units and scope, quality as a word band plus a number.
  No internal names (step letters, eval set names) in anything a user sees.

### Review bot out of quota (from 11 November)
- cubic hit its monthly line limit and skips pushes. Rule from now on: an EM does not merge a head the bot has not
  reviewed; it exits READY and the PM dispatches a fresh reviewer first.

### Pre-merge gates
- CI green on the PR head (`rust`, `central`, `gateway`), re-queried at the moment of merge.
- Local: `cargo test` and `cargo clippy` in `local/`, `npm test`, `npm run typecheck` and `npm run check:schema` in
  `central/`, for whichever side the PR touches. Name the tree.
- Review bot (cubic) findings addressed; **zero unresolved threads, queried by GraphQL** right before merging.
  Dismissals carry a visible comment.
- `main` green after the merge. If it goes red, the queue halts.

### Verification posture
Blast radius: a user's credentials and privacy (high), then label quality and cost surprises (medium). Hold the line
on the README's five properties, each proven by a test that fails when the property is broken (show the failing
run). Everything else is ship-and-observe. Cut: the encoder, Cursor, no-key rule tuning beyond WS9's stopping rule,
OpenRouter parity, repeat eval runs.

### Who ticks acceptance criteria
- The implementing EM never ticks its own boxes; it pairs each criterion with evidence in its exit summary.
- A fresh read-only verifier is the only actor that ticks boxes. Judgment criteria go to the CEO.
- The PM reads verdicts only; it does not read code or debug.

### Concurrency and pacing
- The binding constraint is plan usage in 5-hour windows, not the machine. **At most two EMs at once;** a verifier
  may run beside them. Reports are short.
- Each acceptance criterion is its own pushed commit. Long runs cache per call and skip finished items on restart.
- The PM updates and pushes this tracker before and after each dispatch, so a resumed session reads the state here.

### Models for agents
- Implementation- and engineering-heavy work: Opus 5.5.
- Judgment, design, verification, investigation and everything else: Fable 5.2.
- Pure retrieval, or running an experiment whose judging happens elsewhere: Sonnet 5.5.

## §3 Per-chunk log (dispatch order)

### WS3: Client inference core: MERGED, VERIFIED (two residual items sent to WS10)
- PR #220 → `7be1f24`. Tests 472/472 at merge; 13 review threads, 0 unresolved (1 dismissed with comment). `main` `ci` green.
- Interface: `local/cli/src/inference/` (`Inference::new(ProviderConfig::…)`, `complete`, `complete_batch`, `classify`,
  `Deferred::line()`, `lock::try_acquire_default()`, `ledger`). The one switch is `UNSTALE_EDGE_INFERENCE=1`
  (`inference::enabled()`); WS4, WS5 and WS10 reuse it.
- Budget default 48M tokens a month, an estimate; WS4's measured first sync replaces it.
- Gotchas: cache pruning (WS4) must keep `{cache}/inference/` (ledger and lock). `cargo fmt --check` fails on `main`
  before the sprint; agents format only their own files. The eval RESULTS files are on draft PRs #212, #214, #217,
  not `main`; read them from those branches.
- One real Codex smoke call (plan-billed, about 4K tokens). No paid API calls.
- **VERIFIER: PASS WITH GAPS, 8/8 criteria.** Did not hold: (1) redirects are followed, so the key reached another
  host after a 302 (hold-the-line 1 and 2); (2) the budget fails open on a corrupt or read-only ledger;
  (3) `complete_batch` panics past 8 items; (4) hidden `unstale infer` ignores the switch; (5) ledger accounting for
  rejected answers and Jev untested. HUMAN: is 48M the right budget default. UNVERIFIABLE: Codex flags against the
  RESULTS file (not on `main`); real Codex error wording.
- **WS3-FIX: MERGED** PR #223 → `072a57a`, 487/487, 7 threads 0 unresolved (1 dismissed with comment), `main` green.
  No redirects on any adapter; https only except loopback; budget fails closed; batch over 8 defers; `infer`
  respects the switch; one switch reader `util::edge_inference()` (`1` or `true`); a bad event shard is refused but
  records still sync (`TechSync.events_failed`). Signature changes: `Deferred` +3 variants, `Ledger::record` returns
  `io::Result`.
- **WS3-FIX VERIFIER: PASS WITH GAPS**, all 8 claims held (redirects and https bypass attempts reproduced through
  the binary). Residual: (1) unchecked token addition: a provider reporting u64::MAX tokens panics a debug build
  and wraps the budget to 0 in release; (2) an unwritable events directory still fails a technology's record sync.
  Both sent to ws10-impl as separate commits. Noted, no action: any https base URL is accepted, fine while the user
  chooses it.

### WS2: Change events in the catalog: MERGED, VERIFIED WITH GAPS (live run unobserved)
- PR #221 → `f37260a`. Central 571/571, local 460 passed, gateway 73/73; `main` `ci` green. 1 review finding dismissed
  with comment.
- Shape: `EventLine` (id `{tech}@{version}{keyTag}`, chunks, freshness) and `EventChunk` (id `{event}#{n}`, sha256,
  text). Shards `v1/shards/<tech>/<line>.events.<hash>.jsonl.gz`, named in the signed index (`TechIndex.events`).
  Client caches under `<cache>/v1/events/<tech>/` only with the switch on and only for the stack; read with
  `cache::load_events(cache, tech)`.
- Size: 7.9 KB per technology-year measured offline; about 37 MB projected live beside 28 MB of records. Live
  measurement after the first ingest on this code.
- Gotchas: truncation re-splits depend on the model's answer and are not published (the client re-splits with the
  pure `splitChunk`; matters for WS4 parity). A zero onboarding budget stops a run before releases are fetched:
  budget gating needs rework at cutover (WS7). The PR touched `fetch.ts` and `service.ts`, which the CEO's checkout
  has uncommitted edits to.
- **VERIFIER: PASS WITH GAPS, 6/7** (size is offline-only). UNVERIFIABLE until an ingest runs on `f37260a`: live
  publishing and live size. HUMAN: is a 37 MB projection acceptable before a live number.
- Parity consequence for WS4: client record keys never equal central's (`#chunk.i`, `i` is the model's answer
  order), so parity is judged on metrics, and on prompts for unsplit chunks. A Rust port of `chunk(max)` and
  `splitChunk` must count UTF-16 code units, as JS does, and needs its own fixtures.
- Risks: (1) two readers of the switch disagree on `=true`; (2) with the switch on a bad event shard fails the
  technology's record sync. Both sent to WS3-FIX. (3) First live run rewrites every index and adds thousands of
  files: **PM watches the first ingest on `f37260a`.** (4) `central/events/<tech>/notes.json` keeps full text
  uncompressed in state, about 100 MB at full scale: follow-up. (5) A line's event shard is rewritten whole on each
  release: follow-up.

### WS1: Prompts as shared data: MERGED, VERIFIED WITH GAPS (PR #222 → `2cddd6e`)
- First hand-back unmerged: 2 review findings. P0: `central/Dockerfile` copies only `src/`, so `schema/prompts/` would
  be missing from the image. P2: Rust sorted answer options; central sends file order. EM revived to fix both
  (`inference::ChoiceQuestion.options` becomes an ordered `Vec`).
- Layout: `schema/prompts/{extract,labels,judge,choice,advisory-apis,thresholds}.json`, integer `version` each;
  `central/src/pipeline/prompts.ts`; `local/cli/src/prompts.rs`. Snapshot of 24 request bodies and cache keys
  committed first (`f96bb42`), unchanged after.
- Merged: central 604/604, local 516; 2 threads, 0 unresolved. The central image now builds from the repo root
  (`docker build -f central/Dockerfile .`); **the old build command no longer works: check the deploy setting**.
  `Inference::classify` takes `(&RawValue, &[(String, ChoiceQuestion)])`; the Jev state is JSON text in central's
  key order. Thresholds and the quote-guard constants are data.
- **VERIFIER: PASS WITH GAPS, 7/9.** Independently rebuilt 155 requests from both trees: all cache keys identical,
  153 bodies byte-identical (2 differ in key order in an unused extraction variant). Deploy paths in the repo all
  safe; the old Docker command fails loudly. FAILED: 9 of 13 threshold values, `version` fields and one judge text
  can change with green CI. Rust parity borrows state from central's fixture. Both sent to ws4-impl (content lock
  per data file; raw-byte request tests; Rust builds its own state).
- **HUMAN:** if an always-on central host exists, set its build context to the repo root with Dockerfile
  `central/Dockerfile`; working directory in the image moved from `/app` to `/app/central`.
- EM: impl, Opus 5.5. Starts when the first lane frees.

### WS10: Session-start sync and freshness tracking: MERGED, fix MERGED and re-reviewed (APPROVE)
- PR #226 → `7c05080` (hooks, never blocks), PR #229 → `594b078` (freshness). #229 and #226's last push had no bot
  review (quota); the verifier reviews the diff too.
- Claude Code `.claude/settings.local.json`; Codex `.codex/hooks.json` (user must trust it in `/hooks`); opencode
  `.opencode/plugins/unstale-session.js` (`session.created`; opencode adds no hook output to context). Real Codex and
  opencode never run.
- Timing: 1.42 s worst case (catalog and coverage service both hanging; deadline 1.5 s; limit 2 s).
- Requests: 1 conditional request when unchanged; `/v1/*` is static assets (no Worker); on by default.
- **Decision to confirm with the CEO:** record sync at session start runs with the switch on or off; events and
  the model stage follow the switch. Opt out: `"session_sync": false` in `.unstale/config.json`.
- WS4 plugs in at `local/cli/src/session.rs` `model_stage` and `model_work_pending`.
- Hardening A (saturating token counts) and B (event write failures never cost records) included.
- **VERIFIER: PASS WITH GAPS, 9/12.** Never-blocks holds (max 1.44 s; about 1.6 s with a hung disk read; exit 0,
  one line). Failed: installers rewrite the user's JSON, write a tracked Claude settings file, delete user hooks by
  substring, and do not escape the executable path (a path with `$(…)` executed). Also: fingerprint too broad, the
  deadline untested, a flaky test, "N new records" after a cache rebuild. 14 items sent to ws10-fix, with the
  decision to gate everything behind the switch.
- **WS10-FIX: #232 → `979e779`**, re-review APPROVE: switch-off identical to `705ba46`; installers safe; worst
  case 1.27 s under load. Leftovers for the terminal rework's rebase: upgrade leaves inert Codex/opencode hook
  files (state it); failure line not cleared by a later successful session start; stale comment on hosts (the
  stage contacts the provider when the switch is on); no status reason for an invalid hooks file. Real Codex and
  opencode still never run.

### WS5: Setup: MERGED, VERIFIED WITH GAPS, fix merged (covered by the WS6 matrix, no separate verifier)
- PR #224 → `725b8c1`, 507 tests, `main` green. Code `local/cli/src/setup/`; figures in `setup::quote()`;
  `NO_KEY_MODE=false`; goldens in `src/setup/golden/`.
- Decisions for CEO review in the playback: first sync quoted as equal to one year per technology (a ceiling, not
  measured); Ctrl-D or three invalid answers records "none"; with several OpenAI-compatible keys only the cheapest
  route is offered; user config added at `~/.config/unstale/config.json`; repo config is `.unstale/config.json`.
- Gotchas: a key found only in this repo's `.env` is not in the process environment, so WS4 must read that one
  value after consent. `unstale status` needs a coverage service. Jev alone is not an option (it labels, it cannot
  extract).
- The WS5 EM did not merge PR #219.
- **VERIFIER: PASS WITH GAPS.** Privacy held end to end (7 forbidden files never opened; no canary anywhere;
  switch-off output byte-identical to the parent build). Gaps: empty-valued names listed as usable; a dismissed
  prompt saves "none" to the shared repo config; an agent's pseudo-terminal gets the interactive prompt; no
  regression test for parent or home `.env`; whole `.env` read into memory; Codex quality claims not measured
  through Codex. All sent to WS5-FIX (`/Users/jason/unstale-ws5-fix`).
- **WS5-FIX: MERGED** PR #225 → `705ba46`, 523 tests. Blank values unset; a dismissal writes only
  `.unstale/state/setup-dismissed`; agents never get the question (`setup::AGENT_VARS`; only CLAUDECODE and AI_AGENT
  confirmed against a real tool); never-opened files tested as FIFOs; `.env` read without holding values; Codex
  quality "not measured yet" (`Quote::quality_measured`).
- **For WS4:** measure extraction quality through batched Codex (edge-cli never checked its recall); the "≈ 93% of
  breaking-change flags" figure is relative to Jev at threshold 0.05, so check which threshold the client runs;
  measure a real first sync (the quote is a placeholder equal to one year).
- **HUMAN (playback):** every option line is 231–274 characters; the Anthropic line omits its label loss; the None
  line has no number; "deterministic signals" may read as internal; cheapest-route-only when several keys exist.

### WS6a: Environment matrix harness: MERGED, VERIFIED WITH GAPS
- PR #227 → `efac640`, 531 tests, `local/cli/tests/matrix/`: 77 scenarios, 5 ignored placeholders (upgrade during
  grace, after `min_client`, budget in demand order, multi-repo cache reuse, session-start timing), about 8 s.
  Gallery `local/cli/tests/matrix/gallery.html`. Goldens: `UPDATE_GOLDEN=1 cargo test --test matrix`. Real agent
  trials are opt-in (`agent-trials.sh`), never run.
- Until WS4 lands the model step is the internal `unstale infer`; WS4 replaces `Step::Model`.
- Copy nits: "1 other candidate technologies"; a key only in `.env` can be chosen but defers until WS4 reads it.
- Agent variables: CURSOR_AGENT and GEMINI_CLI likely; CODEX_SANDBOX_NETWORK_DISABLED doubtful (reported removed
  in Codex 0.146); CODEX_SANDBOX and OPENCODE unconfirmed. WS10 should confirm Codex's and opencode's from the
  hook environment.
- The review bot is at about 98% of its monthly line limit and skipped later pushes.
- **VERIFIER: PASS WITH GAPS.** 30 product-code mutations: 19 caught by the matrix, 1 by golden diff only, 5 by
  unit tests only, 5 by nothing (HOME path, `package.json` contents or file names in a request body; reading an
  unplanted secret file; an outbound call with the proxy disabled). The matrix sets `UNSTALE_NO_REGISTRY=1`, so
  egress is asserted only without registry lookups. Anthropic and Jev are never chosen in a scenario; Codex runs in
  2. Gallery renders in headless Chromium (77 scenarios, player works).
- **WS6b must add:** body checks for any path under HOME and for repo file contents and names; rows that choose
  Anthropic, Jev and Codex; registry hosts in the allowed set with the flag off; real pipeline traffic
  (`Step::Model`); orphan goldens deleted on update; the two placeholders that can already run.

### WS9: No-key mode eval: IN PROGRESS (Fable 5.2, one agent, `/Users/jason/unstale-ws9-no-key`)
- **STOPPED at the data gate (05:02Z 11 November):** events live for 315 of the pool's 846 technologies; ingest
  covers about 95 an hour. Draft PR #231 (`9a93191`): `local/cli/src/nokey.rs`, `eval/no-key/PREREGISTRATION.md`,
  `freeze_catalog.py`. No run made; about 9.5K plan tokens used.
- Agent alone (reused, recomputed): 40 real finds, 18 act-now, 432K tokens per act-now find.
- Measured for the setup screen: 27% of a full report's real finds need no model (28% of act-now).
- PM rulings: strict pass rule (must beat, a tie within noise does not ship); run from a copy of the scout
  database; the judge through Codex on the plan is accepted (no API spend). Harness is the private
  `/Users/jason/unstale-scout`. Three work clones need re-fetching at pinned commits. Runner for the new arm not
  yet written.
- Early sign: one dry run gave about 10x the reading matter of a keyed report (241 KB events file).
- **Second stop (10:24Z 11 November):** 783 of 846 on the events code; **63 are not being rechecked by ingest at
  all** (stamps 18 October to 10 November; 26% of the pool's records; electron, pandas, astro, stripe, workerd…).
  Read-only diagnostic dispatched. Harness copy at `/Users/jason/unstale-ws9-scout`; arm build fixed at `9a93191`;
  runner `eval/no-key/arm.py` written, never executed; prepared outputs to be redone. PR #231 head `8c551cc`.

### WS4: Client pipeline steps and port parity: PR 1 and PR 2 MERGED after review; WS4b in progress
- **#228 → `5c8695f`, #230 → `fab73ab`**, re-review APPROVE (11 findings fixed and reproduced by the reviewer).
  `unstale sync` makes no model call; model work runs only in the session-start background stage.
- **Measured: 58% of index releases are named by no record**, so clients would re-derive them. Fix in WS4b PR A:
  an `extracted` mark on each change event. **Precondition for parity, cost measurement and WS7.**
- Behaviour change: `key_env` must be the route's known key variable; a team's custom name is refused (CEO asked
  whether to allow custom names from the user config only).
- **WS4b READY:** #234 `EventLine.extracted`, set by central after records are saved, backfilled without model
  calls on each job's next refresh (p50 4.7 h, p90 4 days, p99 23 days); share a client would still process on
  three real repos: 48.8% → under 1%, 40.5% → 0.6%, 9.5% → about 5%. #235 disk bounds: 100 MB cap
  (`UNSTALE_CACHE_MAX_MB`), behind the switch; real-cache copy 152 → 100 MB. Then parity runs (about $1.65).
- **#234 MERGED → `a7a5ce9`** (review APPROVE: no path marks an event ahead of or without its records). Watch the
  catalog file count after the first live cycles; count real marks before quoting the "under 1%" figure; central's
  record stores and `processed.json` must be backed up and restored together.
- **#235 review: APPROVE AFTER FIXES.** Blocking: deletes outside the cache through a symlinked top-level folder;
  a missing or corrupt `needed.json` reads as "nothing is needed". Plus 13 should-fix items sent to the EM.
- **#235 MERGED → `72d0fc5`** after three review rounds (upgrade case kept all 3,170 indexes on a real-cache copy;
  bounded 300 ms lock; `cache clean` asks after describing, keeps model results unless `--results`). Residual:
  a skipped record after 30+ days away can cost one re-download; `cache clean` plans before taking the lock.
- Hand-off: `plan()` stays catalog-only; overlay ids `{id}~{8 hex}` must stay stable; measure real marks with
  `central/scripts/extracted-share.ts https://api.unstale.sh/` after a few live cycles.
- Three timing-sensitive tests failed once on a busy machine (matrix goldens, `the_hook_never_waits…`,
  `ctrl_c_at_the_question…`): look at in WS6b.
- **PR 1 #228 and PR 2 #230 READY, not merged** (bot skipped both heads). Local 495 unit + suites, central 608.
  Records land in `{cache}/inference/records/<tech>.json`, merged by `cache::load_tech`; result cache
  `{cache}/inference/results/`; `unstale internal run-step --step extract|labels|match --in FILE.jsonl`.
  `schema/prompts-lock.json` guards the data files.
- **Parity cost estimate: about $1.65 at list prices** (extraction $0.11, labels $0.19, matching $0.31, one real
  first sync about $1.05), under the $10 cap.
- Flagged by the EM: matching without Jev uses bars fitted on stated probabilities but reads choices; not ported:
  `mergeSplitRecords`, `mergeChunkDuplicates`, npm prerequisite check, `related` back-links. Reviewer asked to rule.
- Left: disk bounds, parity runs, measured cost, matrix `Step::Model` swap, "records ready" timestamps.
- PR 1 extraction, PR 2 labels and matching: no paid calls; EM returns a parity cost estimate. Then: parity runs
  (also extraction through batched Codex, the Jev threshold behind the "93%" line, a real first sync), and cache
  disk bounds (must keep `{cache}/inference/`).

### WS6b: Full matrix run and playback gallery: IN PROGRESS (Opus 5.5, `/Users/jason/unstale-ws6b`)
- CEO copy review happens here, before WS8.

### WS8: Docs and site: NOT STARTED (after WS4, WS5, WS6b; draft, held)

### WS4 review (11 November): APPROVE AFTER FIXES, sent to ws4-impl
- Blocking: repo config could name any variable as `key_env` (reached the Codex child's environment); resume stops
  mid-release with the switch on; chat judge merged across kinds on a bare "yes" (decision: central's production
  rule). Fix now: permanent failures, lost paid answers on cache write failure, queue-stopping item failures,
  loopback-only address overrides, foreground backlog in `unstale sync`, Codex batch cache key, answer parsing.
  Measure: releases never counted as covered. Next PR: hidden records, provenance display, `mergeSplitRecords`.

### Terminal rework: MERGED after two review rounds (PR #233 → `8835d5c`)
- Picker as a table, prompt when nothing usable, agent and CI forms, warnings in place of "deferred", monthly
  token limit a user setting (a repo can only tighten it), notices and session-start lines shortened; 0 lines over
  100 characters in 86 transcripts. Session start prints one warning per new kind of failure (CEO asked to confirm).
- Not done: internal `run-step` JSON still says "deferred"; no colour on `warning:`; the matrix never runs the
  session-start hook (WS6b).
- One EM applies `terminal-principles.md` across setup, status, session start, failures, notices; gates
  session-start hooks behind the switch; makes the monthly limit a setting.

### Ingest starvation (found 11 November; predates the sprint; CEO decision pending)
- About 1,450–1,650 refreshes always due, 700–950 started per run; demand order with no aging; any technology past
  its 50,000-token quarterly cap is sorted last for the quarter (`central/src/onboarding/service.ts` `tier()` about
  line 414, `queue()` 438, oldest-due slot 808–817, 6-hour interval 1368). Sample of 300 of 4,291: checked older
  than 3 days 44%, 7 days 36%, 21 days 8%. workerd fails on a too-long state file name (`collector/store.ts:31`).
- Proposed: drop the over-cap-last rule for monitoring jobs; order due refreshes oldest first (admission stays
  demand order); fix the file name. The cutover alone does not fix it.

### Parity: RUN, 7 of 8 cells pass; fixes in progress (PR #236, spend $0.27 of the $10 sprint cap)
- Pass: extraction (both sets), labels on the labelling service (233/233, 347/347 replayed), labels by choice
  (both sets), matching on the labelling service (236/236 decisions equal). 815/815 labelling-service requests
  byte-identical.
- **Fail: matching on `gpt-6-luna` by choice**, recall 72.1% → 62.9%. Not a port difference: a choice answer
  giving the option's text instead of its key is discarded on both sides (23 of 235 unreadable).
- **Batched Codex extraction loses recall**: 53.5 against 75.6 direct; long chunks collapse in a batch.
- Measured cost per technology-year: labelling service + key $0.032–0.036; key alone $0.059–0.064; service + Codex
  $0.018 plus 152k plan tokens. The "93%" line is wrong: at the client's threshold (0.5) a key alone finds about
  as many breaking changes with more wrong flags. Duplicates without the labelling service: about 6, not 4.
- The parity agent read the gateway and labelling-service keys from the per-user key directory central's code
  names (outside the repo), only those two variables. Reported to the CEO.
- **Parity-fixes PR #237: review APPROVE** (123-case answer table identical on both sides; no path to a wrong
  "same"). Five wording notes to apply with the re-measured figures: the README row and `MATCHING_BELOW` were
  measured before text answers were read; batching-threshold comment cites numbers not in the committed files;
  the key-alone line "≈ 1 in 3 … wrong" has no comparison in the row and comes from 42 flags (larger set: 7–8 in
  100); a loosened setup unit-test assertion; characters counted as code points versus UTF-16 units (comment).

### Notes
- Briefs say "do not merge any PR other than your own".

### Program close
- `main` green on the final tip; tracker branch merged; morning report.

### Docs and site (#240) — draft open, held (11 November)

- Draft at `48b9c6d`, worktree `/Users/jason/unstale-ws8-docs`. Not verified: real Codex and opencode hooks; phone-width site.
- Product issues it found, for the product-fix PR: (1) `session-sync` with "Not now" recorded prints "another unstale is reading them"; (2) `setup` and `cache` hidden from `--help` even with the switch on (unhide at release); (3) `sync` prints an internal id (`zod-6ac59393: …`); (4) "Not now" row overstates the loss while the catalog still has records; (5) `--details` package count off (3 for a repo with 2); (6) `cache clean` without a terminal exits 1 after "Run it again with --yes".
- The ≈ 27% no-provider figure's source is on the unmerged no-key branch (#231).

### 11 November, later

- CEO: "go ahead with the ingest starvation fix". PR #241 open at `75989b8`, CI green, worktree `/Users/jason/unstale-ingest-fix`; fresh review running. Author's bound: about 26 hours for the whole catalog. Reaches production with the first ingest run after merge (no separate deploy). Overlaps the CEO's uncommitted `service.ts` region (oldest-slot block, `tier()`).
- #238 review: APPROVE AFTER FIXES. Two blockers (known-bug exemption too broad; logged paths not resolved before the allowlist), plus should-fixes; sent to the matrix EM with the rebase onto `8b2fe69` and clearance to merge. Five product bugs confirmed real: (a) status warning twice; (b) `init`/`status` silent below `min_client` (predates sprint); (c) "every release note here is read" while 2 wait, below `min_client`; (d) `UNSTALE_INFERENCE_BASE_URL` breaks the Codex route; (e) `init --wait 0` takes 26 s with registries unreachable (predates sprint).
- Next after #238 merges: one product-fix PR for (a)–(e) plus the six issues from #240's report; then update the matrix's known bugs.
- #238 merged at `8ab70ba` by the PM after re-review APPROVE at `fe437bb` (all four re-run mutations caught by their named checks; 149 scenarios). Worktree removed.
- #241 at `efd7137`: check slices make no model call; ordered by real upstream read; over-cap-before-coverage included; only check slices start under a spent budget. Re-review running.
- Ingest stalled since 11:18 UTC: Cloudflare rate limit (971) on one `wrangler deploy`, chain broken, production healthy. Restart (`gh workflow run ingest.yml --ref main -f reason=continue`) and a deploy retry await the CEO.
- Product-fix PR dispatched (Opus): matrix bugs (a)–(e) and the docs work's six.
- #241 re-review APPROVE at `efd7137`; test-only follow-up `f0e57a1`. Held for the CEO: over-cap technologies in `monitoring` with complete history get no model work (docs notes, guides, advisory judging) until the quarter ends or a new release requeues them; the count is not available from public data. PM recommends merging as is.
- #242 (product fixes) merged at `0de79cb` by the PM after review (APPROVE AFTER FIXES at `1f7c5a0`, APPROVE at `9f36c69`). PM decision: a client refused as too old reads nothing. Matrix known-bugs list is empty. Not fixed: 26 s `init` with registries unreachable (retry pauses in `onboarding.rs`, the CEO's file); `setup`, `cache`, `init --inference` stay hidden until release (`hide = true` in `local/cli/src/main.rs`).
- Copy for the CEO: "N wait until the catalog serves this unstale" (reviewer suggests "N wait for the upgrade" after a too-old refusal); the 27% scoped to new releases is an inference from the no-key measurement (42 of 154 finds with records removed), source still on #231.
- Docs draft #240 being updated to the merged wording (stays draft).
- CEO: "merge 241. deferr deploye retry to you - i have no uncomitted work i care about any longer". #241 merged at `a33ec49` by the PM; worktree removed. Deploy-retry PR dispatched (Opus). The CEO's uncommitted work in `/Users/jason/unstale` no longer constrains which files agents change in their own worktrees (still never edit that checkout).
- Ingest restarted by schedule at 17:17 UTC on `0de79cb` (before the fix). Next: verify the first run on `a33ec49` (freshness falling, no token rise from check slices, no `ENAMETOOLONG`), then resume the no-key evaluation (#231).
- Docs draft #240 updated to `cecce32` (matches `0de79cb`), still held.
- #243 (deploy retry: 3 attempts, 300 s timeout each, stated wait floored at 5 s and capped at 120 s) merged at `276a23d` by the PM after APPROVE at `d5385f9` and at `cfe3115`. Left open, not blocking: test for "first match" wait and a time assertion on the hang case; exit 137 after the hard kill prints no "timed out" warning. Not established: that a retry clears Cloudflare's throttle in production.
- Ingest run 43066638798 (schedule, 17:17 UTC) is on `8ab70ba`, before the starvation fix. Watch `bqxb7pi9r` waits for the first run started after 17:30 UTC; then dispatch a verifier for the fix in production, then resume the no-key evaluation (#231).
- Open PRs now: #240 (docs and site, draft, held for the CEO), #231 (no-key evaluation draft).

### Ingest starvation fix in production (11 November, late)

- Verifier on run 43089905914 (first with `276a23d`): PASS WITH GAPS, 8 of 10. Healthy, spend flat ($0.12), deploys first time; but max release-check age only 17.48 → 16.84 days, p95 about 11.3 days, and much of the gain is the five-hour outage. File-name and spent-budget criteria unverifiable.
- Investigator: the kept slot does take the oldest, but finishes about 35 a run (a pass in four to five days). Causes: the 6-hour interval needs about 7,600 starts a day for the most-requested 1,900 against 6,000–7,000 delivered, and 48% of those refreshes read only the 12-hour cache; one npm 429 pauses all six slots about ten minutes (slices settled in 59 of 127 drain minutes); the kept slot runs full slices one at a time. Tail over 3 days: 950 healthy monitoring technologies, all due. About 800 queued admitted history jobs also untouched over 11 days, outside the statistic.
- Options for the CEO (admission order untouched by all): (1) `REFRESH_MS` 6 h → 24 h; (2) oldest-first holds several slots; (3) cache npm organisation and maintainer listings so one 429 does not pause everything; (4) set the `INGEST_GITHUB_TOKEN` repository secret (1,000 → 5,000 requests an hour; CEO only) and treat a GitHub 403 rate limit as one.
- Dispatched without waiting: logging-only PR (counts over 24 h and 3 days, kept-slot summary, yield lines, `rate_pause` event, attribution for the "unknown" advisory call). Watch `bnvs4es32` on run 43108470126.
- No-key evaluation (#231) stays blocked until the tail clears.
- #244 (ingest freshness logging; no scheduling change) merged at `3642f49` by the PM after APPROVE AFTER FIXES at `03b22c9` and APPROVE at `62c480f`. New fields: `release_checks_over_24h`, `release_checks_over_3d`, `unimprovable`, `release_check_age_s_checkable`, `metrics.kept_slot` (`due_*`, `overdue_*`, `oldest_overdue_age_s_*`), events `slice_yielded` and `rate_pause`, stage `advisory_apis`. First ingest run on `3642f49` or later will carry them.
- Waiting on the CEO: remedy for the slow tail (PM recommends `REFRESH_MS` 24 h plus caching npm listings) and the `INGEST_GITHUB_TOKEN` secret.
- CEO (12 November): "C &  12 hours", and will set the `INGEST_GITHUB_TOKEN` secret himself. He rejected 24 hours: "part of the value premise of Unstale is that it gives very fresh context". Dispatched one PR (Opus, worktree `/Users/jason/unstale-ingest-throughput`): refresh interval 6 → 12 hours, day-long cache for npm organisation, maintainer and sibling listings, GitHub 403 rate limits treated as rate limits. Second fixed run 43108470126: checks over 6 h 2,069 → 1,574, median 18.4 h → 6.4 h, p95 11.3 → 9.8 days, max still about 17 days. Run 43127192061 is the first with the new logging (watch `blfj1982y`).
- #246 (refresh interval 12 h; day-long npm listing cache with 24–30 h staggered expiry; GitHub 403 rate limits; all server waits capped at 60 min; advisory re-read on a registry-detected refresh; `release_checks_over_12h`) merged at `5b7c36b` by the PM after APPROVE AFTER FIXES at `39378fe` and APPROVE at `a7d9e02`. Capacity is at best break-even: if `release_checks_over_24h` rises day over day, next step is more oldest-first slots.
- `INGEST_GITHUB_TOKEN` set by the CEO at 01:49 UTC 12 November (fine-grained, public read-only by his account; permissions cannot be checked from here). First run to use it: 43130458934 (pending, sha `3642f49`; watch `b9eipsvvt`): confirm the workflow-token warning is gone and no wave of 401/403.
- Runs to verify, in order: 43127192061 (first with #244 logging), 43130458934 (first with the token), then the first on `5b7c36b` (throughput).
- Docs draft #240 at `53fee97`: README trimmed 202 → 143 lines, figures audited, new `docs/reading-release-notes.md` and `docs/privacy.md`; awaiting the CEO's re-review. No measured "naive costs N times more" ratio exists for reading release notes; the arm that would measure it has never run.
- Left for the CEO: about 1 GB of synthetic benchmark data in the session scratch folder `ingest-throughput/bench/` (an agent's delete was blocked; PM did not delete it for the agent).

### Pre-release improvement lanes (12 November)

- CEO: copy moves from dollars to tokens per technology with a comparison that shows how little it is (docs agent on draft #240). Then five distinct Fable lanes on the pattern of `.github/agents/*.md`, without the single-task limit or the log, up to 5 highest-return items each, PRs mergeable by the PM after fresh review: (1) performance and efficiency, (2) throughput, (3) cost at the edge, (4) developer experience against the vault's design principles, (5) security, privacy and prompt poisoning.
- Method: phase 1, each lane investigates and returns up to five ranked candidates with evidence; the PM removes overlaps and approves; phase 2, one PR per item in worktrees `/Users/jason/unstale-lane-<lane>-<n>`, fresh reviewer per lane, PM merges. Paid spend caps: cost lane $2.50, performance and throughput $1.50 each, others none.
- Ingest: queued run 43130458934 was cancelled as a duplicate; run 43144432657 (02:53 UTC, `5b7c36b`) is the first with the CEO's GitHub token and #246 (watch `baxwt0yfz`). Run 43127192061 (logging only): checks over 24 h 1,002 → 890, over 3 d 770 → 643, checkable max 11.2 → 9.6 days; 11 npm 429 pauses totalling about 81 minutes; 46 of 49 yields were model-free checks.
- CEO: lanes must not chase nits; "ruthlessly focus on ROI… acceptable if nothing is found" (sent to all five). CEO then: "pause 3 of the lanes - might need to pace usage". PAUSED mid-investigation (resumable with their context; restate the no-nits bar on resume, the performance lane may not have read it): performance and efficiency, throughput, developer experience. RUNNING: security and privacy; cost at the edge. Resume the three only on the CEO's word.
- Docs draft #240 at `6a935a4`: cost in tokens per package ("about 470,000 small-model tokens a year, about 1,300 a day", beside Claude Code's 409,000 for one review). CEO's "1,000 dependencies = one context window" does not hold (one 200K window every 3.7 hours). Hold the headline until the cost lane reports.
- Cost lane phase 1: two candidates approved by the PM, nothing else: (1) same-or-new decided by rule where the answer cannot change the outcome (free replay: 145/197 merges against 141, no false merges; saves about 143k tokens per package per year on a key); (2) several records per label call on a key (saves about 140k; paid run estimate $0.05, cap $0.15). Key alone would go from about 383k to about 95–100k. Published 425k for key alone still includes retries fixed in #237. Do not change route order in setup: CEO decision once totals are measured.
- Usage limit hit; both running lanes failed mid-work and were resumed on the CEO's "continue" (cost lane: phase 2 from its worktrees `/Users/jason/unstale-lane-cost-*`; security lane: phase 1). CEO: "DX lane can drop down to Opus": when the three paused lanes resume (after cost and security close out), start the developer-experience lane as a fresh Opus session with the same brief and the no-nits bar; performance and throughput resume as Fable.
- Security lane phase 1: ONE RELEASE BLOCKER (the switch must not go on with it open): a repository's committed `.unstale/config.json` can name an unsigned catalog directory; what it plants lands in the shared per-user cache and, with the switch on, in `inference/records`, and is overlaid into the user's other repositories' reviews (demonstrated locally). Second finding: a tracked repository config overrides the user's own "none" and spends their key. Approved by the PM, three PRs: (1) directory catalogs only when the user approved them, plus no overlay of records from unsigned sources into signed-catalog repositories; (2) the user's own choice always wins, and (PM decision, for the CEO to confirm) a tracked team choice with no user choice is a preselected default that asks once and never spends by itself; (3) central address filter lets IPv4-mapped IPv6 literals through. Promises in the docs not literally true: "discards anything that does not verify" (directory catalogs), what `init` writes and what the hook does with the switch on, and release-note text going to the provider missing from "what leaves your machine": to be corrected on draft #240.
- CEO decisions (12 November): (a) picker prompts: "Enter for <n>" reads confusing; he AGREED to the PM's proposal: default marked in the list itself (selected row carries the marker), arrow keys move, Enter chooses, numbers still work, `d` for details; agents and CI unchanged. Owner-directed item for the developer-experience lane (fresh Opus session), one PR across all prompts after #250 merges; the lane should also run PostHog's current terminal onboarding, which he enjoyed, and report what it does well. (b) Copy goes back to dollars for key routes (dated, "about", with why it is small); for Codex no dollars and no headline token count: nothing extra to pay, draws on the plan, shown in `status`, stops at the limit the user sets; no claim about a share of a plan. One docs pass on draft #240 after the cost and security PRs merge, with the security lane's three doc corrections. (c) The evals' gateway key may be used for the cost lane's paid run, through the harness only.
- #248 review: rule alone makes about 3–4 false merges per 100 on the full store (102 technologies); one revision allowed (model as veto on nominated candidates; three deterministic refusals; must pass on the whole store), else close. Honest key-alone base is 345k. Security PRs #247, #250, #251 open, CI green, one reviewer running.
- Security review: #247 (release blocker: catalog directories only when the user chose them, cached apart) APPROVE, merged `0ac9fa6`; #251 (address filter) APPROVE, merged `0f91ff9`. #250 (committed provider choice is a suggestion) APPROVE AFTER FIXES: the Git "tracked" test fails open (symlinked or differently-cased `.unstale`, submodule, no git, not a repository all still spent the key). PM decision: consent to spend is recorded only in the user's own config; nothing under a repository ever grants it. Also going into the fix round: committed "none" stays silent; show the suggestion when nothing is usable; user config must never resolve inside the repository when HOME is unset; `cache clean` covers `unsigned/`; empty `UNSTALE_CATALOG_KEY` means not set. Known limits left: development builds with no compiled key; answers keyed by path.
- Adoption gate (central admission, `central/src/pipeline/admission.ts`): release within 365 days and 1,000 downloads a week (npm, PyPI) or 10,000 in 90 days (cargo) or 100 stars; stated purpose is cost; fails open on unreadable signals; still stands at the edge because the client reads only what the signed catalog names.
- #250 merged at `d0fa368` by the PM after APPROVE at `391349b` (every reproduced bypass closed: zero provider requests and zero `codex exec`). SECURITY LANE CLOSED: #247, #251, #250 merged. Consent to spend lives only in the user's config. Behaviour change: a choice held only in a repository's config (every pre-change `unstale setup`) is now a suggestion, asked once at a terminal, pending for agents and CI; CI needs `--inference` or a user config. Residual, for the CEO before the switch goes on: `setup --inference` records consent with no check that a person is present (an agent told to by repository content could run it; not reproduced); answers keyed by path; development builds without a compiled key verify nothing over HTTP. Docs corrections for draft #240 supplied by the lane.
- Owed to the developer-experience lane: the approved prompt convention across all prompts; wording for users who chose before #250 ("you have not chosen a provider").

### RESUME NOTE — usage limit reached (12 November)

- `main` green at `d0fa368`. Security lane closed (#247, #251, #250 merged).
- Cost lane: #248 (same-or-new by rule) CLOSED, failed its one revision (133/197 against 141 on held-out); uncommitted revision code sits in `/Users/jason/unstale-lane-cost-1` (keep or discard: CEO). #249 (four records per label call on an OpenAI-compatible key; key alone 345k → 213–222k tokens per package per year; labels $0.026 → $0.014) open at `0853d6e`, CI green, fresh review RUNNING (agent "Review batched labels PR #249"); on APPROVE: check threads and CI, squash-merge with `--admin`, delete branch, remove `/Users/jason/unstale-lane-cost-2`; then the cost lane is closed. Sprint paid spend about $0.41 of $10.
- THEN resume the three paused lanes (restate the no-nits, reproduced-only bar): performance and efficiency (Fable), throughput (Fable), developer experience (fresh OPUS session). The developer-experience lane also owes: the approved prompt convention (default marked on its row, arrows move, Enter chooses, numbers still work, `d` for details) across all prompts; a look at PostHog's terminal onboarding; wording for users who chose before #250; assess a token- or dollar-denominated picker (CEO went back to dollars for keys).
- ONE docs pass on draft #240 (held for the CEO, never merged by agents): dollars for key routes (dated, "about", why it is small), Codex as "nothing extra to pay, draws on your plan, stops at your limit", the security lane's three corrections, new figures after #249, corrected totals (about 429k default route, not 470k).
- Ingest: watch `b6c1qlb2b` on run 43160475568, the test of the npm cache (previous run: 11 npm pauses, 68 minutes; checks over 3 days 627 → 480). If pauses stay high, hand to the throughput lane.
- Still open with the CEO: simpler flag-only form for catalog folders; no-key evaluation (#231) blocked on the tail; real Codex and opencode never run; first-sync cost unmeasured; count of releases marked as read; 1 GB of benchmark data in the scratch folder `ingest-throughput/bench/`.
- Resumed after the limit reset: #249 review continued (same agent). Ingest run 43160475568 (second with the npm cache): tail clearing fast (checks over 3 days 451 → 233, over 24 h 701 → 497, over 12 h 811 → 629; checkable p95 3.6 days, max 5.2 days) but npm pauses UNCHANGED: 10 pauses, 73 minutes, all `registry.npmjs.org` 429 (68 and 81 minutes in the two runs before). The listing cache did not remove what triggers them: first item for the throughput lane when it resumes (which npm requests draw the 429s now; the new `rate_pause` and "sibling packages unavailable" lines are in `scratchpad/run-43160475568.log`).

## Update, 12 November 2026 (evening)

- Merged: #253 `744a135` (docs pass stops once a site over the page budget is covered), #249 `af79f52` (batched labels; labels on a key $0.013–$0.015 per package per year, key route about $0.05), #254 `90939c4` (`init` no longer waits 25 s when no registry answers). Each had a fresh reviewer, green CI, zero unresolved threads.
- The CEO merged #240 himself (`ac731c4`) with the token-headline copy. The dollars pass is draft #252 (head `e0008bb`), held for the CEO: about $0.05 a year per package on a key; Codex plan with no dollars and no token count; three security corrections; site example `≈ $1.98`.
- Lanes: cost closed, performance closed, security closed, throughput has #253 merged (watch `metrics.docs_rotation` and the listing-cache refill on 13 November, 03:00–15:00 UTC), developer experience building two PRs (picker with default marked on its row; status warnings first, Snap note and `subq+` help, two wording fixes).
- PM decisions: accepted #254's trade (a round with no response from any host ends retries; recovered next run). Not approved: restart ingest after a failed run. Codex picker rows show "no extra cost", never a token count.
- Open with the CEO: `setup --inference` records consent with no check a person is present; `setup` must be made visible in `--help` at release; the 27% no-provider figure rests on unmerged #231; `/Users/jason/unstale-lane-cost-1` holds 6 MB of paid answer caches.

## Update, 12 November 2026 (late)

- Merged: #255 `ca53ef5` (status warnings first, Snap note, `subq+` in help, wording), #256 `6b825f7` (arrow-key picker, default marked on its row; review found and fixed typed-ahead input choosing the default, and terminal state after an external signal).
- All five lanes closed. Draft #252 (head `1f185d4`) carries dollars copy, Codex wording, security corrections and the new picker example; held for the CEO.
- Left before the release: CEO review of #252; CEO decision on `setup --inference` recording consent with no person present; make `setup` visible in `--help` at release; merge this tracker branch and write the final report.

## Update, 12 November 2026 (night)

- Merged: #252 `85d5498` (dollars copy, CEO approved), #259 `ef27b82` (opencode `/unstale-review` command file; typed picker fallback numbered), #257 `fc33e9f` (choice or limit raise made with no person present is marked, announced once at a terminal, held at a tenth of min(limit, default); refused in install scripts and Git hooks), #262 `f0364a7` (`infer` and `run-step --provider` need `UNSTALE_DEV_INFER=1`), #261 `3ffbd01` (Codex per-call settings; quote 750k plan tokens per package per year, measured), #260 `ab9ab93` (opencode 2.x session plugin; acts only on its own directory).
- First real runs: Codex plan route works end to end; opencode review works. Live catalog leaves the client nothing to read until central stops reading release notes at cutover.
- Codex findings: identical runs agree on 79% of labels (19 records, one package), same-or-new 100%. Dropped-tools arm failed its rule and is out (patch in scratchpad `b-runs/with-catalog.patch`). Label quality through Codex against a reference set is unmeasured.
- Agent pick-up evaluation (24 runs, Claude Code and Codex): named, recommended or conditional 14 of 16; need-only, mentioned 0 of 8. Draft #258 carries the copy changes; held for the CEO, not before the release.
- Open: two e2e tests fail on main with the switch forced on (diagnosis running); CEO to claim `unstale` on npm; `setup` visible in `--help` at release; #231 no-key evaluation; merge this branch and final report.
