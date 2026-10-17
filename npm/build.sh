#!/usr/bin/env bash
# Builds the release binary for each platform, copies it into that platform's package, and packs every npm package
# into npm/dist/. Publishes nothing.
#   npm/build.sh                     # every platform in TARGETS below
#   npm/build.sh darwin-arm64 ...    # only these platforms (the wrapper is always packed)
# darwin-* build with cargo (rustup targets aarch64-apple-darwin, x86_64-apple-darwin); linux-* (static musl) and
# win32-x64 (mingw) build with cargo-zigbuild and zig (`brew install zig`, `cargo install cargo-zigbuild`).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

# npm platform key -> Rust target triple. Keep in sync with PLATFORMS in unstale/bin/unstale.js and the wrapper's
# optionalDependencies.
declare -a KEYS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64)
triple() {
  case "$1" in
    darwin-arm64) echo aarch64-apple-darwin ;;
    darwin-x64) echo x86_64-apple-darwin ;;
    linux-x64) echo x86_64-unknown-linux-musl ;;
    linux-arm64) echo aarch64-unknown-linux-musl ;;
    win32-x64) echo x86_64-pc-windows-gnu ;;
    *) echo "unknown platform $1" >&2; return 1 ;;
  esac
}
[ $# -gt 0 ] && KEYS=("$@")

version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/local/cli/Cargo.toml" | head -1)"
v="$(node -p "require('$here/unstale/package.json').version")"
[ "$v" = "$version" ] || { echo "npm/unstale version $v != crate version $version" >&2; exit 1; }
# Every platform package, built or not, must match the crate version and be pinned by the wrapper.
for dir in "$here"/cli-*/; do
  key="$(basename "$dir")"; key="${key#cli-}"
  name="@unstale/cli-$key"
  v="$(node -p "require('$dir/package.json').version")"
  [ "$v" = "$version" ] || { echo "npm/cli-$key version $v != crate version $version" >&2; exit 1; }
  dep="$(node -p "(require('$here/unstale/package.json').optionalDependencies || {})['$name']")"
  [ "$dep" = "$version" ] || { echo "optionalDependencies pin for $name is $dep, not $version" >&2; exit 1; }
  grep -q "\"$key\": \"$name\"" "$here/unstale/bin/unstale.js" || { echo "$key missing from PLATFORMS in unstale.js" >&2; exit 1; }
done

rm -f "$here"/dist/*.tgz
# Every package ships the license (gitignored copies of the root LICENSE).
for dir in "$here"/unstale "$here"/cli-*; do cp "$root/LICENSE" "$dir/LICENSE"; done
mkdir -p "$here/dist"
for key in "${KEYS[@]}"; do
  t="$(triple "$key")"
  exe=unstale; [ "${key%%-*}" = win32 ] && exe=unstale.exe
  case "$key" in
    darwin-*) (cd "$root/local" && cargo build --release -p unstale --target "$t") ;;
    *) (cd "$root/local" && cargo zigbuild --release -p unstale --target "$t") ;;
  esac
  mkdir -p "$here/cli-$key/bin"
  cp "$root/local/target/$t/release/$exe" "$here/cli-$key/bin/$exe"
  chmod +x "$here/cli-$key/bin/$exe"
  file "$here/cli-$key/bin/$exe"
  (cd "$here/cli-$key" && npm pack --pack-destination "$here/dist")
done
(cd "$here/unstale" && npm pack --pack-destination "$here/dist")
ls -l "$here/dist"
