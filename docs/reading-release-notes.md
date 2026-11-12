# Reading new release notes

unstale reads new release notes with a small model (`gpt-6-luna`, or Claude Haiku 5.5 on an Anthropic key), on your
own API key or your Codex plan. A package takes about 470,000 small-model tokens a year on an OpenAI key, about 39,000
a month or 1,300 a day. For scale, Claude Code alone spent 409,000 tokens on one review of one repository
([eval/beat-naive/RESULTS.md](../eval/beat-naive/RESULTS.md)). It stays that small because each release note is read
once, only for the packages you use, and every answer is kept.

`unstale init` asks once which option to use. `unstale setup` asks again, and `unstale setup --details` prints every
figure for your repository.

## The options

The picker lists the options your machine can use, best first. Tokens are per package, per year.

| Read with | Needs | Tokens per package, per year | Compared with the best option |
|---|---|---|---|
| Jev + an OpenAI-compatible key | `JEV_API_KEY` and a key from the fourth row | ≈ 500k: 425k to the labelling service, 53k in and 18k to 25k out on your key | The best option |
| Jev + Codex plan | `JEV_API_KEY`, `codex login` | ≈ 590k: 425k to the labelling service, 167k Codex plan tokens | ≈ 80% of its changes |
| Snap + an OpenAI-compatible key | `SUBQ_API_KEY` and a key from the fourth row | ≈ 420k: about 145k to the matching service, 240k in and 29k to 40k out on your key | As many breaking changes found, ≈ 3% less precise: ≈ 89% of breaking-change flags right, against 92%. ≈ 1 more change listed twice |
| OpenAI, Vercel AI Gateway or OpenRouter key | `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY` or `OPENROUTER_API_KEY` | ≈ 470k: 425k in, 40k to 50k out | As many breaking changes found, ≈ 3% less precise: ≈ 89% of breaking-change flags right, against 92%. ≈ 4 more changes listed twice |
| Codex plan | `codex login` | ≈ 650k Codex plan tokens, an estimate | ≈ 80% of its changes. Flags and repeats not measured |
| Anthropic key | `ANTHROPIC_API_KEY` | Not measured in tokens | ≈ 90% of its changes, fewer from upgrade guides. ≈ 23 more changes listed twice. Estimates |
| Not now | | None | Advisories and deprecations only: ≈ 27% of the changes in new releases |

Jev is a labelling service, and Snap a matching service, each used beside the provider that reads the notes. With
several OpenAI-compatible keys set, the picker offers one of them.

## Tokens and the picker's prices

Tokens are the stable measure: prices change, and a Codex plan is not billed in dollars at all. The picker shows this
repository's figure for a year at current prices, in dollars for a key and in plan tokens for Codex. At list prices on
11 November 2026 the rows above come to $0.036, $0.018 plus the Codex tokens, $0.050, $0.064, no charge beyond the
plan, and $0.075 (an estimate) per package, per year.

## Where the figures come from

- **Measured** in [eval/edge-port/RESULTS.md](../eval/edge-port/RESULTS.md), "Measured cost per technology-year":
  the tokens of each step on each route, and the dollar figures (the upper end of each range). The totals in the
  table are sums of those steps; per month and per day are the yearly figure divided by 12 and by 365. The same file
  gives ≈ 80% for Codex, 89% against 92% of breaking-change flags right (270 and 251 flags) and ≈ 4 more changes
  listed twice.
- **Measured** in [eval/select/slice19/RESULTS.md](../eval/select/slice19/RESULTS.md): the Snap row's matching cost
  and its ≈ 1 more change listed twice. Its 145k tokens are derived from that cost.
- **Measured** in [eval/beat-naive/RESULTS.md](../eval/beat-naive/RESULTS.md): 409,000 tokens for Claude Code's
  review of one repository, a mean over 19 repositories. Those are a large model's tokens; unstale's are a small
  model's.
- **Estimates:** the Anthropic row; the Codex plan's 650k tokens, of which 167k is measured and the rest is not; and
  the first sync, which the picker quotes at one more year, once, as a ceiling.
- **≈ 27%** is the figure the client prints for what needs no model. Its evaluation is not yet published in this
  repository.

## What the provider receives

Public release-note text and the changes read from it. No code and no file paths. The provider can tell which
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

- **Tokens.** Model work stops for the month at 48M tokens. A hundred packages use about 3.9M a month. `unstale setup --limit 10M` changes the limit,
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

In shared mode (`unstale init --mode shared`) `.unstale/config.json` is committed. It names the provider and the key's
variable, so the team shares the choice and each person keeps their own key. `unstale setup --user` saves a choice for
all your repositories in `~/.config/unstale/config.json`. A repository's own choice comes first.

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
