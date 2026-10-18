// Packs a deploy tree so its file count stays under the static assets limit whatever the number of technologies
// (src/pack.ts says how a packed file is served). Run on the finished tree (catalog export, website, verify-catalog)
// just before `wrangler deploy --assets`:
//
//   node gateway/scripts/pack.ts <site> [--max-files 20000]
//
// Files the Worker serves anyway (coverage statuses, which only the Worker reads, and website pages, routed through it
// by run_worker_first) are always packed: packing them costs no request. The rest stays as it is while the limit
// allows, in the order clients ask for it: the root and its signature and the technology indexes (every sync), the
// indexes' signatures (when an index changed), the shards current indexes name, then everything else (shards in their
// grace period). Whatever does not fit is packed, and each request for it becomes a Worker request. Root files are
// never packed, nor a file whose `_headers` rules differ from those of the probe the Worker copies headers from.
// Prints one JSON line.
//
// Every packed file is read back out of its bucket and compared before the originals are removed; a bucket over the
// 25 MiB file limit, a tree still over the limit, or a `_redirects` file (rules the Worker does not reproduce) fails
// the pack.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { hash } from "blake3-wasm";
import { BUCKETS, PACK_DIR, bucketFile, bucketOf, extensionOf, packable, probeFile, probeUrl, readPacked, redirectProbeUrl, type BucketHeader } from "../src/pack.ts";

/** Workers static assets: the largest file. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The ETag Workers static assets give a file (wrangler's asset hash): blake3 of its base64 and extension, 32 hex. */
export function assetHash(path: string, bytes: Uint8Array): string {
  return encode(hash(encode(bytes, "base64") + extensionOf(path)) as Uint8Array, "hex").slice(0, 32);
}

/** Node's Buffer encodings (this package is typed for the Workers runtime, whose Uint8Array#toString takes none). */
function encode(bytes: Uint8Array, encoding: "base64" | "hex"): string {
  return (Buffer.from(bytes) as unknown as { toString(encoding: string): string }).toString(encoding);
}

/** Packed whatever the limit: only the Worker reads them, or every request for them runs it already. */
const workerServed = (path: string): boolean => path.startsWith("v1/coverage/") || /\/index\.(html|md)$/.test(path);

/** Lower is asked for more often; kept as a file first. */
function tier(path: string, current: Set<string>): number {
  if (/^v1\/[^/]+$/.test(path)) return 0;
  if (/^v1\/tech\/[^/]+\.json$/.test(path)) return 1;
  if (/^v1\/tech\/[^/]+\.json\.sig$/.test(path)) return 2;
  if (current.has(path)) return 3;
  return 4;
}

/** `_headers` rules as the asset layer matches them (path patterns, `*` splats and `:name` placeholders): what each
 * gives a path, in order. */
export function headerRules(text: string): (path: string) => string {
  const rules: { re: RegExp; set: [string, string][]; unset: string[] }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const escaped = line.trim().split("*").map((p) => p.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("(?<splat>.*)");
      rules.push({ re: new RegExp(`^${escaped.replace(/:([A-Za-z]\w*)/g, "(?<$1>[^/]+)")}$`), set: [], unset: [] });
      continue;
    }
    const rule = rules.at(-1);
    if (!rule) continue;
    const t = line.trim();
    if (t.startsWith("!")) rule.unset.push(t.slice(1).trim().toLowerCase());
    else if (t.includes(":")) rule.set.push([t.slice(0, t.indexOf(":")).trim().toLowerCase(), t.slice(t.indexOf(":") + 1).trim()]);
  }
  return (path) =>
    JSON.stringify(
      rules.flatMap(({ re, set, unset }) => {
        const m = re.exec(path);
        if (!m) return [];
        const groups = Object.entries(m.groups ?? {});
        return [[set.map(([k, v]) => [k, groups.reduce((s, [g, x]) => s.replaceAll(`:${g}`, x ?? ""), v)]), unset]];
      }),
    );
}

/** Whether every way the asset layer could answer a packed file gets the same `_headers` rules as the probe the Worker
 * copies them from; a file that would not is kept as it is. */
function probesFaithful(rulesOf: (path: string) => string, file: string): boolean {
  const ext = extensionOf(file);
  const same = (path: string, probe: string) => rulesOf(path) === rulesOf(decodeURIComponent(probe));
  if (ext !== "html") return same(`/${file}`, probeUrl(ext));
  const dir = `/${file.slice(0, -"index.html".length)}`;
  return (
    same(dir, probeUrl("html")) &&
    same(dir.slice(0, -1), redirectProbeUrl("directory", ext)) &&
    same(`${dir}index`, redirectProbeUrl("index", ext)) &&
    same(`${dir}index.html`, redirectProbeUrl("index.html", ext)) &&
    same(`${dir.slice(0, -1)}.html`, redirectProbeUrl("html", ext))
  );
}

function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const path = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, path) : [path];
  });
}

/** The shard paths current indexes name, as served (`v1/shards/…`). */
function currentShards(site: string): Set<string> {
  const dir = join(site, "v1", "tech");
  const out = new Set<string>();
  for (const f of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []) {
    const index = JSON.parse(readFileSync(join(dir, f), "utf8")) as { shards?: { path: string }[] };
    for (const s of index.shards ?? []) out.add(s.path.startsWith("v1/") ? s.path : `v1/${s.path}`);
  }
  return out;
}

export interface PackResult {
  /** Files in the tree before and after. */
  before: number;
  after: number;
  /** Packable files left as they are, and files packed. */
  kept: number;
  packed: number;
  buckets: number;
  /** The largest bucket file, and all of them together. */
  largest_bucket: number;
  bucket_bytes: number;
  /** Packed files by tier (0 the root and its signature, 1 indexes, 2 their signatures, 3 current shards, 4 other;
   * `worker`, those the Worker serves anyway). */
  packed_by_tier: Record<string, number>;
}

export async function pack(site: string, maxFiles = 20_000): Promise<PackResult> {
  if (existsSync(join(site, PACK_DIR))) throw new Error(`${site} is already packed (${PACK_DIR}/ exists)`);
  // Redirect rules apply before any file; the Worker does not reproduce them.
  if (existsSync(join(site, "_redirects"))) throw new Error(`${site}/_redirects: packed files cannot follow redirect rules`);
  const rulesOf = headerRules(existsSync(join(site, "_headers")) ? readFileSync(join(site, "_headers"), "utf8") : "");
  const files = walk(site).sort();
  const current = currentShards(site);
  const canPack = (p: string) => packable(p) && probesFaithful(rulesOf, p);
  const fixed = files.filter((p) => !canPack(p));
  const always = files.filter((p) => canPack(p) && workerServed(p));
  const ranked = files
    .filter((p) => canPack(p) && !workerServed(p))
    .map((p) => [tier(p, current), p] as const)
    .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  // Room for every bucket and a probe per extension that could be packed.
  const exts = new Set(files.filter(canPack).map(extensionOf));
  const room = maxFiles - fixed.length - BUCKETS - exts.size;
  if (room < 0) throw new Error(`${fixed.length} files that cannot be packed leave no room under ${maxFiles}`);
  const packed = [...always, ...ranked.slice(room).map(([, p]) => p)];
  const byTier: Record<string, number> = { worker: always.length };
  for (const [t] of ranked.slice(room)) byTier[t] = (byTier[t] ?? 0) + 1;

  const buckets = new Map<number, string[]>();
  for (const p of packed) {
    const b = bucketOf(p);
    buckets.set(b, [...(buckets.get(b) ?? []), p]);
  }
  let largest = 0;
  let total = 0;
  // A failure part way leaves the tree as it was: no originals are removed before every bucket is written.
  try {
    for (const [b, paths] of buckets) {
      const header: BucketHeader = { files: {} };
      const parts: Buffer[] = [];
      let offset = 0;
      for (const p of paths.sort()) {
        const bytes = readFileSync(join(site, p));
        header.files[p] = [offset, bytes.length, assetHash(p, bytes)];
        parts.push(bytes);
        offset += bytes.length;
      }
      const body = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ...parts]);
      if (body.length > MAX_FILE_BYTES) throw new Error(`${bucketFile(b)}: ${body.length} bytes, over the ${MAX_FILE_BYTES}-byte file limit`);
      // Read back before anything is removed: every file from the header the Worker parses, and the last one through
      // the Worker's own reader (one pass over the bucket, not one per file).
      const { header: read } = await readPacked(new Blob([body]).stream(), "");
      const data = body.subarray(body.indexOf(0x0a) + 1);
      let last = paths[0]!;
      for (const p of paths) {
        const entry = Object.hasOwn(read.files, p) ? read.files[p] : undefined;
        if (!entry || !data.subarray(entry[0], entry[0] + entry[1]).equals(readFileSync(join(site, p)))) throw new Error(`${p} does not read back from ${bucketFile(b)}`);
        if (entry[0] >= read.files[last]![0]) last = p;
      }
      const { file } = await readPacked(new Blob([body]).stream(), last);
      if (!file || !Buffer.from(file.bytes).equals(readFileSync(join(site, last)))) throw new Error(`${last} does not read back from ${bucketFile(b)}`);
      mkdirSync(join(site, PACK_DIR), { recursive: true });
      writeFileSync(join(site, bucketFile(b)), body);
      largest = Math.max(largest, body.length);
      total += body.length;
    }
  } catch (e) {
    rmSync(join(site, PACK_DIR), { recursive: true, force: true });
    throw e;
  }
  for (const p of packed) rmSync(join(site, p));
  for (const ext of new Set(packed.map(extensionOf))) {
    mkdirSync(dirname(join(site, probeFile(ext))), { recursive: true });
    writeFileSync(join(site, probeFile(ext)), "");
  }
  for (const d of new Set(packed.map((p) => dirname(p)))) removeEmpty(site, d);
  const after = walk(site).length;
  if (after > maxFiles) throw new Error(`${after} files after packing, over ${maxFiles}`);
  return {
    before: files.length,
    after,
    kept: ranked.length - (packed.length - always.length),
    packed: packed.length,
    buckets: buckets.size,
    largest_bucket: largest,
    bucket_bytes: total,
    packed_by_tier: byTier,
  };
}

/** Removes a directory left empty, and its parents up to the tree. */
function removeEmpty(site: string, dir: string): void {
  for (let d = dir; d && d !== "."; d = dirname(d)) {
    const abs = join(site, d);
    if (!existsSync(abs) || readdirSync(abs).length) return;
    rmdirSync(abs);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { "max-files": { type: "string", default: "20000" } } });
  const site = positionals[0];
  if (!site || positionals.length !== 1) throw new Error("usage: node gateway/scripts/pack.ts <site> [--max-files N]");
  console.log(JSON.stringify(await pack(site, Number(values["max-files"]))));
}
