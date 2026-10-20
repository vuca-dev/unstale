# unstale

**You don't know what you don't know. Neither does your agent.**

unstale keeps up with your dependencies for you. It finds the breaking changes, fixes and new APIs that touch your
code, so your agent can use them. Most of those changes shipped after your agent's knowledge cutoff.

**Recent catches:** unstale flagged critical [Next.js security fixes](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)
before the GitHub advisory database had them, and caught Supabase's Next.js auth blocks breaking on Next.js 16. Its
fix for a deprecated AI SDK call in fumadocs was merged within a day.

unstale reads the official release notes, migration guides, docs and security advisories of the packages you use,
distills each change once, and matches it against *your* code. Your coding agent (Claude Code, Codex or Cursor) then
knows what applies here: new APIs worth adopting, breaking changes for your next major upgrade, deprecations, and the
security and performance fixes in each version bump. Nothing else.

## Why unstale

- **Context-efficient by design.** Changes are distilled centrally, once, for everyone. Your agent receives a small,
ranked batch for your stack, not a pile of changelogs to read.
- **Repo-aware.** It reads your manifests, lockfiles and code, and ranks each change by where your code actually uses
it.
- **Source-cited.** Every item links to the release note, migration guide, docs page or security advisory it came from.
No blog takes, no guesswork.
- **Zero noise is a valid answer.** If nothing upstream matters to your code, your agents hear nothing.
- **Private.** Matching runs on your machine. Your code, paths and versions never leave it.
- **No surprise edits.** Your agent proposes, you decide. Decisions are remembered, so nothing is suggested twice.
- **Alongside your update bot, not instead of it.** Dependabot and Renovate tell you a new version exists. unstale
tells your agent what that version, and the ones you have not taken yet, mean for your code.

## What you get

- **Upgrade reviews.** What you must change to move to the next major version, obligations first, located in your
code.
- **New capabilities.** Framework features released since you wrote the code that could replace custom code, each
with its stated benefit.
- **Bump digests.** What a version bump actually fixes, including security advisories, with no model calls at all.
- **Publisher deprecations.** An installed version of a direct dependency that its publisher deprecated on npm or
yanked on PyPI, with the registry's message, whether or not the catalog covers the package yet.
- **Lockfile advisories.** OSV advisories on every version your lockfiles install, transitive ones included, grouped
under the direct dependency that pulls each in, one line per dependency, the worst ten shown (`unstale advisories`
lists the rest). Only what calls for action counts: critical or high at runtime, moderate at runtime when your
ranges, pins or overrides block the fix or it is new on a direct dependency, and critical development-only packages
with no fix the ranges admit. Low, unrated and other development-only advisories are counted, not shown.
- **Ambient awareness.** One line at the start of an agent session when something new lands for your stack
(Claude Code).
- **An instant first report.** Your stack, upgrades and a shortlist of relevant capabilities, seconds after
`init`.

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
| Claude Code, Cursor | `/unstale-onboarding`, `/unstale-upgrade-review`, `/unstale-improvements-pass` |
| Codex | `$unstale-onboarding`, `$unstale-upgrade-review`, `$unstale-improvements-pass` |

| Command | |
|---|---|
| `unstale status` | Refresh and print the summary (full evidence in `.unstale/onboarding-report.md`) |
| `unstale digest` | What each available version bump picks up |
| `unstale run` | Sync, digest, and prepare the next review batch for your agent |
| `unstale uninstall` | Remove the integration; your decisions are backed up |

## Works with

- **Agents:** Claude Code, Codex, Cursor
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
(Claude Code) and `.agents/skills` (Codex and Cursor), whether or not each agent is installed, and a Claude Code
session-start hook in `.claude/settings.local.json` that prints one line. Personal mode, the default, keeps all of it
out of Git; shared mode (`unstale init --mode shared`) commits the ledger and skill files and adds one line to
`.gitattributes`. `unstale uninstall` removes all of it and backs up your decisions.
- **What leaves your machine.** Requests for catalog files, named by public package identity (`pkg:npm/next`), and
coverage requests for packages the catalog does not have yet. Your code, paths and versions do not. No telemetry.
The service, hosted on Cloudflare, sees your IP address. It keeps it in memory only, to apply rate limits and count
each address once per package, and never writes it to storage; there is no account or client ID.
The client also reads the public npm and PyPI registries for your direct packages at their installed versions, as a
package manager does, to check that a name is the public package and whether its publisher deprecated (npm) or
yanked (PyPI) that version. It sends the package names and versions its lockfiles resolve to OSV (`api.osv.dev`) for
advisories, as `npm audit` would.
- **Private packages stay private.** A package your lockfile installed from anywhere but the public registry, or one
your registry configuration points elsewhere, is never named to npm, PyPI, OSV or the coverage service. The client
reads `.npmrc` (the repository's, nested ones and `~/.npmrc`), `NPM_CONFIG_*` variables, `.yarnrc.yml` `npmScopes`
and `npmRegistryServer`, `bunfig.toml`, `pip.conf`, `PIP_INDEX_URL` and `PIP_EXTRA_INDEX_URL`, requirements index
options, uv indexes and sources, and Poetry, PDM and Pipfile sources. A scoped private registry keeps that scope's
packages to themselves; a registry that replaces the public one (an Artifactory or Nexus proxy) keeps every package
of that ecosystem local. When you are logged in to npm itself (paid private packages are scoped and served from
`registry.npmjs.org`), a scoped package reaches OSV only after an anonymous read of npm confirms it is public; that
read goes to npm, which serves the package already. Configuration in test, example and fixture directories applies to
what only they declare, and public mirrors (npmmirror, the Tsinghua and Aliyun PyPI mirrors, PyTorch's index) count as
public. `UNSTALE_NO_REGISTRY=1` turns off every third-party lookup: no npm, PyPI or OSV request, so no new package is
submitted for coverage (the status of packages already registered is still read from the coverage service).
- **A signed catalog.** Catalog indexes carry an Ed25519 signature and name each shard's sha256; the client discards
anything that does not verify.
- **Upstream text is data.** Release notes and docs reach your agent as quoted, untrusted data, never as
instructions, and the review skills do not change code without your go-ahead.

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, tests and development scripts.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
