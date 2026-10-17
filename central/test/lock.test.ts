// The per-technology write lock (lock.ts): one holder at a time across processes and call chains, re-entrant within a
// chain, a dead owner's lock taken over, a waiter that times out names the holder.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isStale, lockPath, LockTimeout, withTechLock, withTechLockSync } from "../src/pipeline/lock.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-lock-"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("technology lock", () => {
  test("two call chains never overlap; the lock is re-entrant within one chain and removed after", async () => {
    const log: string[] = [];
    const work = (name: string) =>
      withTechLock("next", name, async () => {
        log.push(`${name}+`);
        await withTechLock("next", `${name}-inner`, async () => sleep(30));
        log.push(`${name}-`);
      });
    await Promise.all([work("a"), work("b")]);
    expect(log.join(" ")).toMatch(/^(a\+ a- b\+ b-|b\+ b- a\+ a-)$/);
    expect(existsSync(lockPath("next"))).toBe(false);
    // Another technology is independent.
    await withTechLock("next", "x", () => withTechLock("prisma", "y", () => expect(existsSync(lockPath("next")) && existsSync(lockPath("prisma"))).toBe(true)));
  });

  test("a lock held by another live process blocks until it is released; a waiter times out naming the holder", async () => {
    const path = lockPath("nestjs");
    // A child process takes the lock file by hand (O_EXCL), holds it for a while, then removes it.
    const child = spawn(process.execPath, ["-e", `
      const fs = require("fs");
      const fd = fs.openSync(${JSON.stringify(path)}, "wx");
      const started = new Date(Date.now() - process.uptime() * 1000).toISOString();
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, started, holder: "child", at: new Date().toISOString() }));
      fs.closeSync(fd);
      console.log("held");
      setTimeout(() => { fs.unlinkSync(${JSON.stringify(path)}); process.exit(0); }, 1500);
    `]);
    await new Promise<void>((res) => child.stdout.once("data", () => res()));
    await expect(withTechLock("nestjs", "test", () => 1, { timeoutMs: 300 })).rejects.toThrow(/locked by pid \d+ \(child/);
    expect(() => withTechLockSync("nestjs", "test", () => 1, { timeoutMs: 300 })).toThrow(LockTimeout);
    const t0 = Date.now();
    expect(await withTechLock("nestjs", "test", () => 2, { timeoutMs: 10_000 })).toBe(2);
    expect(Date.now() - t0).toBeGreaterThan(500);
  });

  test("a stale lock (dead pid, or a reused pid with another start time) is taken over", async () => {
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    const pid = Number(dead.stdout.trim());
    mkdirSync(join(process.env.UNSTALE_CENTRAL_DIR!, "records"), { recursive: true });
    writeFileSync(lockPath("next"), JSON.stringify({ pid, started: new Date().toISOString(), holder: "crashed", at: new Date().toISOString() }));
    expect(isStale({ pid, started: new Date().toISOString(), holder: "crashed", at: "" })).toBe(true);
    expect(await withTechLock("next", "test", () => readFileSync(lockPath("next"), "utf8"), { timeoutMs: 1000 })).toContain(`"pid":${process.pid}`);
    // Our parent is alive but started long before 2000: a reused pid, so stale.
    expect(isStale({ pid: process.ppid, started: "2000-01-01T00:00:00Z", holder: "old", at: "" })).toBe(true);
    expect(isStale({ pid: process.ppid, started: "garbage", holder: "x", at: "" })).toBe(false);
  });
});
