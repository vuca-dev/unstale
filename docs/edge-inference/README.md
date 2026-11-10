# Edge inference: sprint design

The model steps of the pipeline move from central to the client. Central keeps only deterministic work: collect, normalise,
chunk, sign and publish. Extraction (A+B), record labels (D) and the same-or-new judge (E) run on the user's machine,
on a provider the user picks: their own API key, or their Codex plan.

## Shape: independent PRs to `main`, ordered

Every chunk is additive until WS7. During the grace period the catalog carries both the records it has today and the new
change events, so a client of either version stays correct. Only WS7 removes anything (central's model steps, new
records for old clients), and it runs last, after the client that replaces them has shipped.

## Workstreams (dispatch order)

| WS | Name | Depends on | EM type |
|---|---|---|---|
| 0 | Catalog notice and update line | none | **done**: #213 (`673c191`) |
| 1 | [Prompts as shared data](workstream-01-shared-prompts.md) | none | impl |
| 2 | [Change events in the catalog](workstream-02-change-events.md) | none | investigation, then impl |
| 3 | [Client inference core](workstream-03-inference-core.md) | none | impl |
| 4 | [Client pipeline steps and port parity](workstream-04-client-pipeline.md) | 1, 2, 3 | impl (largest) |
| 5 | [Setup: detection, picker, config](workstream-05-setup.md) | 3 | impl |
| 6 | [Environment matrix and playback](workstream-06-environment-matrix.md) | harness: 3; full run: 4, 5 | impl, then runner |
| 7 | [Release, grace period, cutover](workstream-07-cutover.md) | 1–6 | ops + small PRs |
| 8 | [Docs and site](workstream-08-docs.md) | 5 | impl; **held for CEO review, never admin-merged** |
| 9 | [No-key mode eval](workstream-09-no-key-eval.md) | 2 (events), 4 (report path) | one eval agent, bounded |

Parallel lanes: WS1, WS2 and WS3 start together. WS5 and the WS6 harness start once WS3 merges. WS4 waits for 1, 2
and 3.

## Resolved decisions (10 November 2026)

| Decision | Result | Evidence |
|---|---|---|
| Where the model steps run on the client | **Rust**, in the client. TypeScript's advantages (MDX and HTML parsing, Playwright) belong to collection, which stays central | central calls models over plain HTTP (`central/src/pipeline/llm.ts`), not an SDK |
| Codex as a provider | **Yes**: `codex exec` headless with `gpt-6-luna` pinned, lean flags, batch 8 | `eval/edge-cli/RESULTS.md` |
| Cursor CLI as a provider | **No**: the plan serves no cheap model; 39–84× the direct cost | `eval/edge-cli/RESULTS.md` |
| Local encoder | **Experimental, not shipped**: fails stages 4 and 5 on precision; 299 MB lossless | `eval/edge-encoder/RESULTS.md` |
| Extraction (A+B) model | `gpt-6-luna`, reasoning low, two calls, on any OpenAI-compatible route or Codex | `eval/provider-matrix/RESULTS.md` |
| Labels (D) without Jev | `gpt-6-luna`, read on its choices; **allowed as a fallback, marked below Jev** on breaking recall | `eval/provider-matrix/RESULTS.md` addendum 1 |
| Matching (E) without Jev | `gpt-6-luna` at its fitted constants; **allowed**: same false-merge rate, about 2 more duplicate records (about 420 tokens) per technology-year, which the reading agent absorbs | `eval/provider-matrix/RESULTS.md` addendum 2 |
| Key detection | Names only: environment variable names, CLIs on PATH, `codex login status`. Never values before consent; never other repos' `.env` files; never other tools' auth files | — |
| Consent | One picker, recommended option preselected; Enter accepts. No "what was checked" line | — |
| Cost quotes | Always with units and scope: per technology-year, this repo's total, first sync once. Plan-billed tools in tokens plus "≈ $X at API prices" | — |
| Budget | A monthly token budget that throttles and works in demand order; never fails | — |
| Team setting | The repo config names the provider and the key's environment variable; the value stays in each person's env | — |
| Grace period | 20 days, then `min_client` is raised | — |
| No key and no Codex | Pass deterministic signals and the raw change events (unparsed, sometimes duplicated) to the agent, with one line stating the extra token spend. **Shipped only if WS9 shows the agent with this mode beats the agent alone**; otherwise the client says a key or Codex is needed. Encoder deferred | WS9; `eval/edge-encoder/RESULTS.md` |
| Anthropic key only | Offered last, with its trade stated (extraction misses more changes in upgrade guides; matching off, so more duplicates) | `eval/provider-matrix/RESULTS.md` |
| Picker order | Jev + OpenAI-compatible key; Jev + Codex; OpenAI-compatible key alone; Codex alone; Anthropic key alone. Options below Jev say so in one line | — |
| Day 0 / day 20 | Day 0 is the day the release ships; day 20 follows automatically | — |

## Open decisions (CEO)

None. Closed 10 November 2026.

## Human-in-the-loop items

- **Release authority:** cutting the release (version bump plus tag, which publishes to npm and Homebrew) and the
  day-20 cutover are outward-facing; the CEO authorises each, or authorises them in advance.
- **Telling current users on day 0:** the CEO, directly.
- **Codex login:** if it lapses, the CEO runs `codex login`.
- **Not needed:** an OpenAI key (the gateway runs the same OpenAI-compatible code path with the same model, and the
  mock server covers the protocol), an OpenRouter key (same protocol; parity is a later check).

## Verification posture

**Blast radius:** a user's credentials and privacy (high), then label quality and cost surprises (medium). Model
errors are recoverable; leaked keys are not.

**Hold the line on exactly these, proven by tests that fail when the property breaks:**
1. No key value, or canary planted in the user's environment, appears in any request, log, config or cache. The only
   exception is the chosen provider's auth header. No unconsented reads of other repos' `.env` files or auth files.
2. **Egress:** only the catalog host and the chosen provider are contacted. Requests carry only public release-note
   text: no repo code, no paths.
3. **Port parity:** the client's steps reproduce central's H1 and H2 numbers for the same model within run-to-run noise.
4. **Never fails on cost or provider errors:** budget exhaustion, 401, 429, timeouts, Codex logged out or a model not
   on the plan each defer work with one line, never an error exit.

**Everything else is ship-and-observe.** Explicitly cut: the encoder; Cursor; open-ended rule tuning for no-key mode (WS9 has a stopping rule); OpenRouter parity (it follows the gateway
row until a check runs); repeat runs of the evals.

## Durability and pacing

Work runs on a plan with 5-hour usage windows, and plan usage cannot be read from inside a session. A session may stop
at a limit and resume when usage returns, so every piece of work must survive an interruption with minimal loss:

- **The tracker is the state.** Each EM updates its row in `tracker.md` (status, branch, PR, next step) before and
  after each unit of work, so a resumed session reads where things stand instead of reconstructing it.
- **Small commits, pushed often.** Each acceptance criterion lands as its own commit on the workstream branch and is
  pushed; nothing is held only in a working tree.
- **Long runs are resumable.** Evals and matrix runs cache each call's result on disk and skip completed items on
  restart (as `eval/select` already does).
- **Pacing:** at most two EMs at once, with lean reports; the parallel lanes run in that limit.
