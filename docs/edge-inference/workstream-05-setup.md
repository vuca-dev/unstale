# WS5: Setup: detection, picker, config

## Scope
How a developer, or their agent, chooses a provider, with at most one question.

## Pre-conditions
WS3 merged.

## Acceptance criteria
- [ ] **Detection by name only:**
  - environment variable names for each supported provider;
  - `codex` on PATH and `codex login status`;
  - this repo's config.
  - Never reads a value before consent; never reads other repos' `.env` files or other tools' auth files (test with
    canaries).
- [ ] **Picker:** one numbered list, recommended option preselected, Enter accepts.
  - Each option on one line with a cost quote that states units and scope, for example "$0.03 per technology-year ·
    this repo: 38 technologies ≈ $1.20/yr · first sync ≈ $0.40 once"; Codex as tokens plus "≈ $X at API prices".
  - Options below Jev quality say so in a few words.
- [ ] **Config:** `inference = { provider = "...", key_env = "..." }` in the repo config (shared by a team) or the user
      config. The key value is never written anywhere.
- [ ] **No terminal:** `--inference <provider|env:NAME|codex|none>` for CI; with no terminal and no flag, no prompt
      and, with no provider configured, deterministic signals only.
- [ ] **Agents:** the managed skill tells the agent to show the user the picker's options and ask, never to choose.
- [ ] **Status:** `unstale status` shows the provider, this month's tokens and the budget.

## Copy
- Every option line, including each fallback (Anthropic key alone, Codex alone, no-key mode), states its trade the
  same way: cost with units and scope, and quality as a word band plus a number ("somewhat less complete, ≈ 90% of
  the best option's results").
- Tight and informational for a developer: as high-level as it can be, specific where vagueness would mislead.
  More text gets scanned; over-abbreviated text says nothing. No internal names (step letters, eval set names).
- The CEO reviews the phrasing in the WS6 playback gallery before WS8.

## Risks and rollback
Cost quotes depend on WS4's records-per-technology estimate; until then, quote from the eval means and label them as
estimates.
