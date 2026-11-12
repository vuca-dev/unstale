# Reading new release notes

unstale reads new release notes with a small model (`gpt-6-luna`, or Claude Haiku 5.5 on an Anthropic key), on the
provider you choose. On your own API key that costs about $0.05 a year per package (measured November 2026). On your
Codex plan there is nothing extra to pay. The cost stays small because each release note is read once, only for the
packages you use, and every answer is kept.

`unstale init` asks once which option to use. `unstale setup` asks again, and `unstale setup --details` prints the
figures for your repository.

## The options

The picker lists the options your machine can use, best first. Costs are per package, per year, at list prices in
November 2026, billed by the provider to your key.

| Read with | Needs | Cost per package, per year | Compared with the best option |
|---|---|---|---|
| Jev + an OpenAI-compatible key | `JEV_API_KEY` and a key from the fourth row | $0.036 | The best option |
| Jev + Codex plan | `JEV_API_KEY`, `codex login` | $0.018 for the labelling service; the reading draws on your plan | ≈ 80% of its changes |
| Snap + an OpenAI-compatible key | `SUBQ_API_KEY` and a key from the fourth row | About $0.04 | As many breaking changes found, ≈ 3% less precise: ≈ 89% of breaking-change flags right, against 92%. ≈ 1 more change listed twice |
| OpenAI, Vercel AI Gateway or OpenRouter key | `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY` or `OPENROUTER_API_KEY` | About $0.05 | As many breaking changes found, ≈ 3% less precise: ≈ 89% of breaking-change flags right, against 92%. ≈ 4 more changes listed twice |
| Codex plan | `codex login` | Nothing extra: it draws on your plan | ≈ 80% of its changes. Flags and repeats not measured |
| Anthropic key | `ANTHROPIC_API_KEY` | $0.075, an estimate | ≈ 90% of its changes, fewer from upgrade guides. ≈ 23 more changes listed twice. Estimates |
| Not now | | Free | Advisories and deprecations only: ≈ 27% of the changes in new releases |

Jev is a labelling service, and Snap a matching service, each used beside the provider that reads the notes. With
several OpenAI-compatible keys set, the picker offers one of them. The picker shows this repository's figure for a
year in dollars for a key, and "no extra cost" for a Codex plan.

## On a Codex plan

There is nothing extra to pay: the work draws on your plan. `unstale status` shows the tokens used this month, and
the work stops at the limit you set (see Limits).

## Where the figures come from

- **Measured** in [eval/edge-port/RESULTS.md](../eval/edge-port/RESULTS.md), November 2026, at list prices. A key
  alone is the sum of three steps: reading $0.014 to $0.018, labels $0.013 to $0.015, same-or-new matching $0.020.
  $0.036 is the upper end of its measured range. The same file gives ≈ 80% for Codex, 89% against 92% of
  breaking-change flags right (270 and 251 flags) and ≈ 4 more changes listed twice.
- **Measured** in [eval/select/slice19/RESULTS.md](../eval/select/slice19/RESULTS.md): the Snap row's matching cost
  ($0.0059, in place of $0.020) and its ≈ 1 more change listed twice.
- **Estimates:** the Anthropic row, and the first sync, which the picker quotes at one more year, once, as a ceiling.
- **≈ 27%** is the figure the client prints for what needs no model. Its evaluation is not yet published in this
  repository.

## What the provider receives

Release-note text goes to the provider you chose: the public text of the notes and the changes read from it. No code
and no file paths. The provider can tell which
packages' notes it was sent.

unstale finds keys by variable name, in your shell and this repository's `.env`, and stores the name only. The key is
read when a request is made and goes to that provider alone. unstale never opens another repository's `.env` or
another tool's credential files.

## When it runs

In the background when an agent session starts, or when you run `unstale session-sync`. `unstale sync` never calls a
model. Each release note is read once, only for the packages this repository uses, and each answer is kept, so
nothing is paid for twice.

The session-start hook checks whether the catalog changed and starts the background work if it did. It gives up after
1.2 seconds, so it never holds up a session, and prints at most one line. `"session_sync": false` in
`.unstale/config.json` turns it off.

## Limits

- **Tokens.** Model work stops for the month at 48M tokens. `unstale setup --limit 10M` changes the limit,
  `--limit none` removes it and `--limit default` restores it. The limit is yours: a repository's config can lower it,
  never raise it.
- **Disk.** The cache holds up to 100 MB. `UNSTALE_CACHE_MAX_MB` changes that, and `0` removes it. Answers you paid for
  are never deleted to make room. `unstale cache clean` removes what can be fetched again.

## When something is wrong

A rejected key, a provider that does not answer or a reached limit never fails a command. unstale prints one
`warning:` line with what happened and the fix, for example:

```
warning: OPENAI_API_KEY is not set here, so new release notes are not read. Set it.
```

`unstale status` always shows the current state:

```
Release notes         OpenAI (OPENAI_API_KEY), this repo's config
Tokens                0 of 48M this month (the default limit; `unstale setup --limit` changes it)
Cache                 under 1 MB of 100 MB
```

A client too old for the catalog reads no release notes and prints the upgrade command.

## Team default

Your choice is kept in your own config, `~/.config/unstale/config.json`, for this repository; `unstale setup --user`
saves it for all your repositories. Only that file can start spending on your key or plan. In shared mode
(`unstale init --mode shared`) the choice is also written to the committed `.unstale/config.json`, as the team's
suggestion: a teammate is asked once, with it as the default, and keeps their own key. A committed "no provider"
stands as it is, since it spends nothing.

## Scripts, CI and agents

Nothing is asked without a terminal. With no choice recorded, CI gets one line:

```
warning: no provider chosen, so new release notes are not read. `unstale setup` lists the options.
```

Record a choice without the question:

```sh
unstale setup --inference env:OPENAI_API_KEY      # a key, by its variable's name
unstale setup --inference jev+env:OPENAI_API_KEY  # with Jev beside it
unstale setup --inference subq+env:OPENAI_API_KEY # with Snap beside it
unstale setup --inference codex                   # your Codex plan
unstale setup --inference none                    # not now
```

An agent is shown the same options with the command for each, and is told to ask you. It never chooses.
