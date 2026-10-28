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

unstale monitors release notes, migration guides and security advisories for the packages you use. It tells Claude
Code, Codex, Cursor and opencode which changes apply to your code. Your agent does not have to ask.

That covers new APIs worth adopting, breaking changes in your next major upgrade, deprecations, and the security and
performance fixes in each version bump.

**Does it work?** It finds 4x as many upstream changes that apply to your code as Claude Code alone, using 1/16 of the
tokens ([how we measured](eval/beat-naive/RESULTS.md)). [Phoenix](https://github.com/Arize-ai/phoenix/pull/17150) and
[i18next](https://github.com/i18next/i18next/pull/2453) merged fixes for what it found at their installed versions.
An update bot had no version bump to raise. It also had
[Next.js 16.4.1's critical security fixes](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)
before the GitHub advisory database did.

## Quick start

Free and open source. No account or API key.

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
| Claude Code, Cursor, opencode | `/unstale-review` |
| Codex | `$unstale-review` |

Use the same skill for your first review and later check-ins. It recommends where to start, respects prior decisions,
and can focus on a package, upgrade target, or capability you name.

| Command | |
|---|---|
| `unstale status` | Refresh and print the summary (full evidence in `.unstale/onboarding-report.md`) |
| `unstale digest` | What each available version bump picks up |
| `unstale run` | Sync, digest, and prepare the next review batch for your agent |
| `unstale uninstall` | Remove the integration and back up your decisions |

## What you get

- **Upgrade reviews.** What your next major version requires, obligations first, located in your code.
- **Bump digests.** What each available version bump fixes, security advisories included, with no model calls.
- **Publisher deprecations.** Installed direct dependencies that their publisher deprecated (npm) or yanked (PyPI),
with the registry's message. This works whether or not the catalog covers the package yet.
- **Lockfile advisories.** OSV advisories on every installed version, transitive ones included. Each one is grouped
under the direct dependency that pulls it in. Only advisories that call for action are shown. `unstale advisories`
lists the rest.
- **New capabilities.** Features released since you wrote the code that could replace code you maintain.
- **A session-start line** in Claude Code when something new applies to your stack.

Every item cites its release note, migration guide, docs page or advisory. If nothing upstream matters to your code,
your agent hears nothing. Your agent proposes changes and you decide. unstale remembers each decision, so it never
suggests the same thing twice.

Dependabot and Renovate tell you that a new version exists. unstale tells you what that version, and each one you have
not taken, means for your code. Docs MCPs return documentation when your agent asks for it. unstale tells your agent
about changes it would not know to ask about.

## Works with

- **Agents:** Claude Code, Codex, Cursor, opencode
- **Ecosystems:** npm (TypeScript, JavaScript) and PyPI (Python). Versions come from your lockfile: npm, pnpm, Yarn,
uv, Poetry, PDM and Pipenv. Any package in a supported ecosystem works with no per-package setup. If the catalog does
not cover a package yet, unstale queues it for coverage. `unstale status` shows its progress.

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

- **What** `init` **writes.** `.unstale/` holds configuration, the decision ledger and reports. Agent skills go in
`.claude/skills` (Claude Code) and `.agents/skills` (Codex and Cursor). opencode reads both. `init` writes the skills
whether or not each agent is installed. It also adds a Claude Code session-start hook in `.claude/settings.local.json`
that prints one line. Personal mode, the default, keeps all of it out of Git. Shared mode
(`unstale init --mode shared`) commits the ledger and generated review context, and adds one line to `.gitattributes`.
`unstale uninstall` removes all of it and backs up your decisions.
- **What leaves your machine.** The client requests catalog files by public package identity (`pkg:npm/next`). It
also sends coverage requests for packages the catalog does not have yet. The unstale service never receives your
code, file paths or versions. No client telemetry. The service runs on Cloudflare and sees your IP address. The
service keeps the address in memory only, to apply rate limits and count each address once per package. It never
writes the address to storage. There is no account or client ID. The service keeps daily aggregate counts of
coverage-request outcomes for up to 90 UTC days. These counts hold no addresses, package lists or individual request
histories. They measure service demand, not people or installs. The client also reads the public npm and PyPI
registries for your direct packages at their installed versions, as a package manager does. It checks that each name
is the public package, and whether its publisher deprecated (npm) or yanked (PyPI) that version. For advisories, the
client sends the package names and versions that its lockfiles resolve to OSV (`api.osv.dev`), as `npm audit` would.
- **Private packages stay private.** unstale never names a private package to npm, PyPI, OSV or the coverage service.
A package is private if your lockfile installed it from anywhere but the public registry, or if your registry
configuration points elsewhere. `UNSTALE_NO_REGISTRY=1` turns off every third-party lookup.
  <details><summary>Which configuration it reads, and edge cases</summary>

  The client reads `.npmrc` (the repository's, nested ones and `~/.npmrc`), `NPM_CONFIG_*` variables, `.yarnrc.yml`
  `npmScopes` and `npmRegistryServer`, `bunfig.toml`, `pip.conf`, `PIP_INDEX_URL` and `PIP_EXTRA_INDEX_URL`,
  requirements index options, uv indexes and sources, and Poetry, PDM and Pipfile sources.

  A scoped private registry keeps that scope's packages local. A registry that replaces the public one, such as an
  Artifactory or Nexus proxy, keeps every package of that ecosystem local. Paid private npm packages are scoped and
  served from `registry.npmjs.org`. So when you are logged in to npm, a scoped package reaches OSV only after an
  anonymous read of npm confirms that it is public. Configuration in test, example and fixture directories applies only
  to the packages that those directories alone declare. Public mirrors count as public: npmmirror, the Tsinghua and
  Aliyun PyPI mirrors, and PyTorch's index. With `UNSTALE_NO_REGISTRY=1`, the client submits no new package for
  coverage. It still reads the coverage status of packages already registered.
  </details>
- **A signed catalog.** Catalog indexes carry an Ed25519 signature and name the sha256 of each shard. The client
discards anything that does not verify.
- **Upstream text is data.** Release notes and docs reach your agent as quoted, untrusted data, never as instructions.
The review skill does not change code without your go-ahead.

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, tests and development scripts.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
