// Release lines derived from the release index (vault: Implementation Decisions, "Release lines from the release
// index").
//
// A release line is a set of versions inside which version order is publish order, so "a release on my line at or
// below my version" means "published before mine on the branch I am on". The old rule (the major, or 0.minor) breaks
// whenever an older minor gets a patch after a newer minor shipped (next 15.0.8 after 15.1.0): the earliest release
// per major hid every later backport. The rule here is derived per technology from its own release index:
//
//   depth = the smallest version-prefix depth d (1 ≤ d ≤ MAX_DEPTH) such that, in every group of stable releases that
//           share their first d numeric components, ascending version order is non-decreasing publish date
//           (same-day releases tie). None up to MAX_DEPTH → MAX_DEPTH.
//   line  = a version's first `depth` numeric components (missing ones read as 0).
//
// Stable releases only (numeric dotted versions; anything else is a prerelease or unreadable and is ignored). The
// index is the technology's release list as central holds it (the catalog window), so the depth can change when a
// backport lands; everything that depends on it is recomputed on every run (deterministic, no model calls).
import { compareVersions, releaseLine } from "./util.ts";
import type { Release, StoredRecord, TechStore } from "./store.ts";

export const MAX_DEPTH = 3;

/** One release of the technology as published in the tech index: ordered by version, each with its derived line. */
export interface IndexRelease {
  version: string;
  date: string;
  line: string;
  /** The first release of its line, and the line's zero version (`15.5.0`, `4.2`): the line began in the window. */
  line_start?: boolean;
}

export interface ReleaseIndex {
  /** The derived prefix depth. */
  depth: number;
  /** Stable releases in the window, ascending by version. */
  releases: IndexRelease[];
}

const STABLE = /^\d+(?:\.\d+)*$/;
export const isStable = (v: string): boolean => STABLE.test(v);

/** A version's first `depth` numeric components; undefined for a version that is not numeric dotted. */
export function prefix(version: string, depth: number): string | undefined {
  if (!isStable(version)) return undefined;
  const parts = version.split(".");
  return Array.from({ length: depth }, (_, i) => String(Number(parts[i] ?? 0))).join(".");
}

/** The derived depth for a set of dated releases (see the header). */
export function deriveDepth(releases: ReadonlyArray<{ version: string; date: string }>, max = MAX_DEPTH): number {
  const stable = releases.filter((r) => isStable(r.version)).slice().sort((a, b) => compareVersions(a.version, b.version));
  for (let d = 1; d <= max; d++) {
    const last = new Map<string, string>();
    let ok = true;
    for (const r of stable) {
      const g = prefix(r.version, d)!;
      const prev = last.get(g);
      if (prev !== undefined && r.date < prev) {
        ok = false;
        break;
      }
      last.set(g, prev !== undefined && prev > r.date ? prev : r.date);
    }
    if (ok) return d;
  }
  return max;
}

/** The release index for a technology's release list (one entry per stable version, earliest date if repeated). */
export function buildIndex(releases: ReadonlyArray<{ version: string; date: string }>): ReleaseIndex {
  const byVersion = new Map<string, string>();
  for (const r of releases) {
    if (!isStable(r.version)) continue;
    const prev = byVersion.get(r.version);
    if (prev === undefined || r.date < prev) byVersion.set(r.version, r.date);
  }
  const list = [...byVersion].map(([version, date]) => ({ version, date }));
  const depth = deriveDepth(list);
  const seen = new Set<string>();
  const out: IndexRelease[] = [];
  for (const r of list.sort((a, b) => compareVersions(a.version, b.version))) {
    const line = prefix(r.version, depth)!;
    const first = !seen.has(line);
    seen.add(line);
    // The line's start is known only when its first release in the window is its zero version (nothing before it).
    const zero = r.version.split(".").slice(depth).every((x) => Number(x) === 0);
    out.push({ ...r, line, ...(first && zero ? { line_start: true } : {}) });
  }
  return { depth, releases: out };
}

/** The line function of a store: the derived line when the store has an index, else the old rule. */
export function lineFn(s: Pick<TechStore, "releaseIndex"> | undefined): (version: string) => string {
  const depth = s?.releaseIndex?.depth;
  return (version) => (depth !== undefined ? prefix(version, depth) : undefined) ?? releaseLine(version);
}

/** The version a source key names (`{technology}@{version}[+tag]#{n}`), if any. */
export function sourceVersion(key: string): string | undefined {
  const at = key.indexOf("@");
  if (at < 0) return undefined;
  const v = /^[^+#]+/.exec(key.slice(at + 1))?.[0];
  return v || undefined;
}

/** Fix releases of a record's attached advisories: each range's `patched` version, where the index holds it. */
function advisoryFixVersions(r: StoredRecord, inIndex: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const a of r.advisories ?? []) for (const x of a.affected) if (x.patched && inIndex.has(x.patched)) out.add(x.patched);
  return [...out];
}

/**
 * A record's releases recomputed from what shipped it: its current releases, the releases its sources were extracted
 * from and the fix releases of its advisories, one per component and derived line (the earliest). `drop` names
 * versions to leave out unless a source or an advisory still supports them (an advisory that was detached).
 */
export function recomputeReleases(r: StoredRecord, s: Pick<TechStore, "releaseIndex">, components: readonly string[], drop: ReadonlySet<string> = new Set()): Release[] {
  const idx = s.releaseIndex;
  const dates = new Map((idx?.releases ?? []).map((x) => [x.version, x.date]));
  const inIndex = new Set(dates.keys());
  const comps = [...new Set(r.releases.map((x) => x.component))];
  const useComps = comps.length ? comps : [...components];
  const supported = new Set<string>([...r.sources.map(sourceVersion).filter((v): v is string => !!v && inIndex.has(v)), ...advisoryFixVersions(r, inIndex)]);
  const cand: Release[] = r.releases.filter((x) => !drop.has(x.version) || supported.has(x.version));
  for (const v of supported) {
    for (const component of useComps) cand.push({ component, version: v, date: dates.get(v)!, line: releaseLine(v) });
  }
  return combineByLine([], cand, lineFn(s));
}

/**
 * One release per component and line: the earliest version that shipped the change on that line. `lineOf` gives the
 * line (the derived one); the published `line` field keeps the old rule (major, or 0.minor), which is what older edges
 * compare and what shards are named by.
 */
export function combineByLine(a: Release[], b: Release[], lineOf: (version: string) => string): Release[] {
  const by = new Map<string, Release>();
  for (const r of [...a, ...b]) {
    const k = `${r.component}\u0000${lineOf(r.version)}`;
    const prev = by.get(k);
    if (!prev || compareVersions(r.version, prev.version) < 0 || (compareVersions(r.version, prev.version) === 0 && r.date < prev.date)) by.set(k, r);
  }
  return [...by.values()].sort((x, y) => x.component.localeCompare(y.component) || compareVersions(x.version, y.version));
}
