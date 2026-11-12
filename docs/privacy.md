# Privacy and what unstale writes

What `unstale init` writes, what leaves your machine and what does not. To report a vulnerability, see
[SECURITY.md](../SECURITY.md).

## What `init` writes

`.unstale/` holds configuration, the decision ledger and reports. Agent skills go in
`.claude/skills` (Claude Code) and `.agents/skills` (Codex and Cursor). opencode reads both. `init` writes the skills
whether or not each agent is installed. It also adds session-start hooks, which Git ignores in both modes:
`.claude/settings.local.json` (Claude Code), `.codex/hooks.json` (Codex, which runs it once you trust it in `/hooks`) and
`.opencode/plugins/unstale-session.js` (opencode). Your choice of provider goes in `.unstale/config.json`, or in
`~/.config/unstale/config.json` with `--user`. Personal mode, the default, keeps all of it out of Git. Shared mode
(`unstale init --mode shared`) commits the ledger and generated review context, and adds one line to `.gitattributes`.
`unstale uninstall` removes all of it and backs up your decisions.

## Session start

The hook checks whether the catalog changed. If it did, a background sync runs, then your
provider reads the new release notes. The hook gives up after 1.2 seconds, so it never holds up a session, and it
prints at most one line. `"session_sync": false` in `.unstale/config.json` turns the sync off.

## What leaves your machine

The client requests catalog files by public package identity (`pkg:npm/next`). It
also sends coverage requests for packages the catalog does not have yet. The unstale service never receives your
code, file paths or versions. No client telemetry. The service runs on Cloudflare and sees your IP address. The
service keeps the address in memory only, to apply rate limits and count each address once per package. It never
writes the address to storage. There is no account or client ID. The service keeps daily aggregate counts of
coverage-request outcomes for up to 90 UTC days. These counts hold no addresses, package lists or individual request
histories. They measure service demand, not people or installs. The client also reads the public npm, PyPI and
crates.io registries for your direct packages at their installed versions, as a package manager does. It checks that
each name is the public package, and whether its publisher deprecated (npm) or yanked (PyPI, crates.io) that version.
For advisories, the client sends the package names and versions that its lockfiles resolve to OSV (`api.osv.dev`), as
`npm audit` would. If you chose a model provider, it receives public release-note text and the changes read from it
([Reading new release notes](reading-release-notes.md)).

## Private packages stay private

unstale never names a private package to npm, PyPI, crates.io, OSV or the coverage
service. A package is private if your lockfile installed it from anywhere but the public registry, or if your registry
configuration points elsewhere. `UNSTALE_NO_REGISTRY=1` turns off every third-party lookup.
### Which configuration it reads, and edge cases

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

## A signed catalog

Catalog indexes carry an Ed25519 signature and name the sha256 of each shard. The client
discards anything that does not verify.

## Upstream text is data

Release notes and docs reach your agent as quoted, untrusted data, never as instructions.
The review skill does not change code without your go-ahead.
