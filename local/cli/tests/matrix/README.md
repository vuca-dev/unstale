# Environment matrix

`cargo test --test matrix` (part of `cargo test` in `local/`, so CI runs it) runs the client end to end on simulated
developer machines. Each scenario gets its own temporary HOME (with the repository at `~/code/shop` and a sibling
repository at `~/code/other`), PATH, environment, a mock catalog host, a mock model provider, a proxy that catches any
request leaving the machine, a redirect target, and a fake `codex` when Codex is installed. Canaries sit in every key
value, in `~/.codex/auth.json`, in a registry token in `~/.npmrc` and in the sibling repository's `.env`.

Every file the client tries to open is recorded, whether or not it exists: an open logger (`openlog.c`, built with
`cc` at the start of the run) is loaded into the client (`DYLD_INSERT_LIBRARIES` on macOS, `LD_PRELOAD` on Linux).
In HOME it may open only this repository, its own cache and user config, and the package managers' registry
configuration in HOME and above the repository (`MAY_OPEN` and `REGISTRY_CONFIG` in `world.rs`). Secret files
(`NEVER_OPENED`: `.env` files above the repository and in the sibling, shell startup files, `~/.aws/credentials`,
`~/.ssh/*`, `~/.netrc`, `~/.config/gh/hosts.yml`) are also planted as FIFOs that record being opened.

## What each scenario must hold

- **Hold-the-line 1:** no canary in any output, written file, or request, except the chosen key in the chosen
  provider's auth header; none of the never-opened files is opened.
- **Hold-the-line 1, keys:** no canary, whole or any 12 characters of one, in any output, file or request; `codex
  exec` starts with only the variables it needs.
- **Hold-the-line 2:** nothing reaches the proxy; the provider is contacted only on the chosen routes' APIs; `codex
  exec` runs only with Codex chosen; no request or `codex` argument carries a path under HOME, a repository file's
  name or a line of its contents; a redirect is never followed. No HTTP agent in the client's source sets its own
  proxy or none, and it opens no raw socket (a source check: no scenario can take the network away on every CI
  runner).
- **Hold-the-line 4:** every command exits 0 with no `error:` line; a provider failure or a reached token
  limit is one `warning:` line.
- **Registry lookups:** the matrix sets `UNSTALE_NO_REGISTRY=1` except in a slice run with lookups on
  (`REGISTRY_SLICE`), where the only hosts reached through the proxy are the public npm and PyPI registries and the
  advisory database (`REGISTRY_HOSTS`), each a `CONNECT` and nothing else. What is asked inside the tunnel cannot be
  read: the client trusts only its bundled roots, and it has no address override for the registries. The proxy
  refuses the tunnels, so each command there waits about 25 s on the client's own retries.
- **Monthly token limit, cache reuse, upgrades:** a limit of one token stops the work after the most needed
  technology's first call (demand order, not name order), and a repository's limit only lowers the user's
  (`the_budget_defers_work_in_demand_order`); a second repository with the same stack makes no model call
  (`a_second_repository_reuses_the_cached_results`). The client rows `upgraded` and `below-min` set the repository up
  first, then move the catalog: the previous release's binary is not built here, so the earlier setup is this build's,
  and the `min_client` bump is the catalog naming a version above this one. Below it, the client must say so (`init`,
  `status` and `session-sync` each time, as they keep going on the cache), keep its cached catalog, and read nothing:
  no provider request, no `codex exec`, and no "every release note here is read". In `upgraded` the earlier setup has no Codex or
  opencode session start, as the previous release wrote neither: only `init` may add them, and another command says
  so once, never to CI.
- **The choice is the user's own:** consent to spend is read from the user's config only (their answer for this
  repository, else their choice for every repository). A provider a repository's config names (`REPO_CONFIGS`) is a
  suggestion, whoever wrote the file and whether or not it is committed. With no choice of the user's, nothing is sent
  to a provider and no `codex exec` runs: CI and an agent get the line that says so, and a person at a terminal is
  asked once, the suggestion being the option Enter accepts where this machine offers it. The answer is kept in the
  user's config, and a committed file is left as it was. The user's own "no provider" stands whatever a repository
  holds (`a_committed_choice_never_overrides_the_users_own_none`,
  `a_committed_choice_spends_nothing_until_the_user_makes_it_theirs`; the shapes a repository's files can take are in
  `tests/pipeline.rs`).
- **Known product bugs** (`KNOWN_BUGS` in `checks.rs`): violations the harness may not fix are listed with where they
  come from; they show in the transcripts and do not fail the run, and one no scenario shows any more fails it.
- At most one question per path, none with `--yes` (even at a terminal), none without a person at the terminal (an agent driving a pseudo-terminal gets the
  listing instead); a question dismissed with Ctrl-D records no provider and is not asked again; Ctrl-C records
  nothing. The catalog's notice (what to do, by a date) and update lines show at most once a day.

- Plain words: no output uses the implementation's vocabulary (`INTERNAL_WORDS` in `checks.rs`), and without a
  terminal no step-by-step progress is printed.

Each check has a test that injects a violation (`the_checks_catch_*`) and fails without it; run them with
`-- --nocapture` to see the failing output. Checks that cannot run yet are ignored tests with their reason.

Model work runs the client's own pipeline, as a user's machine runs it: `unstale session-sync` by hand at a terminal
and in CI, and in an agent's session the session-start hook that agent installed (run as the agent runs it) with the
background stage it starts. The mock catalog carries change events for five releases: some with catalog records, one
marked `extracted` by the catalog, and two with neither. The mock model (`model.rs`) answers extraction, its labels,
the label questions and matching on every route (OpenAI-compatible, Anthropic, the labelling service, and Codex through
a fake `codex`), and each scenario asserts that only the two releases with neither were sent, and that with a working
provider both were read.

- **Hold-the-line 5:** each session-start hook exits 0 within 2 s, prints at most one line and nothing on stderr. In
  agent sessions the hook runs twice, so its warnings show in the transcripts. A separate test runs all three agents'
  hooks (Claude Code and Codex through a shell, opencode's plugin through a stand-in for its runtime) in the worst
  cases: catalog and coverage service hanging, a state file that never finishes reading, the cache corrupt, the
  provider hanging with model work pending. With the switch off, session start writes none of the switch's files and
  runs no model work.

## What the harness cannot see

- Opens: only `open` and `openat` by the `unstale` process itself, and only under HOME. Not `read_dir` or `stat`, not
  the processes it starts (`git`, a shell, `codex`), not files outside HOME (`/etc`). A statically linked (musl) build
  loads no library, so the logger records nothing there; nothing at all on Windows.
- The output of a background stage the hook starts: it is detached with no stdout or stderr. Its effects (requests,
  files, the state the next session start reads) are checked; anything it would print is not.
- A connection that skips the proxy variables: every scenario points them at the trap, so a client that ignores them
  (a raw socket, `Command::new("curl")`, an HTTP agent with its own proxy setting) would reach the network unseen. The
  source check catches the HTTP agent setting and raw sockets in the client's own code, not a subprocess.
- What the registries are asked inside their TLS tunnels (see the registry slice above).
- Timing: hold-the-line 5's 2 s limit is wall-clock time; the worst case measured is about 1.3 s (the hook's own
  1.2 s deadline), so a heavily loaded machine could fail it without a product change.

## Adding a scenario

- A dimension value: one line in its table in `dimensions.rs` (`KEYS`, `CODEX`, `INVOCATIONS`, `REPO_CONFIGS`,
  `CLIENTS`). The pairs are recomputed.
- A critical path run in full: one line in `CRITICAL`, with its title in plain words.

Then `UPDATE_GOLDEN=1 cargo test --test matrix` writes its transcript (`golden/`). Review the diff before
committing; a changed transcript is a changed user experience.

## Playback

`MATRIX_GALLERY=1 cargo test --test matrix` (in `local/`) also writes each scenario's recording (`recordings/`,
asciicast v2) and `gallery.html`, from the same run as the transcripts. Neither is committed or compared: the
transcripts are the test. CI's `rust` job uploads the gallery as the `matrix-gallery` artifact of each run.

Open `local/cli/tests/matrix/gallery.html` in a browser (from the file; it needs no network). Scenarios are grouped
by what the user did (installs at a terminal, through an agent, in CI; meets a provider problem or the monthly
limit; upgrades; turns registry lookups on); each plays back or shows its whole session, with its transcript, the
hosts it contacted and any known product bug it shows. Agent sessions include their session-start hook runs, and
every session with a provider includes the model work.

## Real agent runs (opt-in, billed)

`UNSTALE_AGENT_TRIALS=1 AGENT=claude RUNS=3 local/cli/tests/matrix/agent-trials.sh` installs unstale in a sandbox
repository through a real agent and reports whether it asked the user to choose a provider rather than choosing one.
It bills the agent's plan, so it never runs in `cargo test` or CI.
