# @unstale/cli

unstale (`@unstale/cli`, [unstale.sh](https://unstale.sh)) shows your coding agent what a dependency upgrade means
for your code. It reads the official release notes, migration guides, docs and security advisories of the packages
you use and matches each change against your code, at your installed versions: the breaking changes that affect your
code, new APIs worth adopting, deprecations, and the security and performance fixes in each version bump. It works
with Claude Code, Codex, Cursor and opencode, and every item links to its source.

Two projects merged fixes for what unstale found at their installed versions:
[Phoenix](https://github.com/Arize-ai/phoenix/pull/17150) replaced deprecated AI SDK calls, and
[i18next](https://github.com/i18next/i18next/pull/2453) fixed a test that was not checking its call count. In our own
comparison it finds 4x as many upstream changes that apply to your code as Claude Code alone, and your agent uses 1/16
of the tokens ([how we measured](https://github.com/vuca-dev/unstale/blob/main/eval/beat-naive/RESULTS.md)).

| | What it does |
|---|---|
| Update bot | Tells you a new version exists |
| Docs lookup | Returns documentation when your agent asks |
| unstale | Finds changes that apply at your installed version, no version bump needed, and tells your agent unasked |

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

unstale reads new release notes with a small model, on the provider you choose: about $0.05 a year per package on
your own API key (measured November 2026), nothing extra on your Codex plan, which stops at the limit you set. The
cost stays small because each release note is read once, only for the packages you use, and every answer is kept.
`init` asks once and shows your repository's cost first. Or pay nothing for publisher
deprecations, unmaintained packages and security advisories: about 27% of what a full report finds
([every option](https://github.com/vuca-dev/unstale/blob/main/docs/reading-release-notes.md)).

## Safe to try

- **No install scripts.** The npm package is a launcher for a prebuilt binary. Each release is published from the
project's GitHub release workflow with npm provenance: `npm view @unstale/cli dist.attestations`.
- **What `init` writes.** `.unstale/`, the review skill in `.claude/skills` and `.agents/skills`, and session-start
hooks for Claude Code, Codex and opencode. `unstale uninstall` removes all of it and backs up your decisions.
- **What leaves your machine.** Public package names, to the unstale service. Package names and versions, to OSV, as
`npm audit` would. Release-note text, to the model provider you chose. Never your code or file paths.

More: [privacy](https://github.com/vuca-dev/unstale/blob/main/docs/privacy.md) and
[security](https://github.com/vuca-dev/unstale/blob/main/SECURITY.md).

This package is a small launcher; npm installs the native binary for your platform from one of the
`@unstale/cli-<platform>` packages. Supported ecosystems: npm, PyPI and crates.io.

Documentation, evaluation results and source: [github.com/vuca-dev/unstale](https://github.com/vuca-dev/unstale).
Licensed under AGPL-3.0-only.
