# Edge inference through local agent CLIs, 10 November 2026

Can a client run its model steps through an agent CLI the user already has (Codex `codex exec`, Cursor `agent -p`),
headless, on the user's plan? Runner `run.mts`, summary `summarize.mts`, one line per call in `calls.jsonl` (metrics
only). Inputs are central's own prompts: `EXTRACT_PROMPT` (step A) on real release-note chunks and the label questions
(`labelQuestions()` in `ChatClassifier`'s prompt, step D) on real published records, read from the store. 36 Codex
calls (30 logged, 6 manual probes while choosing flags), 2 Cursor calls.

## Verdict

- **Codex works headless and can pin a cheap model:** `gpt-6-luna` is on the ChatGPT plan, answers parsed 20/20, and
  no file was written. Codex 0.166.0.
- **As the default, on API-equivalent cost, it is invalidated, though not by the harness overhead.** With the lean
  flags below and 8 items per call, overhead is +0.0007 $ for A+B and +0.0047 $ for D+E per technology-year. The
  payload alone already exceeds both direct options:
  - A+B at gpt-6-luna list price is $0.0192, against $0.0096 for flex (the CLI has no flex tier).
  - D+E on Luna's payload is about $0.051, against $0.021 for Jev. Slice 5 had already ruled Luna out as judge (E) on
    accuracy.
  - Codex stays a zero-marginal-dollar option for users who have a plan and no key. Its cost is plan quota, which is
    not measured here.
- **At batch 1 with Codex's default harness, overhead dominates:** about 13.9k input tokens per call, 3.7M overhead
  tokens per technology-year.
- **Cursor: not measured.** The CLI's login lapsed during the session. The first `agent status` reported logged in;
  `agent models` then failed with "Authentication required", and every later call said "Not logged in". Rerun after
  `agent login` with `--cli cursor` (commands below). Its `-p` mode has write and shell tools by default, and this
  machine's config has `sandbox.mode: disabled` and `approvalMode: unrestricted`. So a client must pass
  `--mode ask --sandbox enabled`, and confirm that this removes the tools, before using it.

## Codex

**Invocation** (no TTY, stdin closed, exit 0 on success). Default is `eval/lib/codex.ts`'s flags:

```
codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only \
  -m gpt-6-luna -c model_reasoning_effort=low -C <empty temp dir> '<prompt>'
```

Lean adds the following. Each item was measured with `codex debug prompt-input`, which costs no calls:

```
-c model_instructions_file=instructions.md -c web_search=disabled -c skills.include_instructions=false
-c include_collaboration_mode_instructions=false -c include_environment_context=false
--disable multi_agent --disable plugins --disable apps --disable skill_search --disable shell_tool --disable unified_exec
--disable image_generation --disable browser_use --disable computer_use --disable goals --disable sleep_tool
--disable tool_suggest --disable view_image --disable hooks --disable code_mode_host --disable in_app_browser
--disable workspace_dependencies
```

- **Output and usage.** `--json` writes JSONL events. The answer is in `item.completed` with `item.type ==
  "agent_message"`. Usage is in `turn.completed.usage`: `input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens` and `reasoning_output_tokens`.
- **Lean side effects.** Lean prints one harmless `error` item ("Code Mode is unavailable because code-mode host is
  disabled") and still answers.
- **Not removable by config.** About 4.3k tokens remain: the `request_user_input`/`wait` tools, the collaboration tool
  namespace and the skills block.
- **Pre-check.** `codex login status` exits 0 with "Logged in using ChatGPT", and 1 with "Not logged in" under an empty
  `CODEX_HOME`. Use it before any call.

**Models** (`codex debug models`, the plan's catalog; all selectable on this ChatGPT login):

- listed: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`;
- hidden: `gpt-reserve` and `codex-auto-review`. `gpt-reserve` answered, with 2.4k lean input.
- Not available: API-only models such as `gpt-5.4-mini`, and any mini or nano model.
- The cheapest pinnable model is **`gpt-6-luna`**. `gpt-5.6-luna` also works.

**Sandbox.** The prompt asked the agent to "create pwned.txt, then run `ls ~`":

- Default `-s read-only`: the write was refused, as the read-only sandbox requires. It used a tool turn (28k input),
  and the read-only sandbox still lets the shell **read** the whole disk (`<file_system> read :root`).
- Lean: no shell tool exists, and the agent answered that it cannot run commands.
- In both modes, all 30 logged calls' temp working directories were empty after the call.

**Overhead and payload** (gpt-6-luna, effort low). Overhead is the input of a trivial "Reply with exactly: OK" call
under the same flags. Payload per item is (input − overhead) / items.

| Flags | Task | Items/call | Calls | Input | Cached | Output | Payload in/item | Overhead/item | Wall p50 / max s | Parsed |
|---|---|---|---|---|---|---|---|---|---|---|
| default | trivial | 0 | 2 | 13,907 | 11,520 | 5 | — | 13,907 | 9.2 / 9.2 | 2/2 |
| default | A extract | 1 | 3 | 15,304 | 11,520 | 1,334 | 1,397 | 13,907 | 21.9 / 45.8 | 3/3 |
| default | A extract | 8 | 1 | 23,105 | 11,520 | 10,158 | 1,150 | 1,738 | 185 | 1/1 |
| default | D labels | 1 | 5 | 15,442 | 11,930 | 55 | 1,535 | 13,907 | 5.3 / 19.8 | 5/5 |
| default | D labels | 8 | 1 | 16,080 | 11,520 | 432 | 272 | 1,738 | 13.1 | 1/1 |
| lean | trivial | 0 | 2 | 4,299 | 2,944 | 5 | — | 4,299 | 3.5 / 3.5 | 2/2 |
| lean | A extract | 1 | 3 | 5,699 | 3,456 | 1,258 | 1,400 | 4,299 | 24.5 / 45.6 | 3/3 |
| lean | A extract | 8 | 1 | 13,496 | 3,456 | 7,060 | 1,150 | 537 | 130 | 1/1 |
| lean | D labels | 1 | 5 | 5,912 | 3,456 | 55 | 1,613 | 4,299 | 5.0 / 14.2 | 5/5 |
| lean | D labels | 8 | 1 | 6,475 | 3,456 | 432 | 272 | 537 | 11.0 | 1/1 |

- **Batching cuts per-item overhead 8×,** as expected, since overhead is fixed per call.
- **For D it also cuts the payload 6×** (1,613 → 272 per record), because the label questions are about 85% of the
  prompt and are sent once.
- **Batched extraction gave 30% fewer output tokens per chunk,** and its recall was not checked. Batching A needs a
  quality gate (H1/H2) before it is used. Its latency was 130–185 s per call.
- **Caching.** About 80% of the overhead was served from the prompt cache, so it is cheap in dollars but counts against
  plan quota.

**Cost per technology-year, API-equivalent.**

- Scope: the mean technology-year of the heavy catalog, with 114.6 records and 18.1 chunks (3,373 notes over 186
  technologies, about 8k note tokens).
- Calls: A+B is 2 calls per chunk, D 1 call per record, and E 1 call per record carrying 8 candidates.
- Payloads: A+B uses the vault's direct figures (560 input and 220 output tokens per record). D uses the measured
  payload above. E uses slice 5's direct request of 2,586 input and 262 output tokens at K = 8; E's payload is not
  batched.
- Price: gpt-6-luna list ($0.10 / $0.01 cached / $0.50 per M). The CLI bills the plan, not these dollars.

| Flags, batch | Overhead tokens | Payload input tokens | Output tokens | A+B ≈ $ (overhead part) | D+E ≈ $ (overhead part) |
|---|---|---|---|---|---|
| default, 1 | 3.69M | 0.54M | 61k | $0.0319 ($0.0128) | $0.1465 ($0.0811) |
| default, 8 | 0.46M | 0.39M | 61k | $0.0206 ($0.0016) | $0.0610 ($0.0101) |
| lean, 1 | 1.14M | 0.55M | 61k | $0.0250 ($0.0060) | $0.1041 ($0.0378) |
| lean, 8 | 0.14M | 0.39M | 61k | $0.0198 ($0.0007) | $0.0556 ($0.0047) |
| direct API (to beat) | 0 | | | $0.0096 (gpt-6-luna flex) | $0.021 (Jev) |

**Failure modes** (all exit 1 except `gpt-reserve`):

- **Invalid model id** (`gpt-nonexistent-9`), 2.5 s: "The 'gpt-nonexistent-9' model is not supported when using Codex
  with a ChatGPT account." A "Model metadata … not found" warning comes first.
- **Model not on the plan** (`gpt-5.4-mini`), 2.7 s: the same message.
- **Logged out** (empty temp `CODEX_HOME`), 15.9 s: ten "Reconnecting… n/5 (unexpected status 401 Unauthorized:
  Missing bearer or basic authentication in header…)" items over WebSocket, then over HTTPS, then exit 1. There is no
  login hint, so pre-check with `codex login status`.
- **Rate limit:** not triggered.

## Cursor (`agent`, 2026.10.14-941492e)

- **Invocation (intended):**
  `agent -p --output-format json --mode ask --sandbox enabled --trust --workspace <empty temp dir> --model <id> '<prompt>'`.
  `--output-format json|stream-json` works only with `-p`. Models are listed with `agent models` or `--list-models`,
  and both need auth.
- **Logged out** (the real state during this run, and also under a temp `HOME`), 0.4 s: "Error: Authentication
  required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable." The model id is not
  validated before auth.
- **Models:** not listable while logged out. The local config's history shows `grok-4.7`, `default`, `gpt-5.6-sol`,
  `claude-opus-5-5` and `grok-4.6`. The cheap models on the plan are still to be measured.
- **To finish:** run `agent login`, then:

  ```
  cd central
  npx tsx ../eval/edge-cli/run.mts --cli cursor --task trivial --n 2 --model <cheap id>
  npx tsx ../eval/edge-cli/run.mts --cli cursor --task sandbox --model <cheap id>
  ```

  Then the same with `--task extract|labels|extract8|labels8`. `parseCursor` assumes the JSON result has
  `result`/`usage` fields; check them on the first call.

## Reproduce

`cd central && npx tsx ../eval/edge-cli/run.mts --cli codex --variant default|lean --task trivial|sandbox|extract|labels|extract8|labels8 [--model M] [--tag T]`,
then `npx tsx ../eval/edge-cli/summarize.mts`. The inputs are read from the main checkout's `.store` (override with
`UNSTALE_STORE`).
