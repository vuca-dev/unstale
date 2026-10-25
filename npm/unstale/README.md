# @unstale/cli

unstale reads the official release notes, migration guides, docs and security advisories of the packages you use,
distills each change once, and matches it against your code. Your coding agent (Claude Code, Codex, Cursor or
opencode) then knows what applies here: new APIs worth adopting, breaking changes for your next major upgrade,
deprecations, and the security and performance fixes in each version bump. Every item links to its source.

It finds 4x as many upstream changes that apply to your code as Claude Code alone, using 1/16 of the tokens
([how we measured](https://github.com/vuca-dev/unstale/blob/main/eval/beat-naive/RESULTS.md)).

```sh
npx @unstale/cli init
```

Then, in your agent, inside that repository:

| Agent | Run |
|---|---|
| Claude Code, Cursor, opencode | `/unstale-review` |
| Codex | `$unstale-review` |

Use the same skill for your first review and later check-ins. It recommends where to start, respects prior decisions,
and can focus on a package, upgrade target, or capability you name.

`unstale uninstall` removes everything `init` wrote and backs up your decisions.

Matching runs on your machine: only public package identities (for example `pkg:npm/next`) are sent, to fetch the
signed catalog. Your code and paths never leave it; OSV receives package names and versions for advisory checks.
No telemetry.

This package is a small launcher; npm installs the native binary for your platform from one of the
`@unstale/cli-<platform>` packages. Supported ecosystems: npm and PyPI.

Documentation, evaluation results and source: [github.com/vuca-dev/unstale](https://github.com/vuca-dev/unstale).
Licensed under AGPL-3.0-only.
