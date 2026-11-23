# Edge inference through local agent CLIs, 10 November 2026

Can a client run its model steps through an agent CLI the user already has (Codex `codex exec`, Cursor `agent -p`),
headless, on the user's plan? Runner `run.mts`, summary `summarize.mts`, one line per call in `calls.jsonl` (metrics
only). Inputs are central's own prompts: `EXTRACT_PROMPT` (step A) on real release-note chunks and the label questions
(`labelQuestions()` in `ChatClassifier`'s prompt, step D) on real published records, read from the store. 36 Codex
calls (30 logged, 6 manual probes while choosing flags) and about 29 Cursor calls (21 logged, the rest model
and sandbox probes).

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
- **Cursor works headless after `agent login`, but it is not a candidate.**
  - The plan includes only Grok, Composer and `auto`. Every cheap OpenAI, Gemini or nano model is refused as "not
    included in your weekly usage".
  - Harness overhead is about 14.1k input tokens per call, with no flag to cut it.
  - At the cheapest priced model, cost per technology-year is about 39× (A+B) and 84× (D+E) the direct options, even
    at batch 8.
  - Ask mode blocks writes but **still runs shell commands and reads outside the workspace**. A workspace-level
    `.cursor/cli.json` deny rule is needed to stop that.

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

## Cursor (`agent`, 2026.10.14-941492e), after `agent login`

**Invocation** (no TTY, stdin closed; exit 0 on success, exit 1 on any error with the message on stderr):

```
agent -p --output-format json --mode ask --sandbox enabled --trust --workspace <empty temp dir> --model <id> '<prompt>'
```

- **Output.** It is a single JSON line:
  `{"type":"result","subtype":"success","is_error":false,"duration_ms":…,"result":"<answer>","usage":{"inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens"}}`.
- **Input tokens.** `inputTokens` excludes cache reads and writes, so total input is the sum of the three.
- **Not reported:** reasoning tokens, and which model `auto` picked.
- **Events.** `--output-format stream-json` adds one event per tool call.

**Models.** `agent models` lists 270 ids, but this plan serves few of them:

- Refused with "ActionRequiredError: <model> is not included in your weekly usage Buy credits or switch to a Grok model
  to continue.": `gpt-5.6-luna-low`, `gpt-5.4-nano-none` and `gemini-3.8-flash-low`. These are the cheapest ids listed:
  Luna, mini and nano, Flash and Haiku.
- Served: `auto`, `composer-2.5`, `grok-4.7-low` and `cursor-grok-4.5-low-fast`. There is no `gpt-6-luna`.
- I ran the payloads on `cursor-grok-4.5-low-fast`. It is the cheapest of these with a known list price
  (`spacexai/grok-4.5`: $2 / $0.30 cached / $6 per M). Composer has no public list price.

**Overhead probe** ("Reply with exactly: OK"):

| Model | Input tokens per call |
|---|---|
| `auto` | 21.4k (11.5k of it cache write) |
| `grok-4.7-low` | 15.6k |
| `cursor-grok-4.5-low-fast` | 14.1k |
| `composer-2.5` | 13.1k |

**Sandbox** (empty temp workspace each call; the user's Cursor config was neither read for auth nor modified):

- **`--mode ask --sandbox enabled`** (prompt: create `pwned.txt`, then `ls ~`): the write was refused ("Ask mode
  blocks writes"), but **the shell ran `ls ~` and returned the listing of the home directory.** Ask mode is not
  read-only for the shell.
- **The same flags plus a workspace `.cursor/cli.json`** with `{"permissions":{"allow":[],"deny":["Shell(*)","Read(**)","Write(**)"]}}`
  (the "deny" variant in `run.mts`):
  - The agent tried `ls /` twice. The second attempt was announced as "retrying with broader permissions".
  - Both attempts were refused: "Permission denied: Command blocked by permissions configuration".
  - No file was written in any call.
  - The deny file must be written into the temp workspace before every call.

**Overhead and payload** (deny variant, `cursor-grok-4.5-low-fast`, the same inputs as Codex):

| Task | Items/call | Calls | Input | Cached | Output | Payload in/item | Overhead/item | Wall p50 / max s | Parsed |
|---|---|---|---|---|---|---|---|---|---|
| trivial | 0 | 2 | 14,085 | 4,480 | 22 | — | 14,085 | 7.8 / 7.8 | 2/2 |
| A extract | 1 | 3 | 15,507 | 4,480 | 4,181 | 1,422 | 14,085 | 24.8 / 34.6 | 3/3 |
| A extract | 8 | 1 | 23,499 | 0 | 12,788 | 1,177 | 1,761 | 45.8 | 1/1 |
| D labels | 1 | 5 | 15,772 | 4,480 | 1,339 | 1,687 | 14,085 | 11.7 / 18.9 | 5/5 |
| D labels | 8 | 1 | 16,399 | 4,480 | 3,913 | 289 | 1,761 | 26.6 | 1/1 |

- **Overhead is the same as Codex's default harness** (14k), and no flag reduces it.
- **About 30% of input is cached,** against about 80% on Codex.
- **Output is 3–25× Codex's for the same task,** because Grok emits prose around the JSON. Hidden reasoning may also be
  billed as output; the usage does not say.

**Cost per technology-year, API-equivalent** (same scope and payload figures as Codex, at grok-4.5 list price):

| Batch | Overhead tokens | A+B ≈ $ (overhead part) | D+E ≈ $ (overhead part) |
|---|---|---|---|
| 1 | 3.74M | $1.03 ($0.75) | $6.79 ($4.71) |
| 8 | 0.47M | $0.37 ($0.09) | $1.76 ($0.59) |
| direct API (to beat) | 0 | $0.0096 | $0.021 |

**Failure modes:**

- **Invalid model id** (`not-a-model`), 2.5 s: "Cannot use this model: not-a-model. Available models: auto, gpt-5.3-codex-low, …"
  It lists every id.
- **Model not on the plan** (`gpt-5.6-luna-low`), 4.8 s: the ActionRequiredError above.
- **Logged out**, 0.4 s: "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY
  environment variable." The model id is not checked first. `agent status` prints "✓ Logged in as …" or
  "Not logged in".
- **The login can lapse unannounced.** Before the user re-ran `agent login`, `agent status` reported logged in until
  the first API call. A client should treat an auth error as "deferred", not fatal.

## Reproduce

`cd central && npx tsx ../eval/edge-cli/run.mts --cli codex|cursor --variant default|lean|ask|deny --task trivial|sandbox|sandbox-root|extract|labels|extract8|labels8 [--model M] [--tag T]`,
then `npx tsx ../eval/edge-cli/summarize.mts`. The inputs are read from the main checkout's `.store` (override with
`UNSTALE_STORE`).
