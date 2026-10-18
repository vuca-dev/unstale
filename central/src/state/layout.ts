// Which state member a store file belongs to (snapshot.ts). Three kinds:
//
//   lazy     restored on first use (client.ts), so a run downloads what it works, not the whole catalog's state:
//            `docs:<tech>`, a technology's docs store (`central/docs/<tech>/store/**`, the page snapshots and their watch
//            states), read only when that technology's docs are checked or extracted; and `tech:<tech>`, the rest of
//            what is kept per technology (its records `central/records/<tech>.json`, its docs metadata
//            `central/docs/<tech>/*`, and `central/{releases,advisories,guides,extractions}/<tech>/**`), read only when
//            that technology is worked, published or shown.
//   archive  a month of an append-only log (`central/archive/<log>-<YYYY-MM>.jsonl`, rotated out by the save): kept,
//            never restored unless asked for.
//   eager    everything else, restored before the run: per area (the first two path segments: `central/cache`,
//            `catalog/v1`, ...) in buckets by the hash of the path, as many buckets as keep a bucket near 256 KiB
//            compressed, so a cycle that changes a few files rewrites a few small members, not the area.
//
// Left out (as the tarball left them out, plus dead weight): locks of live processes, the parked rarity sample, the
// retired onboarding documents and their watch specs (`central/onboarding/watches`, no reader since b042f5f), the
// day's shared page cache, the `codex` classifier cache (no code has read it since cb4bc28 moved every model call to
// gpt-6-luna), interrupted atomic writes and macOS metadata.
import { createHash } from "node:crypto";

export type Kind = "eager" | "lazy" | "archive";

/** The bookkeeping directory under the store root (snapshot.ts); never part of a member. */
export const STATE_DIR = ".state";

const EXCLUDED: readonly RegExp[] = [
  /^\.state(\/|$)/,
  /^central\/records\/[^/]+\.lock$/,
  /^central\/sample(\/|$)/,
  /^central\/onboarding\/documents(\/|$)/,
  /^central\/onboarding\/watches(\/|$)/,
  /^central\/cache\/pages(\/|$)/,
  /^central\/cache\/codex(\/|$)/,
  /\.\d+(\.[a-z0-9]+)?\.tmp$/,
  /(^|\/)\._[^/]*$/,
];

export const excluded = (rel: string): boolean => EXCLUDED.some((r) => r.test(rel));

const DOCS_STORE = /^central\/docs\/([^/]+)\/store\//;
/** A technology's files outside its docs store: records, docs metadata, release notes, advisories, guides, extractions. */
const TECH = /^central\/(?:records\/([^/]+)\.json$|docs\/([^/]+)\/[^/]+$|(?:releases|advisories|guides|extractions)\/([^/]+)\/)/;
const ARCHIVE = /^central\/archive\/([^/]+)$/;
/** Directories that hold a technology's files under its own name (`<area>/<tech>/**`). */
export const TECH_DIRS = ["releases", "advisories", "guides", "extractions"] as const;

/** The technology a `tech:` or `docs:` key names. */
export const techOf = (key: string): string => key.slice(key.indexOf(":") + 1);

/** The directory (or file) a docs store or archive member restores as a whole. */
export function memberRoot(key: string): string {
  if (key.startsWith("docs:")) return `central/docs/${key.slice(5)}/store`;
  if (key.startsWith("archive:")) return `central/archive/${key.slice(8)}`;
  if (key.startsWith("tech:")) return `central/{records,docs,${TECH_DIRS.join(",")}}/${key.slice(5)}`;
  throw new Error(`${key} is not a lazy or archive member`);
}

export function kindOf(key: string): Kind {
  return key.startsWith("docs:") || key.startsWith("tech:") ? "lazy" : key.startsWith("archive:") ? "archive" : "eager";
}

/** `central/records/next.json` -> `central/records`; a file at the top is its own area. */
export function areaOf(rel: string): string {
  return rel.split("/").slice(0, 2).join("/");
}

export function bucketOf(rel: string, buckets: number): number {
  return parseInt(createHash("sha256").update(rel).digest("hex").slice(0, 8), 16) % buckets;
}

/** An eager key names its bucket count, so a change of count gives new keys and the old ones are dropped. */
export const eagerKey = (area: string, buckets: number, bucket: number): string => `${area}@${buckets}/${bucket}`;
export const areaOfKey = (key: string): string => key.slice(0, key.lastIndexOf("@"));

/** The lazy or archive member a file belongs to whole, if any. */
export function whole(rel: string): string | undefined {
  const docs = DOCS_STORE.exec(rel);
  if (docs) return `docs:${docs[1]}`;
  const tech = TECH.exec(rel);
  if (tech) return `tech:${tech[1] ?? tech[2] ?? tech[3]}`;
  const archive = ARCHIVE.exec(rel);
  return archive ? `archive:${archive[1]}` : undefined;
}

/** The member a store file belongs to, given the bucket count of each area. */
export function memberOf(rel: string, buckets: (area: string) => number): string {
  const w = whole(rel);
  if (w) return w;
  const area = areaOf(rel);
  const n = buckets(area);
  return eagerKey(area, n, bucketOf(rel, n));
}

/** Target compressed size of an eager member. */
export const TARGET_MEMBER = 256 * 1024;

/**
 * Buckets for an area of `bytes` compressed bytes: the previous count while a bucket stays within a factor of 4 below
 * or 2 above the target (so a count changes, and the area is rewritten, only when the area has grown or shrunk a lot);
 * otherwise the power of two that brings it to the target.
 */
export function bucketCount(bytes: number, previous: number | undefined): number {
  const want = Math.min(65536, 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, bytes / TARGET_MEMBER)))));
  if (previous === undefined) return want;
  const avg = bytes / previous;
  return avg > 2 * TARGET_MEMBER || (previous > 1 && avg < TARGET_MEMBER / 4) ? want : previous;
}

/**
 * An asset of the tarball format (`state-<stamp>.tar.zst.<part>`, `state-<stamp>.sha256`): what the code before
 * manifests restores. Nothing here deletes or replaces one (snapshot.ts retain, remote.ts upload).
 */
export const isLegacy = (name: string): boolean => /^state-[^.]+\.(sha256|tar\.zst\.[a-z]+)$/.test(name);
