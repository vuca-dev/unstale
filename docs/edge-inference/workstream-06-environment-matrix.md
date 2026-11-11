# WS6: Environment matrix and playback

## Scope
A hermetic harness that runs the client in simulated developer environments, asserts the hold-the-line properties,
and records each session for review as a playback, like the landing page's terminal.

## Pre-conditions
Harness: WS3. Full matrix: WS4 and WS5.

## Acceptance criteria
- [ ] **Per scenario:**
  - a temporary HOME, PATH, environment and fixture repos;
  - a mock OpenAI-compatible server recording every request;
  - a fake `codex` recording its invocations;
  - canaries planted in a key value, `~/.codex/auth.json` and another repo's `.env`.
- [ ] **Dimensions, all pairs plus every critical path in full:**
  - keys: none / shell env / this repo's `.env` / only another repo's `.env` / several / revoked;
  - Codex: absent / logged in / logged out;
  - invocation: human terminal / agent install / CI;
  - repo config: none / set / set but missing locally;
  - client: fresh / upgrade from the previous release during grace / after the `min_client` bump.
- [ ] **Assertions:**
  - hold-the-line 1, 2 and 4 from the README;
  - at most one question per path, none without a terminal;
  - the budget defers in demand order;
  - multi-repo cache reuse;
  - notice and update lines once a day.
- [ ] **Output:** each scenario writes a golden transcript (snapshot tests, so regressions show as diffs) and a
      terminal recording; a gallery page plays them back.
- [ ] **Agent-install behaviour:** a few real agent runs in the sandbox confirm the agent asks the user rather than
      picking.

## Risks and rollback
Test-only; no product risk.
