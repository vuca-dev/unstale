# Edge inference: execution tracker

> Single source of truth for the sprint. The PM is the only writer; EMs and verifiers report in their exit
> summaries and the PM transcribes. Verify §1 against reality before acting on it.
> Lives on branch `sprint/edge-tracker` in `/Users/jason/unstale-edge-sprint` (pushed after every update; merged at
> program close).

## §1 Active state

- **Shape:** INDEPENDENT PRs to `main`. Every chunk is additive and behind one switch (README, "One switch").
- **Ground truth:** GitHub PR state. Repo `vuca-dev/unstale`.
- **Base:** `origin/main` @ `3a0a472` (10 November 2026)
- **Base health:** PR checks are `rust`, `central`, `gateway`; re-query before every merge.
- **Open PRs:** #218 (design docs)
- **Live worktrees (sprint):** `/Users/jason/unstale-edge-sprint` (tracker)
- **Live subagents:** none
- **Merged + verified:** WS0 → #213 `673c191`
- **Next:** WS3 and WS2 (two lanes), then WS1
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

### WS3: Client inference core: NOT STARTED
- EM: impl, Opus 5.5. Worktree `/Users/jason/unstale-ws3-inference-core`.

### WS2: Change events in the catalog: NOT STARTED
- EM: investigation then impl in one agent, Opus 5.5. Worktree `/Users/jason/unstale-ws2-change-events`.

### WS1: Prompts as shared data: NOT STARTED
- EM: impl, Opus 5.5. Starts when the first lane frees.

### WS10a: Session-start hook install (Claude Code, Codex, opencode check): NOT STARTED
- No dependency. Sync and freshness tracking (WS10b) wait for WS2 and WS3.

### WS5: Setup: NOT STARTED (after WS3)

### WS6a: Environment matrix harness: NOT STARTED (after WS3)

### WS9: No-key mode eval: NOT STARTED (after WS2; one agent; Fable 5.2 judges, runs resumable)

### WS4: Client pipeline steps and port parity: NOT STARTED (after WS1, WS2, WS3; sub-PRs)

### WS10b: Session-start sync and freshness tracking: NOT STARTED (after WS2, WS3)

### WS6b: Full matrix run and playback gallery: NOT STARTED (after WS4, WS5, WS10)
- CEO copy review happens here, before WS8.

### WS8: Docs and site: NOT STARTED (after WS4, WS5, WS6b; draft, held)

### Program close
- `main` green on the final tip; tracker branch merged; morning report.
