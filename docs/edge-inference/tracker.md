# Edge inference: execution tracker

> Single source of truth for the sprint. The PM is the only writer; EMs and verifiers report in their exit
> summaries and the PM transcribes. Verify §1 against reality before acting on it.
> Lives on branch `sprint/edge-tracker` in `/Users/jason/unstale-edge-sprint` (pushed after every update; merged at
> program close).

## §1 Active state

- **Shape:** INDEPENDENT PRs to `main`. Every chunk is additive and behind one switch (README, "One switch").
- **Ground truth:** GitHub PR state. Repo `vuca-dev/unstale`.
- **Base:** `origin/main` @ `efac640` (`ci` green)
- **Base health:** PR checks are `rust`, `central`, `gateway`; re-query before every merge.
- **Open PRs:** #226 (WS10), #228 (WS4 PR 1)
- **Live worktrees (sprint):** `/Users/jason/unstale-edge-sprint` (tracker)
- **Live subagents:** ws4-impl, ws10-impl (Opus 5.5); ws6-verifier (Fable 5.2). Background watch for the first ingest created after 2026-11-11T00:48Z (run 42940631609 on `725b8c1` in progress since 01:40Z).
- **Merged + verified:** WS0 → #213 `673c191`
- **Next:** WS9 once a live ingest has published events and a lane is free; WS4 parity and disk bounds after WS4 PR 2
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

### WS10: Session-start sync and freshness tracking: IN PROGRESS (Opus 5.5, `/Users/jason/unstale-ws10-session-sync`)
- Dispatched whole (WS2 and WS3 are in). May split into two PRs. Leaves one marked place for WS4's pipeline.

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

### WS6a: Environment matrix harness: MERGED, verifier running
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

### WS9: No-key mode eval: NOT STARTED (after WS2; one agent; Fable 5.2 judges, runs resumable)

### WS4: Client pipeline steps and port parity: IN PROGRESS (Opus 5.5, `/Users/jason/unstale-ws4-pipeline`)
- PR 1 extraction, PR 2 labels and matching: no paid calls; EM returns a parity cost estimate. Then: parity runs
  (also extraction through batched Codex, the Jev threshold behind the "93%" line, a real first sync), and cache
  disk bounds (must keep `{cache}/inference/`).

### WS6b: Full matrix run and playback gallery: NOT STARTED (after WS4, WS5, WS10)
- CEO copy review happens here, before WS8.

### WS8: Docs and site: NOT STARTED (after WS4, WS5, WS6b; draft, held)

### Notes
- PR #219 (docs page cache, branch `agent/performance/...`) was merged under the CEO's account at 00:52Z on
  11 November, between sprint merges. No PM brief asked for it; origin unconfirmed. Briefs now say "do not merge any
  PR other than your own".

### Program close
- `main` green on the final tip; tracker branch merged; morning report.
