# WS3: Client inference core

## Scope
A provider layer in the Rust client, with no pipeline logic: send a prompt, get a parsed answer and metered usage.

## Pre-conditions
None. The client already uses `ureq` with rustls; prefer it over adding an async runtime.

## Acceptance criteria
- [ ] **Adapters:**
  - OpenAI-compatible chat with structured output (base URL and model from config): OpenAI, Vercel AI Gateway,
    OpenRouter, custom.
  - The Jev / TypeSafe decision API (request shape as `eval/select/jev.ts`).
  - Anthropic Messages with structured output, for a user who has only an Anthropic key (model: Haiku 5.5; check
    the current API reference for the structured-output form rather than relying on memory).
  - Codex: `codex exec` with the lean flag set from `eval/edge-cli/RESULTS.md`, `-s read-only`, `--ephemeral`,
    an empty temporary working directory, usage from `turn.completed.usage`.
- [ ] Batching (8 items per call) where the step allows it.
- [ ] **Usage ledger:** tokens in, cached, out and reasoning per call, per provider, per day, stored locally.
- [ ] **Budget:** a monthly token budget; work beyond it is deferred, never failed. The default is a named constant,
      proposed at twice the measured first sync of a 40-technology repo (WS4 supplies the number; until then, the
      eval mean). The picker and `unstale status` state it.
- [ ] **One worker per machine:** a lock so two sessions starting together do not run the same work twice; the
      second exits quietly.
- [ ] **Errors:** 401, 429, 5xx, timeouts, Codex logged out (`codex login status` checked first), and a model not on
      the plan each map to a typed "deferred: <one line>" outcome. Retries with backoff for transient errors only.
- [ ] The key is read from the named environment variable at call time, never stored or logged; a test plants a
      canary key and asserts it appears only in the auth header sent to the mock server.
- [ ] Tests run against a local mock OpenAI-compatible server and a fake `codex` on PATH.

## Risks and rollback
Codex flag drift between versions: pin a minimum Codex version and detect it. Rollback: nothing calls this yet.
