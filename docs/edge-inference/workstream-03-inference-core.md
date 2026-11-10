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
  - Codex: `codex exec` with the lean flag set from `eval/edge-cli/RESULTS.md`, `-s read-only`, `--ephemeral`,
    an empty temporary working directory, usage from `turn.completed.usage`.
- [ ] Batching (8 items per call) where the step allows it.
- [ ] **Usage ledger:** tokens in, cached, out and reasoning per call, per provider, per day, stored locally.
- [ ] **Budget:** a monthly token budget; work beyond it is deferred, never failed.
- [ ] **Errors:** 401, 429, 5xx, timeouts, Codex logged out (`codex login status` checked first), and a model not on
      the plan each map to a typed "deferred: <one line>" outcome. Retries with backoff for transient errors only.
- [ ] The key is read from the named environment variable at call time, never stored or logged; a test plants a
      canary key and asserts it appears only in the auth header sent to the mock server.
- [ ] Tests run against a local mock OpenAI-compatible server and a fake `codex` on PATH.

## Risks and rollback
Codex flag drift between versions: pin a minimum Codex version and detect it. Rollback: nothing calls this yet.
