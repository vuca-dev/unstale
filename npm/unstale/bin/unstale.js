#!/usr/bin/env node
// Launcher for the unstale native binary (npm with per-platform packages, the biome/esbuild pattern). Resolves the
// platform package installed through optionalDependencies and execs its binary with the same args, stdio inherited,
// exit code propagated.
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const PLATFORMS = {
  "darwin-arm64": "@unstale/cli-darwin-arm64",
  "darwin-x64": "@unstale/cli-darwin-x64",
  "linux-arm64": "@unstale/cli-linux-arm64",
  "linux-x64": "@unstale/cli-linux-x64",
  "win32-x64": "@unstale/cli-win32-x64",
};

function binaryPath() {
  if (process.env.UNSTALE_BINARY) return process.env.UNSTALE_BINARY;
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORMS[key];
  if (!pkg) {
    fail(
      `unstale: no prebuilt binary for ${key}. Supported: ${Object.keys(PLATFORMS).join(", ")}.\n` +
        `Build from source with cargo, or set UNSTALE_BINARY to a binary path.`
    );
  }
  try {
    const manifest = require.resolve(`${pkg}/package.json`);
    return path.join(path.dirname(manifest), "bin", process.platform === "win32" ? "unstale.exe" : "unstale");
  } catch {
    fail(
      `unstale: the platform package ${pkg} is not installed.\n` +
        `It is an optional dependency of unstale; reinstall without --no-optional / --omit=optional,\n` +
        `or install it directly: npm install ${pkg}`
    );
  }
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

const bin = binaryPath();
const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  fail(`unstale: could not run ${bin}: ${result.error.message}`);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
