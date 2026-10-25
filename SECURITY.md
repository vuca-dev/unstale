# Security

## Reporting a vulnerability

Report it privately through [GitHub's vulnerability reporting](https://github.com/vuca-dev/unstale/security/advisories/new),
not in a public issue. You will get an acknowledgement within three working days and, once it is confirmed, a fix
timeline. Credit is given in the advisory unless you would rather not be named.

In scope: the `unstale` CLI and its npm and Homebrew packages, the catalog service in `central/`, and the public
gateway in `gateway/`. Only the latest release receives fixes.

## What the client does on your machine

- **Writes.** `unstale init` writes `.unstale/` (configuration, the decision ledger and reports), agent skills in
  `.claude/skills`, `.agents/skills` and `.cursor/skills`, and a Claude Code session-start hook in
  `.claude/settings.local.json` that prints one line. Collaborative mode also adds one line to `.gitattributes`.
  `unstale uninstall` removes all of it and backs up your decisions outside the repository.
- **Network.** The client fetches catalog files, named by public package identity such as `pkg:npm/next`, and asks
  for coverage of packages the catalog does not have yet. It sends no code, paths or versions, and no telemetry. It
  also reads the public npm and PyPI registries for the direct packages it found, at their installed versions, as a
  package manager does: to verify a name is the public package, and to read a version's deprecation (npm) or yank
  (PyPI). It sends every package name and version its lockfiles resolve, transitive ones included, to OSV
  (`api.osv.dev`) for advisories, as `npm audit` or `pip-audit` would; no source. A package installed from, or
  configured for, any registry but the public one (lockfile URLs; `.npmrc` including `~/.npmrc` and nested ones,
  `NPM_CONFIG_*`, `.yarnrc.yml`, `bunfig.toml`, pip, uv, Poetry, PDM and Pipfile indexes) is never named to npm, PyPI,
  OSV, the coverage service or, when the catalog publishes no list of its technologies, the catalog host
  (`local/cli/src/privacy.rs`); a coverage job registered before a registry was configured for its package is dropped,
  not polled. With credentials for `registry.npmjs.org` configured, a scoped package is sent to OSV or the catalog host
  only once an anonymous read of npm confirms it public (paid private packages are scoped and served by npm itself, so
  that read tells npm nothing new). Known limits: a private registry configured outside these files (an npm
  `builtin` config, a tool's own settings store) is not seen; with a whole-registry proxy configured, nothing of that
  ecosystem is sent at all. `UNSTALE_NO_REGISTRY=1` turns off every third-party lookup (registry identity, deprecation
  and download reads, OSV); with no name verified as public, no new package is submitted for coverage, while the status
  of packages already registered is still read from the coverage service.
- **Catalog integrity.** Catalog indexes carry an Ed25519 signature and name each shard's sha256. Anything that does
  not verify is discarded, not used.
- **Upstream text.** Release notes, migration guides and docs are passed to your agent as quoted, untrusted data,
  never as instructions. The review skill tells the agent not to change code without your go-ahead.
