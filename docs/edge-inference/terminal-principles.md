# Terminal principles

What unstale prints, for a developer at a terminal and for a coding agent reading the same output. From the CEO's
review of the playback gallery (11 November 2026), on top of the earlier rules (state the trade; cost with units and
scope; quality as a word band plus a number; no internal names).

**Target:** as a developer or an agent, I know what I need to know and where to read first. Nothing more, nothing
less. Quiet and well ordered, not loud: no banners, no "LOOK HERE".

## The principles

1. **A line is there because the reader does something with it.** Decide, act, or know that something they rely on
   changed. Everything else belongs in `unstale status`, or nowhere. Test for every line: what does the reader do
   after reading it? If the answer is "nothing", cut it.
2. **Most important first.** The order is: a choice that is needed, then what is wrong, then the result, then
   detail. A reader who stops after the first screenful has the part that matters.
3. **A choice looks like a choice.** A question on its own line, a blank line around the options, options aligned
   in columns, the default marked, one short prompt. The form developers know from other install tools. It must be
   obvious that the tool is waiting, and for what.
4. **Headline, not arithmetic.** Each option shows one cost (what this repo will pay, per year) and, below the
   best option, one quality figure. The unit rate, the first-sync figure, token counts and the second quality figure
   are detail: shown on request (`unstale setup --details`) and in the docs, not in the list. Several options must
   read as a table, never as a wall of formulas.
5. **Nothing is accepted silently.** Whenever the user gets less than the best option, including no provider at
   all, they are told what they give up, with a number, at the moment they choose. The default path with no usable
   key is a prompt that states that trade and how to fix it, not a paragraph telling them to set variables.
6. **Degraded is said plainly, at the right weight.** If work the user chose did not happen (the provider is not
   answering, a key was rejected, the monthly limit was reached, a sync failed), that is a warning: what happened in
   the user's words, what it costs them, the one thing to do. Not a neutral aside, and not internal vocabulary such
   as "deferred". Still never an error exit. Say it when the state changes, not on every run; `unstale status`
   always shows the current state.
7. **Limits belong to the user.** Any limit unstale applies on the user's behalf (the monthly token limit) is a
   setting with a stated default, a way to change or remove it, and a warning with that instruction when it is
   reached.
8. **No half releases, no unannounced costs or files.** Until a feature ships as a whole, nothing of it is
   visible: no new lines, no new files in the repo or the home directory, no new network requests. Nothing that
   spends the user's money or plan runs before they have chosen it.
9. **One content, three readers.** A person at a terminal gets the prompt. An agent gets the same options as text
   it must show the user, plus the exact command that records the answer; it never chooses. CI gets no question
   and one line only if something is degraded. In all three, a degraded or unconfigured state is stated, never
   passed over in silence.
10. **Background work is silent when it succeeds.** Progress exists to show a waiting person that something is
    happening. Without animation, and for agents and CI, progress collapses to the result: one line, not a line per
    step.
11. **Plain words.** No vocabulary the reader has not been taught: not "deterministic signals", "technology-year",
    "deferred", "edge", step letters, eval names or test fixtures. Say what it is: "security advisories and
    deprecations only", "per package, per year", "skipped until the provider answers".
12. **Elegance is alignment and restraint.** Whitespace, columns and at most one accent do the work. No boxes,
    banners, capitals or emoji. A line that needs more than about 100 characters is carrying detail that belongs
    elsewhere.

## Applied to this sprint's surfaces

| Surface | Today | Change |
|---|---|---|
| Provider picker | One long line per option: unit rate, repo total, first sync, two quality figures | A table: provider, cost for this repo per year, what is traded. Detail behind `--details`. Question and prompt set apart (3, 4) |
| No usable key or Codex | A paragraph listing four variables; no question; "deterministic signals only" | A prompt: set a key (how), or continue without, stating what is missed with a number (5, 11) |
| "None" option | "deterministic signals only; new change details need a key or Codex" | States what the user gets and misses, with a number (5, 11) |
| Agent install with nothing to use | Twelve progress lines, then no mention that no provider is set | Progress collapses; the agent is told a choice is pending and what to ask the user (9, 10) |
| CI | No question, nothing said | One line when no provider is configured or work was skipped (9) |
| Provider failures ("deferred: the provider is not answering; it runs next time") | Neutral, internal word, every run | A warning in plain words with the cost and the fix, on state change; current state in `status` (6, 11) |
| Monthly token limit ("0 of 48M (monthly budget; past it, work waits for next month)") | Fixed default, shown always | A setting (`unstale setup` or config), may be removed; shown in `status`; a warning when reached, with how to raise it (6, 7) |
| Catalog notice | Printed once a day | Printed only when the user must act by a date; says what to do; never a standing line. The gallery's placeholder text ("the catalog's notice for the matrix") is a test fixture and is replaced with a realistic one (1) |
| Update line | "unstale X available: <command>" once a day | Keep: the reader acts on it. Not more than once a day (1) |
| Session-start line to the agent | About 200 characters, with instructions | One short line: what is new and the command. Instructions for the agent live in the skill (2, 12) |
| Session-start hooks and sync | On by default with the switch off | Behind the switch until the release (8) |
| Freshness line in `status` | One dense line with medians and percentiles | Two short aligned lines; `status` is the place for it (1, 12) |
| Sync results ("Records from new releases: …", event sync failure, "1 other candidate technologies") | Mixed | One result line; failures follow rule 6; fix the plural (1, 6) |
| Codex hook trust | Left to Codex's own prompt | One line at install naming the step, since the user must act (1) |
| `unstale init` after the choice | Confirmation line, then the report | Keep the one confirmation line; the report follows unchanged (2) |

## The picker, as a sketch (wording is the CEO's to refine in the gallery)

```
How should unstale read new release notes?

  1  OpenAI           OPENAI_API_KEY    about $0.18 a year here    finds ≈ 93% of what the best option finds
  2  Not now                            free                       security advisories and deprecations only: ≈ N% of changes

Enter for 1, a number to choose, or `unstale setup --details` for the full costs:
```

With nothing usable:

```
unstale reads new release notes with a model, on your own key or your Codex plan. None is set up here.

  1  Set one up       shows the one line to add, then run `unstale setup`
  2  Not now          free    security advisories and deprecations only: ≈ N% of changes

Enter for 1, or a number to choose:
```

`N` is measured, not guessed (the no-key eval reports the share of real finds that need no release-note text).
