// One writer per technology. Every step that loads a technology's store, changes it and publishes it (the pipeline, the
// advisories stage, manual catalog actions, the onboarding service) holds this lock from the load to the publish, so
// two processes never overwrite each other's records. The lock is a file next to the store, `records/<tech>.lock`,
// created with O_EXCL and holding the owner's pid and start time. It is stale when that process is gone (or the pid now
// belongs to a newer process). Waiters poll until a timeout (`UNSTALE_LOCK_TIMEOUT_MS`, default 20 minutes) and then
// fail with a message naming the holder. Re-entrant within one async call chain (a held lock is not taken again by the
// code it wraps); a second chain in the same process waits like any other process.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { centralDir } from "./paths.ts";

export interface LockInfo {
  pid: number;
  /** The owner's process start time (ISO), so a reused pid is not mistaken for the owner. */
  started: string;
  /** What holds it: "pipeline", "advisories", "correct", "onboarding", ... */
  holder: string;
  /** When it was taken (ISO). */
  at: string;
}

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const STARTED = new Date(Date.now() - process.uptime() * 1000).toISOString();
const POLL_MS = 250;

export const lockPath = (tech: string): string => join(centralDir(), "records", `${tech}.lock`);
const timeoutMs = (): number => Number(process.env.UNSTALE_LOCK_TIMEOUT_MS ?? 20 * 60 * 1000);

/** The start time of a live process, or undefined when it cannot be read (then the pid is taken as the owner). */
function processStart(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a lock's owner is gone: the pid is dead, or alive but started at another time (a reused pid). */
export function isStale(info: LockInfo): boolean {
  if (info.pid === process.pid) return Math.abs(Date.parse(info.started) - Date.parse(STARTED)) > 5000;
  try {
    process.kill(info.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  const s = processStart(info.pid);
  return s !== undefined && Number.isFinite(Date.parse(info.started)) && Math.abs(s - Date.parse(info.started)) > 5000;
}

function readLock(path: string): { info?: LockInfo; text: string; age: number } | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const age = Date.now() - statSync(path).mtimeMs;
    try {
      return { info: JSON.parse(text) as LockInfo, text, age };
    } catch {
      return { text, age };
    }
  } catch {
    return undefined;
  }
}

/** One attempt: true when taken. A stale lock (or one left unreadable for 30 s) is removed first. */
function tryAcquire(tech: string, holder: string): { ok: true } | { ok: false; owner?: LockInfo } {
  const path = lockPath(tech);
  mkdirSync(dirname(path), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx");
      const info: LockInfo = { pid: process.pid, started: STARTED, holder, at: new Date().toISOString() };
      writeSync(fd, JSON.stringify(info) + "\n");
      closeSync(fd);
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const cur = readLock(path);
    if (!cur) continue; // released between the two calls
    const dead = cur.info ? isStale(cur.info) : cur.age > 30_000;
    if (!dead) return { ok: false, ...(cur.info ? { owner: cur.info } : {}) };
    // Remove it only if it is still the stale lock we read (another waiter may have replaced it meanwhile).
    if (readLock(path)?.text === cur.text) {
      try {
        unlinkSync(path);
      } catch {
        // Someone else removed it.
      }
    }
  }
  return { ok: false };
}

function release(tech: string): void {
  const cur = readLock(lockPath(tech));
  if (cur?.info?.pid === process.pid && cur.info.started === STARTED) unlinkSync(lockPath(tech));
}

const describe = (tech: string, o: LockInfo | undefined, waited: number): string =>
  `technology ${tech} is locked${o ? ` by pid ${o.pid} (${o.holder}, since ${o.at})` : ""}; waited ${Math.round(waited / 1000)} s. ` +
  `Retry when that process has finished, or raise UNSTALE_LOCK_TIMEOUT_MS. The lock file is ${lockPath(tech)}.`;

export class LockTimeout extends Error {}

/**
 * Runs `fn` holding the technology's lock. Waits (polling) while another process or call chain holds it, up to the
 * timeout, then throws `LockTimeout`.
 */
export async function withTechLock<T>(tech: string, holder: string, fn: () => Promise<T> | T, opts: { timeoutMs?: number } = {}): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(tech)) return fn();
  const t0 = Date.now();
  const limit = opts.timeoutMs ?? timeoutMs();
  let told = false;
  for (;;) {
    const r = tryAcquire(tech, holder);
    if (r.ok) break;
    const waited = Date.now() - t0;
    if (waited >= limit) throw new LockTimeout(describe(tech, r.owner, waited));
    if (!told) {
      console.error(`waiting for the ${tech} lock${r.owner ? ` (pid ${r.owner.pid}, ${r.owner.holder})` : ""}`);
      told = true;
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  try {
    return await held.run(new Set([...(mine ?? []), tech]), fn);
  } finally {
    release(tech);
  }
}

/** The synchronous form, for synchronous callers (it blocks the thread while it waits). */
export function withTechLockSync<T>(tech: string, holder: string, fn: () => T, opts: { timeoutMs?: number } = {}): T {
  const mine = held.getStore();
  if (mine?.has(tech)) return fn();
  const t0 = Date.now();
  const limit = opts.timeoutMs ?? timeoutMs();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const r = tryAcquire(tech, holder);
    if (r.ok) break;
    const waited = Date.now() - t0;
    if (waited >= limit) throw new LockTimeout(describe(tech, r.owner, waited));
    Atomics.wait(sleeper, 0, 0, POLL_MS);
  }
  try {
    return held.run(new Set([...(mine ?? []), tech]), fn);
  } finally {
    release(tech);
  }
}
