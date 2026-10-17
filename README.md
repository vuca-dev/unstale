# unstale

**Everything that changed past your coding agent's knowledge cutoff.**

Teams ship faster than ever, and so does every framework, SDK and platform they depend on. Nobody can read all the
release notes, migration guides and docs changes, and your coding agent was trained before most of them existed.

unstale monitors official upstream sources, distills each change once, and intersects it with *your* repository. Your
coding agent (Claude Code, Codex, Cursor) then knows exactly what changed that matters here, and nothing else.

> Pre-release: build from source for now. `npx unstale init` arrives with the first release.

## Why unstale

- **Context-efficient by design.** Changes are distilled centrally, once, for everyone. Your agent receives a small,
  ranked batch for your stack, not a pile of changelogs to read.
- **Repo-aware.** It reads your manifests, lockfiles and code, and ranks each change by where your code actually uses
  it.
- **Source-cited.** Every item links to the release note, migration guide, docs page or security advisory it came from.
  No blog takes, no guesswork.
- **Zero noise is a valid answer.** If nothing upstream matters to your code, you hear nothing.
- **Private.** Matching runs on your machine. Your code, paths and versions never leave it.
- **No surprise edits.** Your agent proposes, you decide. Decisions are remembered, so nothing is suggested twice.

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

```sh
git clone https://github.com/jasontd92/unstale && cd unstale
scripts/prepare-dogfood.sh                         # build, install locally, start the catalog service
.dev/npm/bin/unstale -C /path/to/your/repo init
```

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

We replay real major upgrades in open-source repositories (Next.js 16, Prisma 7, NestJS 12), starting from the commit
before the maintainers upgraded, and score unstale against the changes they actually had to make.

- The catalog covers **94 of the 158** changes the maintainers made.
- **58** of those are in the **first batch of 16** your agent sees.
- Ranking by your code's usage roughly **doubles** first-batch hits over unranked lists.

Every ranking change is pre-registered and must hold on upgrades never used for tuning.
Method and results: [`eval/`](eval/rank/RESULTS.md).

## How it works

```
 official sources            central (shared, once per change)          your machine (private)
 ───────────────             ─────────────────────────────────          ──────────────────────
 release notes      ──►      collect ► distill ► dedupe ► classify  ──► detect stack ► sync your shards
 migration guides            publish a versioned, verified catalog      match your code ► rank
 docs pages                                                             ► your coding agent
 security advisories
```

Only the public identity of a package (for example `pkg:npm/next`) is ever sent, and only to request coverage for it.
There is no telemetry.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, tests and development scripts.

## License

To be announced before the public release.
