// Static catalog export (GitHub Pages or any static host): the catalog directory's `v1/` tree as the coverage service
// serves it, written to `<dir>` with a `.nojekyll`. The source is pruned first (prune.ts), so the export holds every
// shard a current index references plus those still inside the grace period, and nothing else; a shard the static
// host last served stays there for 7 days minus the time between exports. Each technology index carries the
// `components` field the service route adds (`servedIndex`, shared with service.ts), so a client reading the static
// copy sees what it would see from the service. Every index, root and referenced shard line is checked by the
// generated Zod, and every referenced shard's size and sha256, before anything replaces `<dir>`. The tree is built in
// a sibling directory and renamed into place, so a partial export is never at `<dir>`. Same catalog in, same bytes.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { DISCOVERY_VERSION } from "../onboarding/discovery.ts";
import { Root, ShardLine, TechIndex } from "../schema/catalog.ts";
import { centralDir } from "./paths.ts";
import { pruneCatalog, SHARD_FILE, type PruneOptions, type PruneResult } from "./prune.ts";
import { readJson, sha256 } from "./util.ts";

/** What the service route serves (service.ts); nothing outside it is exported. */
const TECH_FILE = /^[a-z0-9._-]+\.json$/;
const STATUS_FILE = /^[0-9a-f]{64}\.json$/;
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
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => {
      const job = readJson<DescribedJob & { descriptor?: { discovery_version?: number } }>(join(folder, f));
      if (!job) return [];
      return [job.descriptor?.discovery_version === DISCOVERY_VERSION ? job : { technology: job.technology }];
    });
}

export interface ExportResult {
  technologies: number;
  shards: number;
  bytes: number;
  /** Coverage status files exported. */
  coverage: number;
  prune: PruneResult;
}

/** A previous export or an empty directory may be replaced; anything else is refused. */
function replaceable(dir: string): boolean {
  if (!existsSync(dir)) return true;
  const entries = readdirSync(dir);
  return !entries.length || (entries.includes(".nojekyll") && existsSync(join(dir, "v1", "root.json")));
}

export function exportCatalog(source: string, dir: string, opts: { now?: Date; jobs?: DescribedJob[]; lock?: PruneOptions["lock"]; statuses?: string } = {}): ExportResult {
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
  try {
    const shards = new Set<string>();
    let technologies = 0;
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
        const gz = readFileSync(file);
        if (gz.length !== s.bytes || sha256(gz) !== s.sha256) throw new Error(`v1/tech/${f}: shard ${path} does not match its size and sha256`);
        if (!shards.has(path)) {
          const lines = gunzipSync(gz).toString("utf8").trimEnd().split("\n");
          if (lines.length !== s.records) throw new Error(`${path}: ${lines.length} lines, index says ${s.records}`);
          for (const l of lines) ShardLine.parse(JSON.parse(l));
          put(path, gz);
          shards.add(path);
          bytes += gz.length;
        }
      }
      put(`v1/tech/${f}`, servedIndex(body, f.slice(0, -5), jobs));
      technologies++;
    }
    // Shards no index names that survived the prune: inside the grace period, copied as published.
    const shardDir = join(src, "v1", "shards");
    for (const tech of existsSync(shardDir) ? readdirSync(shardDir).sort() : []) {
      for (const name of readdirSync(join(shardDir, tech)).filter((n) => SHARD_FILE.test(n)).sort()) {
        const path = `v1/shards/${tech}/${name}`;
        if (shards.has(path) || !SHARD_PATH.test(path)) continue;
        const gz = readFileSync(join(src, path));
        put(path, gz);
        shards.add(path);
        bytes += gz.length;
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
    put("v1/root.json", root);
    // The swap: a previous export moves aside, the new tree takes its name, the old one is removed.
    const old = join(dirname(out), `.${basename(out)}.old-${process.pid}`);
    if (existsSync(out)) renameSync(out, old);
    renameSync(tmp, out);
    rmSync(old, { recursive: true, force: true });
    return { technologies, shards: shards.size, bytes, coverage, prune };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

