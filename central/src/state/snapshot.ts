// State snapshots that stay bounded as the catalog grows: content-addressed members in append-only segments, saved
// incrementally and restored by need. Replaces the single tarball (`state-<stamp>.tar.zst.*`), which every cycle
// re-uploaded whole and every run downloaded whole: 289 -> 480 MB at 733-840 technologies, about 11 GB at 20,000.
//
//   member     the files of one key (layout.ts): an eager bucket, one technology's docs store or other files, or a log
//              archive; a deterministic tar (tar.ts), zstd-compressed. Its `digest` (sha256 of the tar) says whether it
//              changed.
//   segment    `<generation>.segNN`, members back to back, under 1.5 GiB (the asset limit is 2 GiB).
//   manifest   `<generation>.json`, uploaded last: where every member of that generation is (segment, offset, length,
//              sha256). A generation without its manifest is incomplete and ignored.
//
// Save: members whose files are unchanged (same stat fingerprint, else same digest) keep their place in an earlier
// segment; only changed members are written, to one new segment. So a cycle uploads what it changed, not the store.
// Lazy members not restored this run are carried over untouched; one that exists locally without having been restored
// is refused (it would overwrite the saved member with a partial one). With `evict` (between the cycles of a run), the
// lazy members the new generation holds as they are here are then removed locally, restored again on next use.
// Compaction: a segment less than half live, or past the newest 48 a manifest references, has its live members copied
// into the new segment (at most 1 GiB a save), so the release holds a bounded number of assets (GitHub allows 1,000).
// Retention: the newest generation of each of the newest `keep` runs; segments no kept manifest references are deleted.
// Tarball-format assets are never deleted or replaced, so reverting to the tarball code still restores.
//
// Restore: eager members only (ranges of each segment, coalesced); a lazy member is restored on first use through the
// state server (client.ts). A legacy tarball generation is still restored, so the first run of this code continues
// from the last tarball and saves the first manifest. A generation saved before a layout change restores too: its
// per-technology files come back with its eager members (the next save makes them lazy members), files since left out
// are skipped, and cache files saved one per entry are moved into packs (pipeline/packs.ts).
//
// Local bookkeeping in `<store>/.state/`: the manifest restored or last saved, the stat fingerprints of the members
// restored or saved (`prints.json`), and those of the lazy members restored on demand (`hydrated.json`, written by the
// state server, and by a save that evicts).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { writeAtomic } from "../pipeline/util.ts";
import { migrateCaches } from "../pipeline/packs.ts";
import { areaOf, areaOfKey, bucketCount, excluded, isLegacy, kindOf, memberOf, memberRoot, STATE_DIR, TECH_DIRS, techOf, whole, type Kind } from "./layout.ts";
import type { Asset, Remote } from "./remote.ts";
import { pack, unpack, type Entry } from "./tar.ts";

export interface Member {
  kind: Kind;
  seg: string;
  offset: number;
  length: number;
  /** sha256 of the compressed bytes, checked on every read. */
  sha256: string;
  /** sha256 of the tar: the member's content. */
  digest: string;
  files: number;
  /** Uncompressed file bytes. */
  bytes: number;
}

export interface Manifest {
  version: 2;
  generation: string;
  created: string;
  /** Bucket count per eager area. */
  buckets: Record<string, number>;
  /** Segment name -> size. */
  segments: Record<string, number>;
  members: Record<string, Member>;
}

/** Under GitHub's 2 GiB asset limit. `UNSTALE_STATE_SEGMENT_MAX` lowers it (bytes), for a rehearsal with many segments. */
const SEGMENT_LIMIT = 1536 * 1024 * 1024;
export const SEGMENT_MAX = Math.min(SEGMENT_LIMIT, Number(process.env.UNSTALE_STATE_SEGMENT_MAX) || Infinity);
export const SEGMENTS_KEPT = 48;
export const COMPACT_BYTES = 1024 * 1024 * 1024;
const LEVEL = 10;
const GAP = 4 * 1024 * 1024;
const RANGE_MAX = 256 * 1024 * 1024;

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const stateDir = (root: string): string => join(root, STATE_DIR);
const readJsonFile = <T>(p: string): T | undefined => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined);

export const localManifest = (root: string): Manifest | undefined => readJsonFile<Manifest>(join(stateDir(root), "manifest.json"));
export const localPrints = (root: string): Record<string, string> => readJsonFile<Record<string, string>>(join(stateDir(root), "prints.json")) ?? {};
export const hydratedPrints = (root: string): Record<string, string> => readJsonFile<Record<string, string>>(join(stateDir(root), "hydrated.json")) ?? {};

interface FileStat {
  rel: string;
  size: number;
  mtimeMs: number;
  /** Change time and inode: a write that keeps the size and restores the mtime still changes these. */
  ctimeMs: number;
  ino: number;
}

const statOf = (rel: string, s: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): FileStat => ({ rel, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino });

const byRel = (a: FileStat, b: FileStat): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

/** Every file of the store that belongs in a snapshot (under `tops`, store paths of files or directories, if given), sorted. */
export function walk(root: string, tops: readonly string[] = [""]): FileStat[] {
  const out: FileStat[] = [];
  const visit = (dir: string, rel: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (excluded(r)) continue;
      if (d.isDirectory()) visit(join(dir, d.name), r);
      else if (d.isFile()) {
        out.push(statOf(r, statSync(join(dir, d.name))));
      }
    }
  };
  for (const top of tops) {
    const p = join(root, top);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) visit(p, top);
    else if (!excluded(top)) out.push(statOf(top, statSync(p)));
  }
  return out.sort(byRel);
}

/** The local files of a lazy or archive member. */
export function memberFiles(root: string, key: string): FileStat[] {
  const t = techOf(key);
  const tops = key.startsWith("tech:") ? [`central/records/${t}.json`, `central/docs/${t}`, ...TECH_DIRS.map((d) => `central/${d}/${t}`)] : [memberRoot(key)];
  return walk(root, tops).filter((f) => whole(f.rel) === key);
}

/** Stat fingerprint of a member's files: any write changes it (size, mtime, ctime, or a new inode). */
export function fingerprint(files: readonly FileStat[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.rel}\0${f.size}\0${f.mtimeMs}\0${f.ctimeMs}\0${f.ino}\n`);
  return h.digest("hex");
}

/** An area's compressed size, estimated from up to 8 MiB of its files taken evenly across it. */
function estimate(root: string, files: readonly FileStat[]): number {
  const raw = files.reduce((n, f) => n + f.size, 0);
  const sample: Buffer[] = [];
  let taken = 0;
  for (let i = 0; i < files.length && taken < 8 * 1024 * 1024; i += Math.max(1, Math.ceil(files.length / 4000))) {
    const b = readFileSync(join(root, files[i]!.rel));
    sample.push(b);
    taken += b.length;
  }
  if (!taken) return 0;
  return (raw * zstdCompressSync(Buffer.concat(sample), { params: { [constants.ZSTD_c_compressionLevel]: LEVEL } }).length) / taken;
}

/** Groups files into members; the bucket count of each eager area follows its compressed size. */
export function group(root: string, files: readonly FileStat[], previous: Manifest | undefined): { members: Map<string, FileStat[]>; buckets: Record<string, number> } {
  const byArea = new Map<string, FileStat[]>();
  for (const f of files) {
    if (whole(f.rel)) continue;
    const a = areaOf(f.rel);
    let list = byArea.get(a);
    if (!list) byArea.set(a, (list = []));
    list.push(f);
  }
  const saved = new Map<string, number>();
  for (const [k, m] of Object.entries(previous?.members ?? {})) if (m.kind === "eager") saved.set(areaOfKey(k), (saved.get(areaOfKey(k)) ?? 0) + m.length);
  const buckets: Record<string, number> = {};
  const count = (area: string): number =>
    (buckets[area] ??= bucketCount(saved.get(area) ?? estimate(root, byArea.get(area) ?? []), previous?.buckets[area]));
  const members = new Map<string, FileStat[]>();
  for (const f of files) {
    const k = memberOf(f.rel, count);
    let list = members.get(k);
    if (!list) members.set(k, (list = []));
    list.push(f);
  }
  return { members, buckets };
}

interface Payload {
  tar: Buffer;
  digest: string;
  files: number;
  bytes: number;
}

/** A member's tar and digest; compressed (`compress`) only when it is written. A member whose stat fingerprint changed
 * without its bytes changing (a link or unlink changes the ctime: the catalog export hard-links every shard, export.ts)
 * then costs a read and a hash, not a zstd pass. */
function payload(root: string, files: readonly FileStat[]): Payload {
  const entries: Entry[] = files.map((f) => ({ path: f.rel, data: readFileSync(join(root, f.rel)) }));
  const tar = pack(entries);
  return { tar, digest: sha(tar), files: entries.length, bytes: entries.reduce((n, e) => n + e.data.byteLength, 0) };
}

const compress = (tar: Buffer): Buffer => zstdCompressSync(tar, { params: { [constants.ZSTD_c_compressionLevel]: LEVEL } });

class SegmentWriter {
  readonly dir: string;
  readonly generation: string;
  readonly written: Array<{ name: string; file: string; size: number }> = [];
  private fd: number | undefined;
  constructor(dir: string, generation: string) {
    this.dir = dir;
    this.generation = generation;
  }
  add(data: Buffer): { seg: string; offset: number } {
    if (data.length > SEGMENT_LIMIT) throw new Error(`a member of ${data.length} bytes exceeds the segment limit`);
    let cur = this.written.at(-1);
    if (!cur || this.fd === undefined || (cur.size > 0 && cur.size + data.length > SEGMENT_MAX)) {
      if (this.fd !== undefined) closeSync(this.fd);
      const name = `${this.generation}.seg${String(this.written.length).padStart(2, "0")}`;
      cur = { name, file: join(this.dir, name), size: 0 };
      this.written.push(cur);
      this.fd = openSync(cur.file, "w");
    }
    const offset = cur.size;
    let n = 0;
    while (n < data.length) n += writeSync(this.fd, data, n, data.length - n);
    cur.size += data.length;
    return { seg: cur.name, offset };
  }
  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}

const ROTATED = ["central/usage.jsonl", "central/onboarding/timeline.jsonl"];

/**
 * Append-only logs keep the current UTC month: earlier lines move to `central/archive/<log>-<YYYY-MM>.jsonl` (an
 * archive member, saved once and never restored by a run), so the log a cycle re-uploads holds a month at most.
 */
export function rotateLogs(root: string, manifest: Manifest | undefined, now: Date): string[] {
  const month = now.toISOString().slice(0, 7);
  const made: string[] = [];
  for (const rel of ROTATED) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const keep: string[] = [];
    const old = new Map<string, string[]>();
    for (const l of lines) {
      let at: unknown;
      try {
        at = (JSON.parse(l) as { at?: unknown }).at;
      } catch {
        at = undefined;
      }
      const m = typeof at === "string" && /^\d{4}-\d{2}/.test(at) ? at.slice(0, 7) : month;
      if (m < month) old.set(m, [...(old.get(m) ?? []), l]);
      else keep.push(l);
    }
    if (!old.size) continue;
    const base = rel.split("/").at(-1)!.replace(/\.jsonl$/, "");
    for (const [m, ls] of [...old].sort()) {
      let name = `${base}-${m}.jsonl`;
      for (let i = 2; manifest?.members[`archive:${name}`] || existsSync(join(root, "central", "archive", name)); i++) name = `${base}-${m}.${i}.jsonl`;
      writeAtomic(join(root, "central", "archive", name), ls.join("\n") + "\n");
      made.push(name);
    }
    writeAtomic(p, keep.length ? keep.join("\n") + "\n" : "");
  }
  return made;
}

export interface SaveOptions {
  generation: string;
  /** Runs whose newest generation is kept (default 3). */
  keep?: number;
  now?: Date;
  tmp?: string;
  log?: (s: string) => void;
  /** Remove the lazy members this save holds from the store (`evict`): between the cycles of a run. */
  evict?: boolean;
}

export interface SaveReport {
  generation: string;
  members: number;
  written: number;
  written_bytes: number;
  compacted: number;
  compacted_bytes: number;
  cold: number;
  rotated: string[];
  segments: number;
  total_bytes: number;
  uploaded_bytes: number;
  deleted: string[];
  /** Lazy members removed from the store once saved (`evict`). */
  evicted: number;
}

const KIND_ORDER: Record<Kind, number> = { eager: 0, lazy: 1, archive: 2 };

export async function save(root: string, remote: Remote, o: SaveOptions): Promise<SaveReport> {
  const log = o.log ?? (() => {});
  const previous = localManifest(root);
  const prints = localPrints(root);
  const hydrated = hydratedPrints(root);
  const rotated = rotateLogs(root, previous, o.now ?? new Date());
  const { members: local, buckets } = group(root, walk(root), previous);

  const tmp = o.tmp ?? join(stateDir(root), "out");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const writer = new SegmentWriter(tmp, o.generation);
  const next: Record<string, Member> = {};
  const newPrints: Record<string, string> = {};
  let written = 0;
  let writtenBytes = 0;
  const put = (key: string, p: Payload): number => {
    const data = compress(p.tar);
    const at = writer.add(data);
    next[key] = { kind: kindOf(key), ...at, length: data.length, sha256: sha(data), digest: p.digest, files: p.files, bytes: p.bytes };
    return data.length;
  };

  const keys = [...local.keys()].sort((a, b) => KIND_ORDER[kindOf(a)] - KIND_ORDER[kindOf(b)] || (a < b ? -1 : 1));
  for (const key of keys) {
    const files = local.get(key)!;
    const fp = fingerprint(files);
    const prev = previous?.members[key];
    const known = prints[key] ?? hydrated[key];
    if (prev && prev.kind !== "eager" && known === undefined)
      throw new Error(`${key} exists locally but was not restored from the saved state: saving it would replace the saved ${memberRoot(key)} with a partial one`);
    newPrints[key] = fp;
    if (prev && known === fp) {
      next[key] = prev;
      continue;
    }
    const p = payload(root, files);
    if (prev && prev.digest === p.digest) {
      next[key] = prev;
      continue;
    }
    written++;
    writtenBytes += put(key, p);
  }
  // Members not present locally: a docs store or archive not restored this run is carried over; an eager member, or
  // a restored docs store, that is gone was deleted.
  let cold = 0;
  for (const [key, m] of Object.entries(previous?.members ?? {})) {
    if (local.has(key) || m.kind === "eager") continue;
    if (m.kind === "lazy" && (prints[key] ?? hydrated[key]) !== undefined) continue;
    next[key] = m;
    cold++;
  }

  // Compaction: copy the live members of sparse or old segments into the new one.
  const sizes: Record<string, number> = { ...previous?.segments };
  const live = new Map<string, number>();
  for (const m of Object.values(next)) if (sizes[m.seg] !== undefined) live.set(m.seg, (live.get(m.seg) ?? 0) + m.length);
  const old = [...live.keys()].sort();
  const victims = new Set(old.filter((s) => live.get(s)! < sizes[s]! / 2));
  for (const s of old.slice(0, Math.max(0, old.length - (SEGMENTS_KEPT - 1)))) victims.add(s);
  let budget = COMPACT_BYTES;
  let compacted = 0;
  let compactedBytes = 0;
  const assets = new Map((await remote.list()).map((a) => [a.name, a]));
  for (const seg of [...victims].sort()) {
    if (live.get(seg)! > budget) continue;
    budget -= live.get(seg)!;
    for (const [key, m] of Object.entries(next).filter(([, m]) => m.seg === seg)) {
      let data: Buffer;
      if (local.has(key)) {
        const p = payload(root, local.get(key)!);
        if (p.digest !== m.digest) throw new Error(`${key}: local files differ from the member they were matched to`);
        data = compress(p.tar);
      } else {
        const asset = assets.get(seg);
        if (!asset) throw new Error(`segment ${seg} is missing from the release`);
        data = await remote.read(asset, m.offset, m.offset + m.length);
        if (sha(data) !== m.sha256) throw new Error(`${key}: ${seg} bytes ${m.offset}+${m.length} fail their checksum`);
      }
      const at = writer.add(data);
      next[key] = { ...m, ...at, length: data.length, sha256: sha(data) };
      compacted++;
      compactedBytes += data.length;
    }
    log(`compacted ${seg}`);
  }
  writer.close();

  const segments: Record<string, number> = {};
  for (const m of Object.values(next)) segments[m.seg] = sizes[m.seg] ?? writer.written.find((w) => w.name === m.seg)!.size;
  const manifest: Manifest = {
    version: 2,
    generation: o.generation,
    created: (o.now ?? new Date()).toISOString(),
    buckets: Object.fromEntries(Object.entries(buckets).sort()),
    segments: Object.fromEntries(Object.entries(segments).sort()),
    members: Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  let uploaded = 0;
  for (const w of writer.written) {
    if (!Object.values(next).some((m) => m.seg === w.name)) continue;
    await remote.upload(w.file, w.name);
    uploaded += w.size;
    log(`uploaded ${w.name} (${w.size} bytes)`);
  }
  const mfile = join(tmp, `${o.generation}.json`);
  writeFileSync(mfile, JSON.stringify(manifest) + "\n");
  await remote.upload(mfile, `${o.generation}.json`); // last: marks the generation complete
  uploaded += statSync(mfile).size;
  writeAtomic(join(stateDir(root), "manifest.json"), JSON.stringify(manifest) + "\n");
  writeAtomic(join(stateDir(root), "prints.json"), JSON.stringify(newPrints) + "\n");
  rmSync(tmp, { recursive: true, force: true });
  const evicted = o.evict ? evict(root, manifest, local, newPrints) : [];

  const deleted = await retain(remote, o.generation, o.keep ?? 3);
  return {
    generation: o.generation,
    members: Object.keys(next).length,
    written,
    written_bytes: writtenBytes,
    compacted,
    compacted_bytes: compactedBytes,
    cold,
    rotated,
    segments: Object.keys(segments).length,
    total_bytes: Object.values(segments).reduce((a, b) => a + b, 0),
    uploaded_bytes: uploaded,
    deleted,
    evicted: evicted.length,
  };
}

/** `state-<UTC>-<run>-<attempt>` -> `<run>-<attempt>`. */
const runOf = (gen: string): string => gen.split("-").slice(2, 4).join("-");
const GENERATION = /^(state-[^.]+)\.(json|sha256)$/;

/** Complete generations, newest first. */
export function generations(assets: readonly Asset[]): Array<{ name: string; kind: "v2" | "legacy"; asset: Asset }> {
  return assets
    .flatMap((a) => {
      const m = GENERATION.exec(a.name);
      return m ? [{ name: m[1]!, kind: m[2] === "json" ? ("v2" as const) : ("legacy" as const), asset: a }] : [];
    })
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/**
 * Keeps the newest complete generation of each of the newest `keep` runs (and `current`), and every segment a kept
 * manifest references; deletes every other `state-` asset (older generations, parts of interrupted saves).
 *
 * Tarball-format assets are never deleted and do not count toward `keep`: they are what the code before manifests
 * restores, so reverting to it continues from the last tarball. An operator deletes them once they are not needed.
 */
export async function retain(remote: Remote, current: string, keep: number): Promise<string[]> {
  const assets = await remote.list();
  const seen = new Set<string>();
  const kept = new Set<string>([current]);
  for (const g of generations(assets)) {
    if (g.kind !== "v2" || seen.has(runOf(g.name)) || seen.size >= keep) continue;
    seen.add(runOf(g.name));
    kept.add(g.name);
  }
  const live = new Set<string>();
  for (const g of generations(assets).filter((g) => g.kind === "v2" && kept.has(g.name))) {
    const m = JSON.parse((await remote.read(g.asset)).toString("utf8")) as Manifest;
    for (const s of Object.keys(m.segments)) live.add(s);
  }
  const deleted: string[] = [];
  // A killed save's half-uploaded asset is never listed as uploaded: deleted too (never one of `current`'s).
  const incomplete = (await remote.incomplete?.()) ?? [];
  for (const a of [...assets, ...incomplete.filter((a) => !a.name.startsWith(`${current}.`))]) {
    if (!a.name.startsWith("state-") || isLegacy(a.name)) continue;
    const gen = a.name.replace(/\.json$/, "");
    if (live.has(a.name) || (kept.has(gen) && !/\.seg\d+$/.test(a.name))) continue;
    await remote.remove(a);
    deleted.push(a.name);
  }
  return deleted;
}

function writeEntries(root: string, entries: readonly Entry[]): void {
  const dirs = new Set<string>();
  for (const e of entries) {
    const p = join(root, e.path);
    const d = dirname(p);
    if (!dirs.has(d)) {
      mkdirSync(d, { recursive: true });
      dirs.add(d);
    }
    writeFileSync(p, e.data);
  }
}

function decode(key: string, m: Member, data: Buffer): Entry[] {
  if (data.length !== m.length || sha(data) !== m.sha256) throw new Error(`${key}: bytes in ${m.seg} fail their checksum`);
  const tar = zstdDecompressSync(data);
  if (sha(tar) !== m.digest) throw new Error(`${key}: content fails its digest`);
  return unpack(tar);
}

const statsOf = (root: string, entries: readonly Entry[]): FileStat[] =>
  entries.map((e) => statOf(e.path, statSync(join(root, e.path)))).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

export interface RestoreReport {
  generation?: string;
  kind: "v2" | "legacy" | "none";
  members: number;
  files: number;
  downloaded_bytes: number;
  /** Members left for restore on first use. */
  deferred: number;
  /** Cache files of a state saved before packs, moved into packs (pipeline/packs.ts). */
  packed?: number;
}

/** Restores the newest complete generation into an empty store: eager members (all members with `all`). */
export async function restore(root: string, remote: Remote, o: { all?: boolean; tmp?: string; log?: (s: string) => void } = {}): Promise<RestoreReport> {
  const log = o.log ?? (() => {});
  for (const d of ["central", "catalog", STATE_DIR]) if (existsSync(join(root, d))) throw new Error(`${join(root, d)} exists: restore into an empty store`);
  mkdirSync(root, { recursive: true });
  const assets = await remote.list();
  const newest = generations(assets)[0];
  if (!newest) return { kind: "none", members: 0, files: 0, downloaded_bytes: 0, deferred: 0 };
  if (newest.kind === "legacy") {
    const r = await restoreLegacy(root, remote, assets, newest.name, newest.asset, o.tmp ?? join(root, `${STATE_DIR}-in`));
    const packed = migrateCaches(join(root, "central"));
    if (packed) log(`moved ${packed} cache files into packs`);
    return { ...r, ...(packed ? { packed } : {}) };
  }
  const manifest = JSON.parse((await remote.read(newest.asset)).toString("utf8")) as Manifest;
  if (manifest.version !== 2) throw new Error(`${newest.name}: manifest version ${String(manifest.version)} is not 2`);
  const byName = new Map(assets.map((a) => [a.name, a]));
  const wanted = Object.entries(manifest.members).filter(([, m]) => o.all || m.kind === "eager");
  const prints: Record<string, string> = {};
  let files = 0;
  let downloaded = 0;
  const tmp = o.tmp ?? join(stateDir(root), "in");
  mkdirSync(tmp, { recursive: true });
  for (const seg of [...new Set(wanted.map(([, m]) => m.seg))].sort()) {
    const asset = byName.get(seg);
    if (!asset) throw new Error(`${newest.name}: segment ${seg} is missing`);
    const ms = wanted.filter(([, m]) => m.seg === seg).sort(([, a], [, b]) => a.offset - b.offset);
    // Coalesced ranges: members closer than GAP are read in one request.
    const ranges: Array<{ start: number; end: number; ms: typeof ms }> = [];
    for (const e of ms) {
      const r = ranges.at(-1);
      if (r && e[1].offset - r.end <= GAP && e[1].offset + e[1].length - r.start <= RANGE_MAX) {
        r.end = Math.max(r.end, e[1].offset + e[1].length);
        r.ms.push(e);
      } else ranges.push({ start: e[1].offset, end: e[1].offset + e[1].length, ms: [e] });
    }
    for (const r of ranges) {
      const file = join(tmp, "range");
      await remote.download(asset, file, r.start, r.end);
      downloaded += r.end - r.start;
      const buf = readFileSync(file);
      for (const [key, m] of r.ms) {
        // Files left out of the state since this member was saved (dead weight) are not written.
        const entries = decode(key, m, buf.subarray(m.offset - r.start, m.offset - r.start + m.length)).filter((e) => !excluded(e.path));
        writeEntries(root, entries);
        prints[key] = fingerprint(statsOf(root, entries));
        files += entries.length;
      }
    }
    log(`restored ${ms.length} members from ${seg}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  writeAtomic(join(stateDir(root), "manifest.json"), JSON.stringify(manifest) + "\n");
  writeAtomic(join(stateDir(root), "prints.json"), JSON.stringify(prints) + "\n");
  const packed = migrateCaches(join(root, "central"));
  if (packed) log(`moved ${packed} cache files into packs`);
  return { generation: newest.name, kind: "v2", members: wanted.length, files, downloaded_bytes: downloaded, deferred: Object.keys(manifest.members).length - wanted.length, ...(packed ? { packed } : {}) };
}

/** A tarball generation: its parts in order, checked against `<gen>.sha256`, through zstd and tar. */
async function restoreLegacy(root: string, remote: Remote, assets: readonly Asset[], gen: string, sums: Asset, tmp: string): Promise<RestoreReport> {
  const expected = new Map(
    (await remote.read(sums)).toString("utf8").split("\n").filter(Boolean).map((l) => {
      const [hash, name] = l.trim().split(/\s+\*?/);
      return [name!, hash!] as const;
    }),
  );
  const parts = assets.filter((a) => a.name.startsWith(`${gen}.tar.zst.`)).sort((a, b) => (a.name < b.name ? -1 : 1));
  if (!parts.length || parts.length !== expected.size) throw new Error(`${gen}: ${parts.length} parts, ${expected.size} listed`);
  mkdirSync(tmp, { recursive: true });
  let downloaded = 0;
  for (const p of parts) {
    const file = join(tmp, p.name);
    await remote.download(p, file);
    downloaded += p.size;
    const h = createHash("sha256");
    const fd = openSync(file, "r");
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0; ) h.update(chunk.subarray(0, n));
    closeSync(fd);
    if (h.digest("hex") !== expected.get(p.name)) throw new Error(`${p.name} fails its checksum`);
  }
  await new Promise<void>((resolve, reject) => {
    const cat = spawn("sh", ["-c", 'cat "$@" | zstd -d -q | tar -x -C "$0"', root, ...parts.map((p) => join(tmp, p.name))], { stdio: "inherit" });
    cat.on("error", reject);
    cat.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`extracting ${gen}: exit ${code}`))));
  });
  rmSync(tmp, { recursive: true, force: true });
  // A store archived on macOS carries AppleDouble `._*` entries, which GNU tar extracts as files.
  let files = 0;
  const sweep = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) sweep(p);
      else if (d.name.startsWith("._")) rmSync(p);
      else files++;
    }
  };
  sweep(root);
  return { generation: gen, kind: "legacy", members: 0, files, downloaded_bytes: downloaded, deferred: 0 };
}

/**
 * Restores one lazy member (a docs store or a technology's files) or an archive on first use (the state server calls
 * this; one at a time per key). "new" when the saved state has no such member, "local" when it is already here.
 */
export async function hydrate(root: string, remote: Remote, key: string, assets?: (fresh: boolean) => Promise<Map<string, Asset>>): Promise<"restored" | "local" | "new"> {
  const manifest = localManifest(root);
  const m = manifest?.members[key];
  if (!m) return "new";
  if (hydratedPrints(root)[key] !== undefined || localPrints(root)[key] !== undefined) return "local";
  if (memberFiles(root, key).length) throw new Error(`${memberRoot(key)} exists but was not restored from the saved state`);
  const list = assets ?? (async () => new Map((await remote.list()).map((a) => [a.name, a])));
  const asset = (await list(false)).get(m.seg) ?? (await list(true)).get(m.seg);
  if (!asset) throw new Error(`${key}: segment ${m.seg} is missing from the release`);
  const entries = decode(key, m, await remote.read(asset, m.offset, m.offset + m.length)).filter((e) => !excluded(e.path));
  const stage = join(stateDir(root), "tmp", randomBytes(6).toString("hex"));
  // Whole or not at all: a restore that fails part way (a full disk) takes back what it moved in, so the member is not
  // left half here, which every later restore and save would refuse.
  const moved: string[] = [];
  try {
    writeEntries(stage, entries);
    for (const e of entries) {
      mkdirSync(dirname(join(root, e.path)), { recursive: true });
      renameSync(join(stage, e.path), join(root, e.path));
      moved.push(e.path);
    }
  } catch (err) {
    for (const p of moved) {
      rmSync(join(root, p), { force: true });
      pruneEmpty(dirname(join(root, p)), join(root, "central"));
    }
    throw err;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  // Read and written in one synchronous step: concurrent restores of other keys in this process lose no entry.
  const hydrated = { ...hydratedPrints(root), [key]: fingerprint(statsOf(root, entries)) };
  writeAtomic(join(stateDir(root), "hydrated.json"), JSON.stringify(hydrated) + "\n");
  return "restored";
}

/** Removes `dir` and its parents up to `stop` while they are empty. */
function pruneEmpty(dir: string, stop: string): void {
  for (let d = dir; d.startsWith(`${stop}/`); d = dirname(d)) {
    try {
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

/**
 * After a save: the lazy members the saved generation now holds exactly as they are here are removed from this store,
 * so a run's disk holds the technologies of its current cycle, not of every cycle so far. One is restored again on its
 * next use. Its bookkeeping goes first, so an interrupted eviction leaves files the state does not count as restored
 * (a save or a restore then refuses them, loudly) rather than restored files that are gone (which would save as
 * deleted). Only between processes: a live process keeps its own record of what it made local (client.ts).
 */
function evict(root: string, saved: Manifest, local: Map<string, FileStat[]>, prints: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, files] of local) {
    if (kindOf(key) !== "lazy" || !saved.members[key] || prints[key] === undefined) continue;
    const now = files.map((f) => (existsSync(join(root, f.rel)) ? statOf(f.rel, statSync(join(root, f.rel))) : undefined));
    if (now.some((f) => !f) || fingerprint(now as FileStat[]) !== prints[key]) continue;
    out.push(key);
  }
  if (!out.length) return out;
  const hydrated = hydratedPrints(root);
  for (const key of out) {
    delete prints[key];
    delete hydrated[key];
  }
  writeAtomic(join(stateDir(root), "prints.json"), JSON.stringify(prints) + "\n");
  writeAtomic(join(stateDir(root), "hydrated.json"), JSON.stringify(hydrated) + "\n");
  for (const key of out)
    for (const f of local.get(key)!) {
      unlinkSync(join(root, f.rel));
      pruneEmpty(dirname(join(root, f.rel)), join(root, "central"));
    }
  return out;
}
