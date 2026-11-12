<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img alt="unstale" src="docs/assets/wordmark-light.svg" width="400">
  </picture>
</h1>

[![packages covered](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Funstale.sh%2Fstats.json&query=%24.packages&label=packages%20covered&color=blue)](https://unstale.sh/#packages)
[![changes indexed](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Funstale.sh%2Fstats.json&query=%24.changes&label=changes%20indexed&color=blue)](https://unstale.sh/#packages)
[![npm](https://img.shields.io/npm/v/@unstale/cli)](https://www.npmjs.com/package/@unstale/cli)
[![npm downloads](https://img.shields.io/npm/dm/@unstale/cli)](https://www.npmjs.com/package/@unstale/cli)

**You don't know what you don't know. Neither does your agent.**

unstale (`@unstale/cli`, [unstale.sh](https://unstale.sh)) monitors release notes, migration guides and security
advisories for the packages you use. It tells Claude Code, Codex, Cursor and opencode which changes apply to your
code. Your agent does not have to ask.

That covers new APIs worth adopting, the breaking changes that affect your code, what a dependency upgrade means for
it, deprecations, and the security and performance fixes in each version bump.

**Does it work?** It finds 4x as many upstream changes that apply to your code as Claude Code alone, and your agent
uses 1/16 of the tokens ([how we measured](eval/beat-naive/RESULTS.md)).
[Phoenix](https://github.com/Arize-ai/phoenix/pull/17150) and [i18next](https://github.com/i18next/i18next/pull/2453)
merged fixes for what it found at their installed versions.
An update bot had no version bump to raise. It also had
[Next.js 16.4.1's critical security fixes](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)
before the GitHub advisory database did.

## Quick start

Free and open source. No account.

In your repository:

```sh
npm init @unstale                # or: npx @unstale/cli init
```

To keep `unstale` on your PATH for the commands below:

```sh
npm install -g @unstale/cli      # or: brew install vuca-dev/tap/unstale
```

`init` asks once how to read new release notes and shows the cost first: about $0.05 a year per package on your own
key, nothing extra on a Codex plan, or free with less ([Reading new release notes](#reading-new-release-notes)).

Building from source: [CONTRIBUTING.md](CONTRIBUTING.md).

Then, in your agent, inside that repository:

| Agent | Run |
|---|---|
| Claude Code, Cursor, opencode | `/unstale-review` |
| Codex | `$unstale-review` |

Use the same skill for your first review and later check-ins. It recommends where to start, respects prior decisions,
and can focus on a package, upgrade target, or capability you name.

| Command | |
|---|---|
| `unstale status` | Refresh and print the summary (full evidence in `.unstale/onboarding-report.md`) |
| `unstale digest` | What each available version bump picks up |
| `unstale run` | Sync, digest, and prepare the next review batch for your agent |
| `unstale setup` | Change how new release notes are read |
| `unstale uninstall` | Remove the integration and back up your decisions |

## What you get

- **Upgrade reviews.** What your next major version requires, obligations first, located in your code.
- **Bump digests.** What each available version bump fixes, security advisories included, with no model calls.
- **Publisher deprecations.** Installed direct dependencies that their publisher deprecated (npm) or yanked (PyPI,
crates.io), with the registry's message. This works whether or not the catalog covers the package yet.
- **Lockfile advisories.** OSV advisories on every installed version, transitive ones included. Each one is grouped
under the direct dependency that pulls it in. Only advisories that call for action are shown. `unstale advisories`
lists the rest.
- **New capabilities.** Features released since you wrote the code that could replace code you maintain.
- **A session-start line** in Claude Code and Codex when new changes arrive for your stack.

Every item cites its release note, migration guide, docs page or advisory. If nothing upstream matters to your code,
your agent hears nothing. Your agent proposes changes and you decide. unstale remembers each decision, so it never
suggests the same thing twice.

Dependabot and Renovate tell you that a new version exists. unstale tells you what that version, and each one you have
not taken, means for your code. Docs MCPs return documentation when your agent asks for it. unstale tells your agent
about changes it would not know to ask about.

## Works with

- **Agents:** Claude Code, Codex, Cursor, opencode
- **Ecosystems:** npm (TypeScript, JavaScript), PyPI (Python) and crates.io (Rust). Versions come from your
lockfile: npm, pnpm, Yarn, uv, Poetry, PDM, Pipenv and Cargo. Any package in a supported ecosystem works with no
per-package setup. If the catalog does not cover a package yet, unstale queues it for coverage. `unstale status` shows
its progress.

## How it works

```
 official sources            central (shared)                           your machine (private)
 ───────────────             ────────────────                           ──────────────────────
 release notes      ──►      collect ► sign ► publish               ──► detect stack ► sync your shards
 migration guides            a versioned, verified catalog              read new release notes with a small model
 docs pages                                                             match your code ► rank
 security advisories                                                    ► your coding agent
```

## Reading new release notes

unstale reads new release notes with a small model, on the provider you choose. On your own API key that costs
about $0.05 a year per package (measured November 2026). On your Codex plan there is nothing extra to pay: it draws on
your plan, `unstale status` shows the usage, and it stops at the limit you set. The cost stays small because unstale
reads each release note once, only for the packages you use, and keeps every answer.

Or pay nothing: new releases then get advisories and deprecations only, ≈ 27% of the changes in new releases.

- The release-note text goes to that provider. Your code and file paths never do.
- Nothing is spent before you choose. `unstale init` asks once and shows this repository's yearly cost first.
- A monthly token limit stops the spending. You set it or remove it.

Every option, what it costs and what it gives up: [docs/reading-release-notes.md](docs/reading-release-notes.md).

## Trust and privacy

- **No install scripts.** The npm package is a launcher for a prebuilt binary. Each release is published from the
project's GitHub release workflow with npm provenance: `npm view @unstale/cli dist.attestations`.
- **What `init` writes.** `.unstale/`, the review skill in `.claude/skills` and `.agents/skills`, and session-start
hooks for Claude Code, Codex and opencode. `unstale uninstall` removes all of it and backs up your decisions.
- **What leaves your machine.** Public package names, to the unstale service. Package names and versions, to OSV, as
`npm audit` would. Release-note text, to the model provider you chose. Never your code or file paths.
- Private packages are never named to anyone. No account, no client ID, no client telemetry.
- The catalog is signed, and the client discards anything that does not verify. A catalog directory is the exception,
read only after your own `unstale init --catalog <dir>`.
- Upstream text reaches your agent as quoted data, and nothing in your code changes without your go-ahead.

Every file and request: [docs/privacy.md](docs/privacy.md). Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, tests and development scripts.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
