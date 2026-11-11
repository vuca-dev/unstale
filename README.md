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

Free and open source. No account.

In your repository:

```sh
npm init @unstale                # or: npx @unstale/cli init
```

To keep `unstale` on your PATH for the commands below:

```sh
npm install -g @unstale/cli      # or: brew install vuca-dev/tap/unstale
```

`init` asks once how new release notes should be read: on your own API key or your Codex plan, or not at all. It
shows what each option costs for this repository before anything is spent
([Reading new release notes](#reading-new-release-notes)).

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
| `unstale setup` | Choose how new release notes are read; `--details` prints the full costs, `--limit` sets the monthly token limit |
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
 release notes      ──►      collect ► sign ► publish a catalog:    ──► detect stack ► sync your shards
 migration guides            changes on file, new release notes         read new release notes (your key or plan)
 docs pages                                                             match your code ► rank
 security advisories                                                    ► your coding agent
```

## Reading new release notes

Changes already in the catalog are used as they are and cost you nothing. Release notes newer than that are read by a
model on your machine, on your own API key or your Codex plan. `unstale init` asks once which to use, with this
repository's yearly cost beside each option. `unstale setup` asks again.

| Read with | Needs | Cost per package, per year | Compared with the best option |
|---|---|---|---|
| Jev + an OpenAI-compatible key | `JEV_API_KEY` and a key from the third row | $0.036 | The best option |
| Jev + Codex plan | `JEV_API_KEY`, `codex login` | $0.018 + 170k Codex tokens | ≈ 80% of its changes |
| OpenAI, Vercel AI Gateway or OpenRouter key | `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY` or `OPENROUTER_API_KEY` | $0.064 | About as many breaking changes. ≈ 11 in 100 breaking-change flags wrong, against 8. ≈ 4 more changes listed twice |
| Codex plan | `codex login` | 650k Codex tokens (170k measured, the rest an estimate) | ≈ 80% of its changes. Wrong flags and repeats not measured yet |
| Anthropic key | `ANTHROPIC_API_KEY` | $0.075 | ≈ 90% of its changes, fewer from upgrade guides. ≈ 23 more changes listed twice |
| Not now | | Free | For new releases, security advisories and deprecations only: ≈ 27% of what unstale finds with a provider |

Jev is a labelling service, used beside the provider that reads the notes. Costs are estimates from
[evaluation runs](eval/edge-port/RESULTS.md), billed by the provider to your key or plan. An OpenAI key on a repository
where unstale follows 38 packages comes to ≈ $2.43 a year. The first sync is quoted at one more year's cost, once. That is a ceiling,
not a measurement. `unstale setup --details` prints every figure for your repository.

- **What the provider receives.** Public release-note text and the changes read from it. No code and no file paths.
The provider can tell which packages' notes it was sent. unstale finds keys by variable name, in your shell and this
repository's `.env`, and stores the name only. The key is read when a request is made and goes to that provider
alone.
- **When it runs.** In the background when an agent session starts, or when you run `unstale session-sync`.
`unstale sync` never calls a model. Each answer is kept, so nothing is paid for twice.
- **Limits.** Model work stops for the month at 48M tokens. `unstale setup --limit 10M` changes the limit and
`--limit none` removes it. The cache holds up to 100 MB (`UNSTALE_CACHE_MAX_MB` changes that). Answers you paid for
are never deleted to make room.
- **When something is wrong.** A rejected key, a provider that does not answer or a reached limit never fails a
command. unstale prints one `warning:` line with the fix, and `unstale status` shows the current state.
- **Team default.** In shared mode `.unstale/config.json` is committed. It names the provider and the key's variable,
so the team shares the choice and each person keeps their own key. `unstale setup --user` saves a choice for all your
repositories. A repository's own choice comes first.
- **Scripts and CI.** Nothing is asked without a terminal. `unstale setup --inference env:OPENAI_API_KEY` (or `codex`,
or `none`) records a choice. An agent is shown the same options and told to ask you.

## Trust and privacy

- **What** `init` **writes.** `.unstale/` holds configuration, the decision ledger and reports. Agent skills go in
`.claude/skills` (Claude Code) and `.agents/skills` (Codex and Cursor). opencode reads both. `init` writes the skills
whether or not each agent is installed. It also adds session-start hooks, which Git ignores in both modes:
`.claude/settings.local.json` (Claude Code), `.codex/hooks.json` (Codex, once you trust it in `/hooks`) and
`.opencode/plugins/unstale-session.js` (opencode). Your choice of provider goes in `.unstale/config.json`, or in
`~/.config/unstale/config.json` with `--user`. Personal mode, the default, keeps all of it out of Git. Shared mode
(`unstale init --mode shared`) commits the ledger and generated review context, and adds one line to `.gitattributes`.
`unstale uninstall` removes all of it and backs up your decisions.
- **Session start.** The hook checks whether the catalog changed. If it did, a background sync runs, then your
provider reads the new release notes. The hook gives up after 1.2 seconds, so it never holds up a session, and it
prints at most one line. `"session_sync": false` in `.unstale/config.json` turns the sync off.
- **What leaves your machine.** The client requests catalog files by public package identity (`pkg:npm/next`). It
also sends coverage requests for packages the catalog does not have yet. The unstale service never receives your
code, file paths or versions. No client telemetry. The service runs on Cloudflare and sees your IP address. The
service keeps the address in memory only, to apply rate limits and count each address once per package. It never
writes the address to storage. There is no account or client ID. The service keeps daily aggregate counts of
coverage-request outcomes for up to 90 UTC days. These counts hold no addresses, package lists or individual request
histories. They measure service demand, not people or installs. The client also reads the public npm, PyPI and
crates.io registries for your direct packages at their installed versions, as a package manager does. It checks that
each name is the public package, and whether its publisher deprecated (npm) or yanked (PyPI, crates.io) that version.
For advisories, the client sends the package names and versions that its lockfiles resolve to OSV (`api.osv.dev`), as
`npm audit` would. If you chose a provider, it receives public release-note text
([Reading new release notes](#reading-new-release-notes)).
- **Private packages stay private.** unstale never names a private package to npm, PyPI, crates.io, OSV or the coverage
service. A package is private if your lockfile installed it from anywhere but the public registry, or if your registry
configuration points elsewhere. `UNSTALE_NO_REGISTRY=1` turns off every third-party lookup.
  <details><summary>Which configuration it reads, and edge cases</summary>

  The client reads `.npmrc` (the repository's, nested ones and `~/.npmrc`), `NPM_CONFIG_*` variables, `.yarnrc.yml`
  `npmScopes` and `npmRegistryServer`, `bunfig.toml`, `pip.conf`, `PIP_INDEX_URL` and `PIP_EXTRA_INDEX_URL`,
  requirements index options, uv indexes and sources, Poetry, PDM and Pipfile sources, and Cargo's `.cargo/config.toml`
  (the repository's and `$CARGO_HOME`'s) and `CARGO_*` registry variables.

  A scoped private registry keeps that scope's packages local. A registry that replaces the public one, such as an
  Artifactory or Nexus proxy, keeps every package of that ecosystem local, as does any Cargo source replacement (`cargo
  vendor`'s included). Paid private npm packages are scoped and served from `registry.npmjs.org`. So when you are logged
  in to npm, a scoped package reaches OSV only after an anonymous read of npm confirms that it is public. Configuration
  in test, example and fixture directories applies only to the packages that those directories alone declare. Public
  mirrors count as public: npmmirror, the Tsinghua and Aliyun PyPI mirrors, and PyTorch's index. With
  `UNSTALE_NO_REGISTRY=1`, the client submits no new package for coverage. It still reads the coverage status of
  packages already registered.
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
