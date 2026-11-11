# Edge inference: execution tracker

> Single source of truth for the sprint. The PM is the only writer; EMs and verifiers report in their exit
> summaries and the PM transcribes. Verify §1 against reality before acting on it.
> Lives on branch `sprint/edge-tracker` in `/Users/jason/unstale-edge-sprint` (pushed after every update; merged at
> program close).

## §1 Active state

- **Shape:** INDEPENDENT PRs to `main`. Every chunk is additive and behind one switch (README, "One switch").
- **Ground truth:** GitHub PR state. Repo `vuca-dev/unstale`.
- **Base:** `origin/main` @ `072a57a` (`ci` green)
- **Base health:** PR checks are `rust`, `central`, `gateway`; re-query before every merge.
- **Open PRs:** #222 (WS1, fixing 2 review findings), #224 (WS5, in review)
- **Live worktrees (sprint):** `/Users/jason/unstale-edge-sprint` (tracker)
- **Live subagents:** ws1-impl, ws5-impl, ws10-impl (Opus 5.5). Background watch for the first ingest created after 2026-11-11T00:48Z.
- **Merged + verified:** WS0 → #213 `673c191`
- **Next:** WS4 when WS1 merges (critical path); WS9 once a live ingest has published events; WS6a after WS5
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

### WS1: Prompts as shared data: IN PROGRESS (PR #222)
- First hand-back unmerged: 2 review findings. P0: `central/Dockerfile` copies only `src/`, so `schema/prompts/` would
  be missing from the image. P2: Rust sorted answer options; central sends file order. EM revived to fix both
  (`inference::ChoiceQuestion.options` becomes an ordered `Vec`).
- Layout: `schema/prompts/{extract,labels,judge,choice,advisory-apis,thresholds}.json`, integer `version` each;
  `central/src/pipeline/prompts.ts`; `local/cli/src/prompts.rs`. Snapshot of 24 request bodies and cache keys
  committed first (`f96bb42`), unchanged after.
- EM: impl, Opus 5.5. Starts when the first lane frees.

### WS10: Session-start sync and freshness tracking: IN PROGRESS (Opus 5.5, `/Users/jason/unstale-ws10-session-sync`)
- Dispatched whole (WS2 and WS3 are in). May split into two PRs. Leaves one marked place for WS4's pipeline.

### WS5: Setup: IN PROGRESS (PR #224, Opus 5.5, `/Users/jason/unstale-ws5-setup`)

### WS6a: Environment matrix harness: NOT STARTED (after WS3)

### WS9: No-key mode eval: NOT STARTED (after WS2; one agent; Fable 5.2 judges, runs resumable)

### WS4: Client pipeline steps and port parity: NOT STARTED (after WS1, WS2, WS3; sub-PRs)

### WS6b: Full matrix run and playback gallery: NOT STARTED (after WS4, WS5, WS10)
- CEO copy review happens here, before WS8.

### WS8: Docs and site: NOT STARTED (after WS4, WS5, WS6b; draft, held)

### Notes
- PR #219 (docs page cache, branch `agent/performance/...`) was merged under the CEO's account at 00:52Z on
  11 November, between sprint merges. No PM brief asked for it; origin unconfirmed. Briefs now say "do not merge any
  PR other than your own".

### Program close
- `main` green on the final tip; tracker branch merged; morning report.
