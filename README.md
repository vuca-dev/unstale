# unstale

**Everything that changed past your coding agent's knowledge cutoff.**

Teams ship faster than ever, and so does every framework, SDK and platform they depend on. Nobody can read all the
release notes, migration guides and docs changes, and your coding agent was trained before most of them existed.

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
- **Ambient awareness.** One line at the start of an agent session when something new lands for your stack
(Claude Code).
- **An instant first report.** Your stack, upgrades and a shortlist of relevant capabilities, seconds after
`init`.

## Quick start

In your repository:

```sh
npx @unstale/cli init            # or, from 0.1.1: npm init @unstale
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

## Proven on real upgrades

We replay 15 real major upgrades in open-source projects (Next.js 16, Prisma 7, NestJS 12), starting from the commit
before the maintainers upgraded, and compare what unstale gives the agent with the changes the maintainers had to make.

- **It finds what upstream documents.** The maintainers made 94 required changes. 29 could not come from any upstream
  source: 17 are follow-on edits to their own tests, CI and Docker files, and 12 appear in no release note, guide or
  doc (workarounds for open bugs, undocumented internal types). Of the 65 that official sources do document, the
  catalog covers **60**.
- **The important ones come first.** A major upgrade's review runs to dozens of items. The first batch of 16 your
  agent works through holds **34 of those 60**: breaking changes first, then by how your code uses each one.

Every ranking change is pre-registered and must hold on upgrades never used for tuning.
Method and results: [`eval/`](eval/gate/MISSES.md).

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

- **What** `init` **writes.** `.unstale/` (configuration, decision ledger, reports), agent skills in `.claude/skills`,
`.agents/skills` and `.cursor/skills`, and a Claude Code session-start hook in `.claude/settings.local.json` that
prints one line. Collaborative mode also adds one line to `.gitattributes`. `unstale uninstall` removes all of it
and backs up your decisions.
- **What leaves your machine.** Requests for catalog files, named by public package identity (`pkg:npm/next`), and
coverage requests for packages the catalog does not have yet. Your code, paths and versions do not. No telemetry.
- **A signed catalog.** Catalog indexes carry an Ed25519 signature and name each shard's sha256; the client discards
anything that does not verify.
- **Upstream text is data.** Release notes and docs reach your agent as quoted, untrusted data, never as
instructions, and the review skills do not change code without your go-ahead.

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, tests and development scripts.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
