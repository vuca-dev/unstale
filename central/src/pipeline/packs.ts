// Content-hash caches as a few thousand container files instead of one small file per entry. The caches (classifier
// answers, model answers, registry checks, the day's shared docs pages) hold millions of entries at 20,000
// technologies, averaging under 2 KB: as files, the filesystem's 4 KiB block takes two to five times their bytes, and
// the classifier cache alone would take 7 GB of a runner's 14.
//
//   pack     `<dir>/<bucket>.pack`, the bucket being the first `width` hex digits of sha256(name): records appended
//            back to back. A name's newest valid record is its value. A record is
//            `\n{"k":<name>,"n":<bytes>,"h":<sha256 of the bytes, 16 hex>[,"z":"br"]}\n<bytes>`, the bytes Brotli-compressed
//            when `z` says so (the caches of JSON answers: a third of their size); a torn record (a killed process, a full
//            disk) fails its length or checksum and is skipped, and the next record still reads.
//   legacy   the file a value had before packs (`legacy(name)`): read when the pack has no record of the name, so a
//            store not yet migrated keeps its hits; `migrate` moves those files into packs (the state restore runs it).
//
// A value is the exact bytes the file held, so `expand` gives the files back byte for byte. A lookup reads its pack and
// searches it backwards (no index kept in memory), so it sees what another process appended a moment before. An
// overwrite (a refreshed registry time list, a refetched page) leaves the old record behind; a pack more than half dead
// is rewritten when it is next overwritten.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { dirname, join } from "node:path";

const NAME = /^[A-Za-z0-9._/-]+$/;
const hash16 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 16);
const COMPACT_MIN = 256 * 1024;

export interface PackRecord {
  name: string;
  /** The record's bytes as stored. */
  data: Buffer;
  /** Whether they are Brotli-compressed. */
  br: boolean;
  /** Offset just past the record. */
  end: number;
}

/** A record's value: its bytes, decompressed. */
export const valueOf = (r: PackRecord): Buffer => (r.br ? brotliDecompressSync(r.data) : Buffer.from(r.data));

/** The record whose header starts at `i` (the `\n` before `{"k":`), if it is whole and its bytes match. */
function recordAt(buf: Buffer, i: number): PackRecord | undefined {
  const nl = buf.indexOf(0x0a, i + 1);
  if (nl < 0) return undefined;
  let h: { k?: unknown; n?: unknown; h?: unknown; z?: unknown };
  try {
    h = JSON.parse(buf.subarray(i + 1, nl).toString("utf8")) as typeof h;
  } catch {
    return undefined;
  }
  if (typeof h.k !== "string" || typeof h.n !== "number" || !Number.isSafeInteger(h.n) || h.n < 0 || typeof h.h !== "string" || (h.z !== undefined && h.z !== "br")) return undefined;
  const end = nl + 1 + h.n;
  if (end > buf.length) return undefined;
  const data = buf.subarray(nl + 1, end);
  return hash16(data) === h.h ? { name: h.k, data, br: h.z === "br", end } : undefined;
}

const HEAD = Buffer.from('\n{"k":');

/** Every valid record of a pack, in file order. */
export function records(buf: Buffer): PackRecord[] {
  const out: PackRecord[] = [];
  for (let pos = 0; pos < buf.length; ) {
    const i = buf.indexOf(HEAD, pos);
    if (i < 0) break;
    const r = recordAt(buf, i);
    if (r) out.push(r);
    pos = r ? r.end : i + 1;
  }
  return out;
}

/** A record of stored bytes (`br`: already compressed). */
const encode = (name: string, data: Uint8Array, br: boolean): Buffer =>
  Buffer.concat([Buffer.from(`\n${JSON.stringify({ k: name, n: data.byteLength, h: hash16(data), ...(br ? { z: "br" } : {}) })}\n`), data]);

const brotli = (data: Uint8Array): Buffer =>
  brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength } });

function readOr(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function append(file: string, data: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a");
  try {
    for (let n = 0; n < data.length; ) n += writeSync(fd, data, n, data.length - n);
  } finally {
    closeSync(fd);
  }
}

export interface PackOptions {
  /** Hex digits of sha256(name) that name the pack: 16^width packs at most. */
  width: number;
  /** Brotli-compress values (text); off for values compressed already. */
  compress?: boolean;
  /** The file a name's value was kept in before packs (read when the pack has no record; moved in by `migrate`). */
  legacy?: (name: string) => string;
  /** Every legacy file, as [name, path] (for `migrate`). */
  legacyFiles?: () => Iterable<[string, string]>;
}

export class Packs {
  readonly dir: string;
  readonly opts: PackOptions;
  constructor(dir: string, opts: PackOptions) {
    this.dir = dir;
    this.opts = opts;
  }

  private record(name: string, value: Uint8Array): Buffer {
    return this.opts.compress ? encode(name, brotli(value), true) : encode(name, value, false);
  }

  bucket(name: string): string {
    return join(this.dir, `${createHash("sha256").update(name).digest("hex").slice(0, this.opts.width)}.pack`);
  }

  private check(name: string): void {
    if (!NAME.test(name) || name.includes("..")) throw new Error(`not a pack entry name: ${name}`);
  }

  /** The newest record of `name` in its pack. */
  private find(buf: Buffer, name: string): PackRecord | undefined {
    const needle = Buffer.from(`\n{"k":${JSON.stringify(name)},`);
    for (let at = buf.length; at >= 0; ) {
      const i = buf.lastIndexOf(needle, at);
      if (i < 0) return undefined;
      const r = recordAt(buf, i);
      if (r && r.name === name) return r;
      at = i - 1;
    }
    return undefined;
  }

  get(name: string): Buffer | undefined {
    this.check(name);
    const buf = readOr(this.bucket(name));
    const r = buf && this.find(buf, name);
    if (r) return valueOf(r);
    const legacy = this.opts.legacy?.(name);
    return legacy ? readOr(legacy) : undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** Appends `name`'s value; a pack whose overwritten records outweigh the live ones is then rewritten. */
  put(name: string, data: string | Uint8Array): void {
    this.check(name);
    const file = this.bucket(name);
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    const before = readOr(file);
    append(file, this.record(name, bytes));
    if (before && this.find(before, name)) this.compact(file);
  }

  /** Rewrites a pack with each name's newest record that `keep` accepts, when `keep` drops one or the pack is more than
   * half overwritten records. Skipped when another writer appended since it was read, so its record stays. Returns the
   * names dropped. */
  compact(file: string, keep: (name: string, data: Buffer) => boolean = () => true): number {
    const buf = readOr(file);
    if (!buf) return 0;
    const newest = new Map<string, PackRecord>();
    for (const r of records(buf)) {
      newest.delete(r.name);
      newest.set(r.name, r);
    }
    const live = [...newest.values()].filter((r) => keep(r.name, valueOf(r)));
    const dropped = newest.size - live.length;
    const bytes = live.reduce((n, r) => n + r.data.length + 64, 0);
    if (!dropped && (buf.length < COMPACT_MIN || buf.length < 2 * bytes)) return 0;
    const tmp = `${file}.${process.pid}.tmp`;
    if (live.length) writeFileSync(tmp, Buffer.concat(live.map((r) => encode(r.name, r.data, r.br))));
    if (statSync(file).size !== buf.length) {
      rmSync(tmp, { force: true });
      return 0;
    }
    if (live.length) renameSync(tmp, file);
    else unlinkSync(file);
    return dropped;
  }

  /** Every pack file. */
  files(): string[] {
    return existsSync(this.dir) ? readdirSync(this.dir).filter((f) => /^[0-9a-f]*\.pack$/.test(f)).sort().map((f) => join(this.dir, f)) : [];
  }

  /** Each name's newest value across the packs. */
  *entries(): Generator<[string, Buffer]> {
    for (const f of this.files()) {
      const newest = new Map<string, PackRecord>();
      for (const r of records(readFileSync(f))) newest.set(r.name, r);
      for (const [name, r] of newest) yield [name, valueOf(r)];
    }
  }

  /**
   * Moves legacy files into packs: a name already packed keeps its packed value. Each pack gets one append, in name
   * order; a legacy file is deleted only once its pack holds it. Returns the files moved.
   */
  migrate(): number {
    if (!this.opts.legacyFiles) return 0;
    const byPack = new Map<string, Array<[string, string]>>();
    for (const [name, path] of this.opts.legacyFiles()) {
      this.check(name);
      const f = this.bucket(name);
      let list = byPack.get(f);
      if (!list) byPack.set(f, (list = []));
      list.push([name, path]);
    }
    let n = 0;
    for (const [file, list] of [...byPack].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const before = readOr(file);
      const add = list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).filter(([name]) => !(before && this.find(before, name)));
      if (add.length) append(file, Buffer.concat(add.map(([name, path]) => this.record(name, readFileSync(path)))));
      for (const [, path] of list) {
        unlinkSync(path);
        pruneEmpty(dirname(path), this.dir);
      }
      n += list.length;
    }
    return n;
  }

  /** The inverse of `migrate`: every packed value back to its legacy file, and the packs removed. */
  expand(): number {
    const legacy = this.opts.legacy;
    if (!legacy) throw new Error(`${this.dir}: no legacy layout to expand to`);
    let n = 0;
    for (const f of this.files()) {
      const newest = new Map<string, PackRecord>();
      for (const r of records(readFileSync(f))) newest.set(r.name, r);
      for (const [name, r] of newest) {
        const p = legacy(name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(`${p}.${process.pid}.tmp`, valueOf(r));
        renameSync(`${p}.${process.pid}.tmp`, p);
        n++;
      }
      unlinkSync(f);
    }
    return n;
  }
}

/** Removes `dir` and its empty parents up to (not including) `stop`, while they are empty. */
function pruneEmpty(dir: string, stop: string): void {
  for (let d = dir; d.startsWith(stop) && d !== stop; d = dirname(d)) {
    try {
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

/** `<dir>/<xx>/<name>.json`, the layout of the classifier and model caches before packs. */
export function hashedLayout(dir: string): Pick<PackOptions, "legacy" | "legacyFiles"> {
  return {
    legacy: (name) => join(dir, name.slice(0, 2), `${name}.json`),
    legacyFiles: function* () {
      if (!existsSync(dir)) return;
      for (const sub of readdirSync(dir).sort()) {
        if (!/^[0-9a-f]{2}$/.test(sub)) continue;
        for (const f of readdirSync(join(dir, sub)).sort())
          if (f.endsWith(".json") && f.startsWith(sub) && NAME.test(f)) yield [f.slice(0, -5), join(dir, sub, f)] as [string, string];
      }
    },
  };
}

/** `<dir>/<name>.json` for any name with slashes, the registry cache's layout before packs. */
export function treeLayout(dir: string): Pick<PackOptions, "legacy" | "legacyFiles"> {
  return {
    legacy: (name) => join(dir, `${name}.json`),
    legacyFiles: function* () {
      const visit = function* (d: string, rel: string): Generator<[string, string]> {
        for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) yield* visit(join(d, e.name), r);
          else if (e.isFile() && e.name.endsWith(".json") && NAME.test(r)) yield [r.slice(0, -5), join(d, e.name)];
        }
      };
      if (existsSync(dir)) yield* visit(dir, "");
    },
  };
}

export const hashedPacks = (dir: string, width: number): Packs => new Packs(dir, { width, compress: true, ...hashedLayout(dir) });

/** The caches kept as packs in the saved state, by their directory under the central store. */
export const PACKED_CACHES: ReadonlyArray<{ dir: string; open: (central: string) => Packs }> = [
  { dir: "cache/classifier", open: (c) => hashedPacks(join(c, "cache", "classifier"), 3) },
  { dir: "cache/llm", open: (c) => hashedPacks(join(c, "cache", "llm"), 3) },
  { dir: "cache/registry", open: (c) => new Packs(join(c, "cache", "registry"), { width: 2, compress: true, ...treeLayout(join(c, "cache", "registry")) }) },
];

/** Moves every legacy cache file of a central store into its packs (after a restore of state saved before packs). */
export function migrateCaches(central: string): number {
  return PACKED_CACHES.reduce((n, c) => n + c.open(central).migrate(), 0);
}

/** Every packed cache back to one file per entry (to compare with, or return to, the layout before packs). */
export function expandCaches(central: string): number {
  return PACKED_CACHES.reduce((n, c) => n + c.open(central).expand(), 0);
}
