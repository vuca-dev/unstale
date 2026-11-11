# Environment matrix

`cargo test --test matrix` (part of `cargo test` in `local/`, so CI runs it) runs the client end to end on simulated
developer machines. Each scenario gets its own temporary HOME (with the repository at `~/code/shop` and a sibling
repository at `~/code/other`), PATH, environment, a mock catalog host, a mock model provider, a proxy that catches any
request leaving the machine, and a fake `codex` when Codex is installed. Canaries sit in every key value, in
`~/.codex/auth.json` and in the sibling repository's `.env`; those, the `.env` files above the repository, this
repository's `.env.local` and the shell startup files (`NEVER_OPENED` in `world.rs`) are FIFOs that record being
opened.

## What each scenario must hold

- **Hold-the-line 1:** no canary in any output, written file, or request, except the chosen key in the chosen
  provider's auth header; none of the never-opened files is opened.
- **Hold-the-line 2:** nothing reaches the proxy; the provider is contacted only on the chosen provider's API;
  `codex exec` runs only with Codex chosen; no request or `codex` argument carries a repository path or code.
- **Hold-the-line 4:** every command exits 0 with no `error:` line; a provider failure or a reached token
  limit is one `warning:` line.
- At most one question per path, none without a person at the terminal (an agent driving a pseudo-terminal gets the
  listing instead); a question dismissed with Ctrl-D records no provider and is not asked again; Ctrl-C records
  nothing. The catalog's notice (what to do, by a date) and update lines show at most once a day.

- Plain words: no output uses the implementation's vocabulary (`INTERNAL_WORDS` in `checks.rs`), and without a
  terminal no step-by-step progress is printed.

Each check has a test that injects a violation (`the_checks_catch_*`) and fails without it; run them with
`-- --nocapture` to see the failing output. Checks that cannot run yet are ignored tests with their reason.

The model step is the internal `unstale infer` on the chosen provider until the client's own pipeline steps call the
provider; then `Step::Model` runs them instead, and every scenario's checks apply to them unchanged.

## Adding a scenario

- A dimension value: one line in its table in `dimensions.rs` (`KEYS`, `CODEX`, `INVOCATIONS`, `REPO_CONFIGS`,
  `CLIENTS`). The pairs are recomputed.
- A critical path run in full: one line in `CRITICAL`, with its title in plain words.

Then `UPDATE_GOLDEN=1 cargo test --test matrix` writes its transcript (`golden/`), its recording (`recordings/`,
asciicast v2) and the gallery. Review the diff before committing; a changed transcript is a changed user experience.

## Playback

Open `local/cli/tests/matrix/gallery.html` in a browser (from the file; it needs no network). Scenarios are grouped
by what the user did; each plays back or shows its whole session, with its transcript and the hosts it contacted.

## Real agent runs (opt-in, billed)

`UNSTALE_AGENT_TRIALS=1 AGENT=claude RUNS=3 local/cli/tests/matrix/agent-trials.sh` installs unstale in a sandbox
repository through a real agent and reports whether it asked the user to choose a provider rather than choosing one.
It bills the agent's plan, so it never runs in `cargo test` or CI.
