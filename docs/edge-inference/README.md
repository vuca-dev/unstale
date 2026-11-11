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
| 7 | [Release, grace period, cutover](workstream-07-cutover.md) | 1–6 | **CEO-run; out of scope for the agents** |
| 8 | [Docs and site](workstream-08-docs.md) | 4, 5, 6 | impl; **held for CEO review, never admin-merged** |
| 9 | [No-key mode eval](workstream-09-no-key-eval.md) | 2 (its result sets one picker line in WS5) | one agent: builds the no-key path, then evals; bounded |
| 10 | [Session-start sync and freshness tracking](workstream-10-session-start-sync.md) | 2, 3 (hook install earlier) | impl |

Parallel lanes: WS1, WS2 and WS3 start first. WS5 and the WS6 harness start once WS3 merges; WS9 once WS2 merges.
WS4 waits for 1, 2 and 3. WS10's hook install can start any time; its sync and tracking wait for 2 and 3. WS8 is
last.

## One switch

Everything the sprint adds to the client's behaviour sits behind one switch, **off by default until WS7**: with it
off, the client behaves exactly as it does today (catalog records, no model calls, no picker). With it on:

- **Catalog records win where they exist.** For a release whose records are in the catalog, the client uses them
  and makes no model call. It runs its own steps only for releases that have change events and no catalog records.
  During the grace period that is nothing, or close to it; after day 20 it is every new release. History is never
  re-derived on the user's tokens.
- The picker, the session-start sync and no-key mode are active.

Tests and the environment matrix turn the switch on. WS7 flips the default.

## Resolved decisions (10 November 2026)

| Decision | Result | Evidence |
|---|---|---|
| Where the model steps run on the client | **Rust**, in the client. TypeScript's advantages (MDX and HTML parsing, Playwright) belong to collection, which stays central | central calls models over plain HTTP (`central/src/pipeline/llm.ts`), not an SDK |
| Codex as a provider | **Yes**: `codex exec` headless with `gpt-6-luna` pinned, lean flags. Extraction is batched by length (a chunk above 6,000 characters goes alone; a batch holds at most 12,000 characters and 8 chunks). Measured: extraction recall is below the direct route (60.1% pooled against 75.6% for the client's direct run and 66.3 to 67.4% for central's), with precision level; 167k plan tokens per technology-year. Labels and matching through Codex are not measured | `eval/edge-cli/RESULTS.md`; batching and recall: `eval/edge-port/RESULTS.md`, addendum 1 |
| Cursor CLI as a provider | **No**: the plan serves no cheap model; 39–84× the direct cost | `eval/edge-cli/RESULTS.md` |
| Local encoder | **Experimental, not shipped**: fails stages 4 and 5 on precision; 299 MB lossless | `eval/edge-encoder/RESULTS.md` |
| Extraction (A+B) model | `gpt-6-luna`, reasoning low, two calls, on any OpenAI-compatible route or Codex | `eval/provider-matrix/RESULTS.md` |
| Labels (D) without Jev | `gpt-6-luna`, read on its choices; **allowed as a fallback, marked below Jev** on breaking recall | `eval/provider-matrix/RESULTS.md` addendum 1 |
| Matching (E) without Jev | `gpt-6-luna` answering by choice, with central's production rule (an uncalibrated answer counts as 0 in the guards): **allowed**. From the re-measurement with text answers read as options: no false merges measured on 141 merges; about 4 more duplicate records (4.0 to 4.5) per technology-year, which the reading agent absorbs. The fitted 0.82 / 0.97 / 1.01 bars need the stated-probability prompt, which the client does not send | `eval/provider-matrix/RESULTS.md` addendum 2; duplicates: `eval/edge-port/RESULTS.md`, addendum 1; WS4 review, 11 November |
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

- **Release and cutover (WS7): the CEO runs them.** Agents may publish to npm and Homebrew only when a test needs a
  published build.
- **Telling current users:** not now; part of WS7.
- **Copy review:** the CEO reviews the picker and notice phrasing in the playback gallery (WS6) before WS8.
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
5. **Session start is never blocked or broken:** the hook returns within 2 s with the catalog unreachable, the
   provider down or the cache corrupt, exits 0, and prints at most one line.

**Everything else is ship-and-observe.** Explicitly cut: the encoder; Cursor; open-ended rule tuning for no-key mode (WS9 has a stopping rule); OpenRouter parity (it follows the gateway
row until a check runs); repeat runs of the evals.

## Spend

Model calls made by the sprint itself (port parity, fixtures, the matrix) are paid by the CEO. Before any run that
calls a paid API, the agent estimates its cost from the token counts in the existing RESULTS files and writes the
estimate in the tracker. Up to $10 for the whole sprint it proceeds; past that it stops and asks. Runs cache every
call on disk, so a restart never pays twice. Tests use the mock server and cost nothing.

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
