# Edge inference: execution tracker

> Single source of truth for the sprint. The PM is the only writer; EMs and verifiers report in their exit
> summaries and the PM transcribes. Verify §1 against reality before acting on it.
> Lives on branch `sprint/edge-tracker` in `/Users/jason/unstale-edge-sprint` (pushed after every update; merged at
> program close).

## §1 Active state

- **Shape:** INDEPENDENT PRs to `main`. Every chunk is additive and behind one switch (README, "One switch").
- **Ground truth:** GitHub PR state. Repo `vuca-dev/unstale`.
- **Base:** `origin/main` @ `72d0fc5` (`ci` green)
- **Base health:** PR checks are `rust`, `central`, `gateway`; re-query before every merge.
- **Open PRs:** #237 (parity fixes, APPROVED at `1494730`, EM merging), #236 (parity results; re-measurement in progress), #238 (WS6b full matrix, in progress), #231 (WS9 draft, blocked on the ingest decision)
- **Live worktrees (sprint):** `/Users/jason/unstale-edge-sprint` (tracker)
- **Live subagents:** parity-fixes EM (merging #237), parity agent (re-measuring two cells, `/Users/jason/unstale-parity-remeasure`), ws6b-matrix (Opus 5.5). All resumed after the third limit reset.
- **Merged + verified:** WS0 → #213 `673c191`
- **Next:** review parity and WS6b; CEO decision on the ingest starvation fix (unblocks WS9); WS8 draft last
- **Sprint API spend so far:** $0 of $10

## §2 CEO directives (durable; read every iteration)

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
