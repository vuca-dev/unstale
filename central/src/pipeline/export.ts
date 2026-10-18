// Static catalog export (GitHub Pages or any static host): the catalog directory's `v1/` tree as the coverage service
// serves it, written to `<dir>` with a `.nojekyll`. The source is pruned first (prune.ts), so the export holds every
// shard a current index references plus those still inside the grace period, and nothing else; a shard the static
// host last served stays there for 7 days minus the time between exports. Each technology index carries the
// `components` field the service route adds (`servedIndex`, shared with service.ts), so a client reading the static
// copy sees what it would see from the service. Every index, root and referenced shard line is checked by the
// generated Zod, and every referenced shard's size and sha256, before anything replaces `<dir>`. The tree is built in
// a sibling directory and renamed into place, so a partial export is never at `<dir>`. Same catalog in, same bytes.
//
// Shards are hard links to the catalog's files, not copies, when both are on one filesystem (else copies): at 20,000
// technologies the shards are about 3 GB, which a copy would add to the runner's disk every cycle. That is safe because
// a shard is content-addressed (its name carries a prefix of its sha256) and never written in place: publish.ts writes
// a new shard by rename, prune.ts and a new export only unlink, and the deploy's pack (gateway/scripts/pack.ts) only
// reads and unlinks. The linked file is checked to be the one whose bytes were verified (same inode, size and mtime),
// else the verified bytes are written.
//
// With a signing key (UNSTALE_SIGNING_KEY, an Ed25519 private key as PKCS#8 PEM), the root and every index get a
// detached signature beside them (`<file>.sig`, hex), which a release client checks against its compiled-in public
// key. Indexes name their shards' sha256, so signing the indexes covers every shard.
//
// `v1/technologies.json` (signed too) names every exported index with a hash of its served bytes, so a client asks only
// for the indexes of the candidates it names, and only those its cache does not hold: a candidate the catalog does not
// cover costs no request (a 404 for a missing static file would run the Worker, gateway/, whose daily allowance is the
// free plan's scarcest), and neither does an unchanged index, even one served by the Worker.
import { createPrivateKey, sign } from "node:crypto";
import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { DISCOVERY_VERSION } from "../onboarding/discovery.ts";
import { Root, ShardLine, TechIndex, Technologies } from "../schema/catalog.ts";
import { centralDir } from "./paths.ts";
import { pruneCatalog, SHARD_FILE, type PruneOptions, type PruneResult } from "./prune.ts";
import { readJson, sha256 } from "./util.ts";

/** What the service route serves (service.ts); nothing outside it is exported. */
const TECH_FILE = /^[a-z0-9._-]+\.json$/;
const STATUS_FILE = /^[0-9a-f]{64}\.json$/;
/** A saved job's file name, `<sha256(purl)>.json`; anything else in the jobs folder (an editor's or an archiver's
 * file, such as macOS `._*` metadata) is not a job and is never read. */
export const JOB_FILE = STATUS_FILE;
const SHARD_PATH = /^v1\/shards\/[a-z0-9._-]+\/[a-zA-Z0-9._-]+\.jsonl\.gz$/;

/** The onboarding job fields the index route reads. */
export interface DescribedJob {
  technology: string;
  descriptor?: { components: string[] };
}

/** A technology index as served: the published bytes plus, when an onboarding job describes the technology, its
 * `components` (the client counts a technology as in the stack when one names a package the repository uses). */
export function servedIndex(body: Buffer<ArrayBuffer>, technology: string, jobs: Iterable<DescribedJob>): Buffer<ArrayBuffer> {
  // A package covered as part of another's technology (onboarding: one repository and release stream) has no descriptor.
  const descriptor = [...jobs].find((j) => j.technology === technology && j.descriptor)?.descriptor;
  if (!descriptor) return body;
  return Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), components: descriptor.components }));
}

/** The jobs as the service holds them after a start: saved jobs, a descriptor of an older discovery version dropped. */
export function savedJobs(): DescribedJob[] {
  const folder = join(centralDir(), "onboarding", "jobs");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => JOB_FILE.test(f))
    .sort()
    .flatMap((f) => {
      const job = readJson<DescribedJob & { descriptor?: { discovery_version?: number } }>(join(folder, f));
      if (!job) return [];
      return [job.descriptor?.discovery_version === DISCOVERY_VERSION ? job : { technology: job.technology }];
    });
}

/** A signer from an Ed25519 private key (PKCS#8 PEM): the hex signature of the exact bytes served. */
export function catalogSigner(pem: string | undefined = process.env.UNSTALE_SIGNING_KEY): ((data: Buffer) => string) | undefined {
  if (!pem?.trim()) return undefined;
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`UNSTALE_SIGNING_KEY is a ${key.asymmetricKeyType} key, not ed25519`);
  return (data) => sign(null, data, key).toString("hex");
}

export interface ExportResult {
  /** Whether the root and indexes were signed. */
  signed: boolean;
  technologies: number;
  shards: number;
  bytes: number;
  /** Shards exported as hard links to the catalog's files (the rest are copies). */
  linked: number;
  /** Coverage status files exported. */
  coverage: number;
  prune: PruneResult;
}

/** A shard's bytes as read, and the identity (inode, size, mtime) of the file they were read from. */
export interface ReadShard {
  data: Buffer;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** Reads through one descriptor, so a link made afterwards can be checked to be the file that was read. */
function readShard(file: string): ReadShard & { data: Buffer<ArrayBuffer> } {
  const fd = openSync(file, "r");
  try {
    const { ino, size, mtimeMs } = fstatSync(fd);
    return { ino, size, mtimeMs, data: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

/** Places `src` at `dst` (whose directory exists) as a hard link, or as a copy of `data` (the verified bytes of `src`)
 * when the filesystem refuses the link or `src` was replaced since it was read. Returns whether it linked. */
export function placeShard(src: string, dst: string, read: ReadShard, link: (src: string, dst: string) => void = linkSync): boolean {
  try {
    link(src, dst);
    // lstat, not stat: a link to a symlink (as Linux makes) would pass on its target's identity while the exported
    // path resolves wherever the symlink points. Only a regular file that is the one read is kept.
    const s = lstatSync(dst);
    if (s.isFile() && s.ino === read.ino && s.size === read.size && s.mtimeMs === read.mtimeMs && s.size === read.data.length) return true;
    rmSync(dst);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Another filesystem, or one without hard links (or at its link limit): copy instead.
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"].includes(code ?? "")) throw e;
  }
  writeFileSync(dst, read.data);
  return false;
}

/** A previous export or an empty directory may be replaced; anything else is refused. */
function replaceable(dir: string): boolean {
  if (!existsSync(dir)) return true;
  const entries = readdirSync(dir);
  return !entries.length || (entries.includes(".nojekyll") && existsSync(join(dir, "v1", "root.json")));
}

export function exportCatalog(
  source: string,
  dir: string,
  opts: { now?: Date; jobs?: DescribedJob[]; lock?: PruneOptions["lock"]; statuses?: string; sign?: ((data: Buffer) => string) | undefined } = {},
): ExportResult {
  const signer = "sign" in opts ? opts.sign : catalogSigner();
  const src = resolve(source);
  const out = resolve(dir);
  if (!relative(src, out).startsWith("..") || !relative(out, src).startsWith("..")) throw new Error(`export directory ${out} overlaps the catalog ${src}`);
  if (!replaceable(out)) throw new Error(`${out} is neither empty nor a previous export (no .nojekyll and v1/root.json); refusing to replace it`);
  const root = readFileSync(join(src, "v1", "root.json"));
  Root.parse(JSON.parse(root.toString()));
  const prune = pruneCatalog(src, { ...(opts.now ? { now: opts.now } : {}), ...(opts.lock ? { lock: opts.lock } : {}) });
  const jobs = opts.jobs ?? savedJobs();

  const tmp = join(dirname(out), `.${basename(out)}.partial-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  const put = (path: string, data: Buffer | string): void => {
    mkdirSync(dirname(join(tmp, path)), { recursive: true });
    writeFileSync(join(tmp, path), data);
  };
  let linked = 0;
  const putShard = (path: string, read: ReadShard): void => {
    mkdirSync(dirname(join(tmp, path)), { recursive: true });
    if (placeShard(join(src, path), join(tmp, path), read)) linked++;
  };
  const putSigned = (path: string, data: Buffer): void => {
    put(path, data);
    if (signer) put(`${path}.sig`, signer(data));
  };
  try {
    const shards = new Set<string>();
    // No prototype: an index named `__proto__` is a key like any other, not lost to the inherited setter.
    const technologies: Record<string, string> = Object.create(null);
    let bytes = 0;
    const techDir = join(src, "v1", "tech");
    for (const f of (existsSync(techDir) ? readdirSync(techDir) : []).filter((f) => TECH_FILE.test(f)).sort()) {
      const body = readFileSync(join(techDir, f));
      const parsed = TechIndex.safeParse(JSON.parse(body.toString()));
      if (!parsed.success) throw new Error(`v1/tech/${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      // Shards before the index that references them, each checked against the index.
      for (const s of parsed.data.shards) {
        const path = s.path.startsWith("v1/") ? s.path : `v1/${s.path}`;
        if (!SHARD_PATH.test(path)) throw new Error(`v1/tech/${f}: shard path ${s.path} is not servable`);
        const file = join(src, path);
        if (!existsSync(file)) throw new Error(`v1/tech/${f}: shard ${path} missing`);
        const read = readShard(file);
        const gz = read.data;
        if (gz.length !== s.bytes || sha256(gz) !== s.sha256) throw new Error(`v1/tech/${f}: shard ${path} does not match its size and sha256`);
        if (!shards.has(path)) {
          const lines = gunzipSync(gz).toString("utf8").trimEnd().split("\n");
          if (lines.length !== s.records) throw new Error(`${path}: ${lines.length} lines, index says ${s.records}`);
          for (const l of lines) ShardLine.parse(JSON.parse(l));
          putShard(path, read);
          shards.add(path);
          bytes += gz.length;
        }
      }
      const served = servedIndex(body, f.slice(0, -5), jobs);
      putSigned(`v1/tech/${f}`, served);
      technologies[f.slice(0, -5)] = sha256(served).slice(0, 16);
    }
    // Shards no index names that survived the prune: inside the grace period, copied as published.
    const shardDir = join(src, "v1", "shards");
    for (const tech of existsSync(shardDir) ? readdirSync(shardDir).sort() : []) {
      for (const name of readdirSync(join(shardDir, tech)).filter((n) => SHARD_FILE.test(n)).sort()) {
        const path = `v1/shards/${tech}/${name}`;
        if (shards.has(path) || !SHARD_PATH.test(path)) continue;
        const read = readShard(join(src, path));
        putShard(path, read);
        shards.add(path);
        bytes += read.data.length;
      }
    }
    // Coverage status per package (written by `coverage drain`), so a static host can answer `GET /coverage`:
    // `v1/coverage/<sha256(purl)>.json`, each checked to name the package its file is named for.
    let coverage = 0;
    const statusDir = opts.statuses ?? join(centralDir(), "onboarding", "status");
    for (const f of (existsSync(statusDir) ? readdirSync(statusDir) : []).filter((f) => STATUS_FILE.test(f)).sort()) {
      const body = readFileSync(join(statusDir, f));
      const status = JSON.parse(body.toString()) as { purl?: unknown; technology?: unknown };
      if (typeof status.purl !== "string" || `${sha256(status.purl)}.json` !== f || typeof status.technology !== "string")
        throw new Error(`coverage status ${f} does not name the package it is filed under`);
      put(`v1/coverage/${f}`, body);
      coverage++;
    }
    put(".nojekyll", "");
    // Checked against the schema, but the map itself is written: a parsed copy is an ordinary object again.
    Technologies.parse({ schema: 1, technologies });
    putSigned("v1/technologies.json", Buffer.from(JSON.stringify({ schema: 1, technologies })));
    putSigned("v1/root.json", root);
    // The swap: a previous export moves aside, the new tree takes its name, the old one is removed.
    const old = join(dirname(out), `.${basename(out)}.old-${process.pid}`);
    if (existsSync(out)) renameSync(out, old);
    renameSync(tmp, out);
    rmSync(old, { recursive: true, force: true });
    return { signed: !!signer, technologies: Object.keys(technologies).length, shards: shards.size, bytes, linked, coverage, prune };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

