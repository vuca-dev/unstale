# Security

## Reporting a vulnerability

Report it privately through [GitHub's vulnerability reporting](https://github.com/vuca-dev/unstale/security/advisories/new),
not in a public issue. You will get an acknowledgement within three working days and, once it is confirmed, a fix
timeline. Credit is given in the advisory unless you would rather not be named.

In scope: the `unstale` CLI and its npm and Homebrew distribution packages, including its Cargo ecosystem integration, the
catalog service in `central/`, and the public gateway in `gateway/`. Only the latest release receives fixes.

## What the client does on your machine

- **Writes.** `unstale init` writes `.unstale/` (configuration, the decision ledger and reports), agent skills in
  `.claude/skills`, `.agents/skills` and `.cursor/skills`, and a Claude Code session-start hook in
  `.claude/settings.local.json` that prints one line. Collaborative mode also adds one line to `.gitattributes`.
  `unstale uninstall` removes all of it and backs up your decisions outside the repository.
- **Network.** The client fetches catalog files, named by public package identity such as `pkg:npm/next`, and asks
  for coverage of packages the catalog does not have yet. It sends no code or paths, and no telemetry. It reads the
  public npm, PyPI and crates.io registries for direct packages at their installed versions to verify public identity
  and read publisher deprecation/yank status. Package names and versions from public lockfile sources, including
  transitive dependencies, are sent to OSV (`api.osv.dev`) for advisories; no source or paths are sent. Cargo advisory
  results come from OSV and are not a claim of `cargo-audit` parity. Packages resolved from another registry, git or
  path sources are not named to those services. Cargo source/index replacements in recognized `.cargo/config[.toml]`
  files, `CARGO_HOME` and supported environment settings fail closed for Cargo lookups. The corresponding npm/PyPI
  settings (`.npmrc` including `~/.npmrc` and nested ones, `NPM_CONFIG_*`, `.yarnrc.yml`, `bunfig.toml`, pip, uv,
  Poetry, PDM and Pipfile indexes) likewise prevent those package names from being sent to third parties
  (`local/cli/src/privacy.rs`); a coverage job registered before a registry was configured for its package is dropped,
  not polled. With credentials for `registry.npmjs.org` configured, a scoped package is sent to OSV or the catalog host
  only once an anonymous read of npm confirms it public (paid private packages are scoped and served by npm itself, so
  that read tells npm nothing new). Known limits: settings held only in a tool's private settings store, and Cargo
  `--config` options used only during an earlier dependency-resolution command, are not observable later; use
  `UNSTALE_NO_REGISTRY=1` if those settings may redirect a registry. A whole-registry proxy blocks that ecosystem's
  lookups. `UNSTALE_NO_REGISTRY=1` turns off every third-party lookup (registry identity, deprecation and download
  reads, OSV); with no name verified as public, no new package is submitted for coverage, while the status of packages
  already registered is still read from the coverage service.
- **Catalog integrity.** Catalog indexes carry an Ed25519 signature and name each shard's sha256. Anything that does
  not verify is discarded, not used.
- **Upstream text.** Release notes, migration guides and docs are passed to your agent as quoted, untrusted data,
  never as instructions. The review skill tells the agent not to change code without your go-ahead.
