import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { usageLog } from "./paths.ts";

export const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/** JSON with object keys sorted at every level: the same value always gives the same bytes. */
export function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

export function writeAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

/** One line per real (uncached) model call, or an event (CONTRACT: Paths, usage log). */
export function logUsage(entry: Record<string, unknown>): void {
  mkdirSync(dirname(usageLog()), { recursive: true });
  appendFileSync(usageLog(), JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n");
}

/** Runs `fn` over `items` with at most `n` in flight; results keep the input order. */
export async function pool<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Upstream text as one line of at most `max` characters: control characters, line and paragraph separators and
 * bidirectional overrides become spaces, so a source cannot forge headings or instructions in what an edge renders.
 */
export function oneLine(s: string, max: number): string {
  const t = s.replace(/[\p{Cc}\s\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/gu, " ").trim();
  return [...t].length <= max ? t : [...t].slice(0, max - 1).join("").trimEnd() + "…";
}

/**
 * A GitHub `owner/repo` as GitHub allows it. Slugs come from registry metadata and crawled pages and are put into
 * API paths sent with the operator's token, so `..` or `.` (which a URL resolves to another API path) is refused.
 */
export const isRepoSlug = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[\w.-]{1,100}$/.test(s);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Compares dotted numeric versions (`16.3.10` > `16.3.9`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Release line: the major version, or major.minor below 1.0 (vault: Data Model Contract, `releases`). */
export function releaseLine(version: string): string {
  const [maj, min] = version.split(".");
  return maj === "0" ? `0.${min ?? "0"}` : maj!;
}
