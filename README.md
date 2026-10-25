<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img alt="unstale" src="docs/assets/wordmark-light.svg" width="400">
  </picture>
</h1>

**You don't know what you don't know. Neither does your agent.**

Tells Claude Code, Codex, Cursor and opencode what changed upstream since their training cutoff that applies to your
code: new APIs worth adopting, breaking changes for your next major upgrade, deprecations, and the security and
performance fixes in each version bump.

**Does it work?** It finds 4x as many changes worth acting on as Claude Code alone, using 1/16 of the tokens ([how we measured](eval/beat-naive/RESULTS.md)). [Phoenix](https://github.com/Arize-ai/phoenix/pull/17150) and
[i18next](https://github.com/i18next/i18next/pull/2453) have merged fixes for what it found at their installed
versions, with no version bump for an update bot to raise. And it had
[Next.js 16.4.1's critical security fixes](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)
before the GitHub advisory database did.

## Quick start

In your repository:

```sh
npm init @unstale                # or: npx @unstale/cli init
```

To keep `unstale` on your PATH for the commands below:

```sh
npm install -g @unstale/cli      # or: brew install vuca-dev/tap/unstale
```

Building from source: [CONTRIBUTING.md](CONTRIBUTING.md).

Then, in your agent, inside that repository:

| Agent | Run |
|---|---|
| Claude Code, Cursor, opencode | `/unstale-onboarding`, `/unstale-upgrade-review`, `/unstale-improvements-pass` |
| Codex | `$unstale-onboarding`, `$unstale-upgrade-review`, `$unstale-improvements-pass` |

| Command | |
|---|---|
| `unstale status` | Refresh and print the summary (full evidence in `.unstale/onboarding-report.md`) |
| `unstale digest` | What each available version bump picks up |
| `unstale run` | Sync, digest, and prepare the next review batch for your agent |
| `unstale uninstall` | Remove the integration; your decisions are backed up |

## What you get

- **Upgrade reviews.** What your next major version requires, obligations first, located in your code.
- **Bump digests.** What each available version bump fixes, security advisories included, with no model calls.
- **Publisher deprecations.** Installed direct dependencies their publisher deprecated (npm) or yanked (PyPI), with
the registry's message, whether or not the catalog covers the package yet.
- **Lockfile advisories.** OSV advisories on every installed version, transitive ones included, grouped under the
direct dependency that pulls each in. Only those that call for action are shown; `unstale advisories` lists the rest.
- **New capabilities.** Features released since you wrote the code that could replace code you maintain.
- **A session-start line** in Claude Code when something new applies to your stack.

Every item cites its release note, migration guide, docs page or advisory. If nothing upstream matters to your code,
your agent hears nothing. Your agent proposes and you decide; decisions are remembered, so nothing is suggested twice.
Dependabot and Renovate say a new version exists; unstale says what it, and the ones you have not taken, mean for your
code.

## Works with

- **Agents:** Claude Code, Codex, Cursor, opencode
- **Ecosystems:** npm (TypeScript, JavaScript) and PyPI (Python). Lockfile-accurate versions from npm, pnpm, Yarn, uv,
Poetry, PDM and Pipenv. Any package in a supported ecosystem works with no per-package setup.

## How it works

```
 official sources            central (shared, once per change)          your machine (private)
 ───────────────             ─────────────────────────────────          ──────────────────────
 release notes      ──►      collect ► distill ► dedupe ► classify  ──► detect stack ► sync your shards
 migration guides            publish a versioned, verified catalog      match your code ► rank
 docs pages                                                             ► your coding agent
 security advisories
```

## Trust and privacy

- **What** `init` **writes.** `.unstale/` (configuration, decision ledger, reports), agent skills in `.claude/skills`
(Claude Code) and `.agents/skills` (Codex and Cursor; opencode reads both), whether or not each agent is installed,
and a Claude Code session-start hook in `.claude/settings.local.json` that prints one line. Personal mode, the
default, keeps all of it out of Git; shared mode (`unstale init --mode shared`) commits the ledger and skill files
and adds one line to `.gitattributes`. `unstale uninstall` removes all of it and backs up your decisions.
- **What leaves your machine.** Requests for catalog files, named by public package identity (`pkg:npm/next`), and
coverage requests for packages the catalog does not have yet. Your code, paths and versions do not. No telemetry.
The service, hosted on Cloudflare, sees your IP address. It keeps it in memory only, to apply rate limits and count
each address once per package, and never writes it to storage; there is no account or client ID.
The client also reads the public npm and PyPI registries for your direct packages at their installed versions, as a
package manager does, to check that a name is the public package and whether its publisher deprecated (npm) or
yanked (PyPI) that version. It sends the package names and versions its lockfiles resolve to OSV (`api.osv.dev`) for
advisories, as `npm audit` would.
- **Private packages stay private.** A package your lockfile installed from anywhere but the public registry, or one
your registry configuration points elsewhere, is never named to npm, PyPI, OSV or the coverage service.
`UNSTALE_NO_REGISTRY=1` turns off every third-party lookup.
  <details><summary>Which configuration it reads, and edge cases</summary>

  The client reads `.npmrc` (the repository's, nested ones and `~/.npmrc`), `NPM_CONFIG_*` variables, `.yarnrc.yml`
  `npmScopes` and `npmRegistryServer`, `bunfig.toml`, `pip.conf`, `PIP_INDEX_URL` and `PIP_EXTRA_INDEX_URL`,
  requirements index options, uv indexes and sources, and Poetry, PDM and Pipfile sources. A scoped private registry
  keeps that scope's packages to themselves; a registry that replaces the public one (an Artifactory or Nexus proxy)
  keeps every package of that ecosystem local. When you are logged in to npm itself (paid private packages are scoped
  and served from `registry.npmjs.org`), a scoped package reaches OSV only after an anonymous read of npm confirms it
  is public. Configuration in test, example and fixture directories applies to what only they declare, and public
  mirrors (npmmirror, the Tsinghua and Aliyun PyPI mirrors, PyTorch's index) count as public. With
  `UNSTALE_NO_REGISTRY=1` no new package is submitted for coverage (the status of packages already registered is
  still read from the coverage service).
  </details>
- **A signed catalog.** Catalog indexes carry an Ed25519 signature and name each shard's sha256; the client discards
anything that does not verify.
- **Upstream text is data.** Release notes and docs reach your agent as quoted, untrusted data, never as
instructions, and the review skills do not change code without your go-ahead.

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, tests and development scripts.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
