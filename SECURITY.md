# Security

## Reporting a vulnerability

Report it privately through [GitHub's vulnerability reporting](https://github.com/vuca-dev/unstale/security/advisories/new),
not in a public issue. You will get an acknowledgement within three working days and, once it is confirmed, a fix
timeline. Credit is given in the advisory unless you would rather not be named.

In scope: the `unstale` CLI and its npm and Homebrew packages, the catalog service in `central/`, and the public
gateway in `gateway/`. Only the latest release receives fixes.

## What the client does on your machine

In plainer words, with the registry edge cases: [docs/privacy.md](docs/privacy.md). The options for reading release
notes and their costs: [docs/reading-release-notes.md](docs/reading-release-notes.md).

- **Writes.** `unstale init` writes `.unstale/` (configuration, the decision ledger and reports), agent skills in
  `.claude/skills` and `.agents/skills`, and session-start hooks that Git ignores: `.claude/settings.local.json`
  (Claude Code), `.codex/hooks.json` (Codex, which runs it only once you trust it in `/hooks`) and
  `.opencode/plugins/unstale-session.js` (opencode). A hook is added to your file without changing the rest of it, and
  is skipped where the file is tracked, read-only or a link. Collaborative mode also adds one line to `.gitattributes`.
  `unstale uninstall` removes all of it and backs up your decisions outside the repository. `unstale setup --user`
  writes your choice of provider and token limit to `~/.config/unstale/config.json`.
- **Session start.** The hook checks whether the catalog changed and starts a background sync if it did. It gives up
  after 1.2 seconds, always exits 0 and prints at most one line. `"session_sync": false` in `.unstale/config.json`
  turns the sync off.
- **Model provider.** New release notes are read by a model on your own API key or your Codex plan, only after you
  choose one (`unstale setup`). Before that, unstale looks at names only: which known key variables are set in your
  shell and in this repository's `.env`, and whether `codex` is installed and logged in. It never opens another
  repository's `.env` or another tool's credential files. The choice stores the variable's name. The key is read when
  a request is built, goes only into that request's authorization header, and is written nowhere. Requests go to the
  chosen provider alone, over https, and a redirect is never followed. They carry public release-note text and the
  changes read from it: no code and no file paths. The provider can tell which packages' notes it was sent. A
  repository's config cannot name a key variable other than its provider's own, and can lower your monthly token
  limit but not raise it. With no provider chosen, no model is called.
- **Network.** The client fetches catalog files, named by public package identity such as `pkg:npm/next`, and asks
  for coverage of packages the catalog does not have yet. It sends no code, paths or versions, and no telemetry. It
  also reads the public npm, PyPI and crates.io registries for the direct packages it found, at their installed
  versions, as a package manager does: to verify a name is the public package, and to read a version's deprecation (npm)
  or yank (PyPI, crates.io). It sends every package name and version its lockfiles resolve, transitive ones included, to
  OSV (`api.osv.dev`) for advisories, as `npm audit` or `pip-audit` would; no source. A package installed from, or
  configured for, any registry but the public one (lockfile URLs; `.npmrc` including `~/.npmrc` and nested ones,
  `NPM_CONFIG_*`, `.yarnrc.yml`, `bunfig.toml`, pip, uv, Poetry, PDM and Pipfile indexes; Cargo `.cargo/config.toml`,
  `$CARGO_HOME` and `CARGO_*` sources and source replacements, and Cargo `[patch]` and `[replace]` entries) is never named to npm, PyPI, OSV, the coverage service
  or, when the catalog publishes no list of its technologies, the catalog host (`local/cli/src/privacy.rs`); a coverage
  job registered before a registry was configured for its package is dropped, not polled. With credentials for
  `registry.npmjs.org` configured, a scoped package is sent to OSV or the catalog host only once an anonymous read of
  npm confirms it public (paid private packages are scoped and served by npm itself, so that read tells npm nothing
  new). Known limits: a private registry configured outside these files (an npm `builtin` config, a tool's own settings
  store) is not seen; with a whole-registry proxy configured, nothing of that ecosystem is sent at all.
  `UNSTALE_NO_REGISTRY=1` turns off every third-party lookup (registry identity, deprecation and download reads, OSV);
  with no name verified as public, no new package is submitted for coverage, while the status of packages already
  registered is still read from the coverage service.
- **Catalog integrity.** Catalog indexes carry an Ed25519 signature and name each shard's sha256. Anything that does
  not verify is discarded, not used.
- **Upstream text.** Release notes, migration guides and docs are passed to your agent as quoted, untrusted data,
  never as instructions. The review skill tells the agent not to change code without your go-ahead.
