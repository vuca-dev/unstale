# npm channel (local rehearsal)

The npm install channel: per-platform packages so `npx @unstale/cli init` works, the biome/esbuild pattern. npm refuses the bare name `unstale` (too similar to
`install`), so the wrapper is `@unstale/cli`; its directory stays `unstale/`.

- `unstale/`: the wrapper package, `@unstale/cli`. `bin/unstale.js` resolves `@unstale/cli-<platform>-<arch>` (an
  optionalDependency), runs its `bin/unstale` with the same args and inherited stdio, and exits with its exit
  code (or re-raises its signal). A missing platform package is a clear error (exit 1). `UNSTALE_BINARY`
  overrides the binary path.
- `cli-<platform>/`: one package per target, `@unstale/cli-<platform>` with `os`/`cpu` set; `bin/unstale` (or
  `bin/unstale.exe`) is copied in by the build and is gitignored. Platforms: `darwin-arm64`, `darwin-x64`
  (cargo), `linux-x64`, `linux-arm64` (static musl, cargo-zigbuild + zig, so no glibc floor), `win32-x64`
  (`x86_64-pc-windows-gnu`, cargo-zigbuild).
- `build.sh [platform...]`: checks every package's version, the wrapper's optionalDependencies pin and the
  `PLATFORMS` map against `local/cli/Cargo.toml`, builds each target, copies the binary in, and `npm pack`s all
  into `npm/dist/` (gitignored). Needs `rustup target add` for each triple, `brew install zig` and
  `cargo install cargo-zigbuild`.
- `homebrew-formula.sh <dist dir> <homepage>`: prints the Homebrew formula for the crate version. It downloads the
  published `@unstale/cli-*` tarballs from the npm registry (sha256 from the local `.tgz`, which is what the registry
  serves), so a tap works while this repository is private and needs no second set of release assets. No Windows.
  Checked 16 October 2026: installed from a local tap with `brew install`, `brew test` and `brew style` clean.
- `create/`: `@unstale/create`, what `npm init @unstale` runs. `bin/create.js` runs `unstale init` through the
  `@unstale/cli` it depends on (pinned to the same version), passing on further args; published after the wrapper.
- `rehearse-npx.sh <scratch>`: `npx @unstale/cli` against a local Verdaccio on 127.0.0.1 only (no uplinks), with a
  fresh HOME and npm cache; transcript in commit c71e1fb.

Run so far (15 October 2026): darwin-arm64 natively, darwin-x64 under Rosetta, linux-arm64 and linux-x64 in Docker
(`redis:7-alpine` arm64, `alpine:3.20` amd64 under emulation), each `unstale --version`. win32-x64 is built and
checked with `file` only (unrun).

## Rehearsal (15 October 2026, macOS arm64, Node 26.8.1, npm 11.19.0)

```sh
npm/build.sh            # dist/unstale-cli-darwin-arm64-0.1.0.tgz (1.5 MB; 3.8 MB unpacked), dist/unstale-0.1.0.tgz (1.1 kB)

S=<scratch dir>
# Install the platform tarball explicitly: otherwise npm would fetch the optional dependency from the registry.
npm install -g --prefix $S/npm-prefix --cache $S/npm-cache --offline --no-audit --no-fund --loglevel http \
  npm/dist/unstale-cli-darwin-arm64-0.1.0.tgz npm/dist/unstale-0.1.0.tgz
# log shows only "npm http cache ...@file:... (cache hit)" lines; --offline would fail on any registry request

cp -cR ~/ati-slice0/e2e/next-prisma-app/repo $S/repo && cd $S/repo
export PATH=$S/npm-prefix/bin:$PATH UNSTALE_CACHE_DIR=$S/cache
which -a unstale        # only $S/npm-prefix/bin/unstale (a symlink to the wrapper), not ~/.cargo/bin
unstale --version
unstale init --catalog ~/unstale/.store/catalog --yes
unstale run
```

Transcript excerpt:

```
$ unstale --version
unstale 0.1.0
$ unstale init --catalog ~/unstale/.store/catalog --yes
Mode: personal (the default; no setup questions).
Initialised unstale in .../npm-rehearsal/repo (personal mode).
Stack: 1 package.json (1 application, 0 library), 119 npm packages; no supported Node range declared.
Next: `unstale run` (sync, digest, review).
$ unstale run
synced next: 470 records (sources checked 2026-10-15T06:57:24Z); 3 shard(s) downloaded, 0 reused
synced prisma: 247 records (sources checked 2026-10-15T06:57:25Z); 2 shard(s) downloaded, 0 reused
bumping next 16.2.1 → 16.4.1 picks up 30 security, 70 fixes, ... (`unstale bump next`); 34 obligations in the upgrade review
bumping prisma (@prisma/client, prisma) 6.19.3 → 7.10.0 picks up 6 security, 73 fixes, ... ; 65 obligations in the upgrade review
upgrade-review: batch 1 with 16 of 99 open records → .unstale/skills/upgrade-review/SKILL.md (written)
improvements-pass: batch 1 with 1 of 1 open records → .unstale/skills/improvements-pass/SKILL.md (written)
```

Also checked: `unstale bogus` through the wrapper exits 2 (the binary's usage code); installing the wrapper
alone with `--omit=optional` gives `unstale: the platform package @unstale/cli-darwin-arm64 is not installed. ...`
and exit 1.

### npx

`npx --offline unstale ...` with only `--prefix` fails with `ENOTCACHED` (it looks for `unstale` in the registry),
because npx checks the current project and the *configured* global prefix, which `--prefix` does not change. Offline
it works when the prefix is the configured global one, or after a project-local install:

```sh
npm_config_prefix=$S/npm-prefix npx --offline --cache $S/npm-cache unstale init --catalog ~/unstale/.store/catalog --yes
# or: npm install --offline <both tarballs> in a project, then: npx --offline unstale --version  -> unstale 0.1.0
```

Both ran `init` and `run` on a second fresh copy with the same output. The bare `npx unstale init` on a machine
without it installed needs the registry, so it can be rehearsed only after publishing.
