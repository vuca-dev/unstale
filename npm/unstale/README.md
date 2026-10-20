# @unstale/cli

**You don't know what you don't know. Neither does your agent.**

unstale reads the official release notes, migration guides, docs and security advisories of the packages you use,
distills each change once, and matches it against your code. Your coding agent (Claude Code, Codex or Cursor) then
knows what applies here: new APIs worth adopting, breaking changes for your next major upgrade, deprecations, and the
security and performance fixes in each version bump. Every item links to its source.

```sh
npx @unstale/cli init
```

Then, in your agent, inside that repository:

| Agent | Run |
|---|---|
| Claude Code, Cursor | `/unstale-onboarding`, `/unstale-upgrade-review`, `/unstale-improvements-pass` |
| Codex | `$unstale-onboarding`, `$unstale-upgrade-review`, `$unstale-improvements-pass` |

`unstale uninstall` removes everything `init` wrote and backs up your decisions.

Matching runs on your machine: only public package identities (for example `pkg:npm/next`) are sent, to fetch the
signed catalog. Your code, paths and versions never leave it, and there is no telemetry.

This package is a small launcher; npm installs the native binary for your platform from one of the
`@unstale/cli-<platform>` packages. Supported ecosystems: npm and PyPI.

Documentation, evaluation results and source: [github.com/vuca-dev/unstale](https://github.com/vuca-dev/unstale).
Licensed under AGPL-3.0-only.
