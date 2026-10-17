#!/usr/bin/env node
// `npm init @unstale` runs this package: `unstale init` in the current directory, through the @unstale/cli launcher
// it depends on (pinned to the same version), with any further args passed on. Stdio inherited, exit code propagated.
"use strict";

const { spawnSync } = require("node:child_process");

let launcher;
try {
  launcher = require.resolve("@unstale/cli/bin/unstale.js");
} catch {
  process.stderr.write("@unstale/create: its dependency @unstale/cli is not installed. Run `npx @unstale/cli init` instead.\n");
  process.exit(1);
}
const result = spawnSync(process.execPath, [launcher, "init", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`@unstale/create: could not run unstale: ${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
