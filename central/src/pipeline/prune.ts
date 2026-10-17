// Shard prune after the grace period: a shard stays published for 7 days after the last index referencing it, so a
// client mid-sync never gets a 404. The history is one file per technology at `<catalog>/history/<tech>.json`, beside
// the served tree (`v1/`) and never exported: for each shard no longer referenced, when the last index referencing it
// was replaced. The publisher records it (an unchanged index changes nothing, so a rerun leaves every file
// byte-identical); the prune starts the clock of an unreferenced shard it has no history for (published before history
// existed) at first sight, so nothing is deleted on first sight.
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { withTechLockSync } from "./lock.ts";
import { canonical, writeAtomic } from "./util.ts";

export const GRACE_MS = 7 * 24 * 3600 * 1000;
/** A content-addressed shard file name (publish.ts): `<line>.<16 hex>.jsonl.gz`; anything else is left alone. */
export const SHARD_FILE = /^[a-zA-Z0-9._-]+\.[0-9a-f]{16}\.jsonl\.gz$/;

const History = z.strictObject({
  schema: z.literal(1),
  technology: z.string(),
  /** Shard path → when the last index referencing it was replaced (or when the prune first saw it unreferenced). */
  unreferenced_since: z.record(z.string(), z.string()),
});
type History = z.infer<typeof History>;

/** The shard paths an index names; a path without `v1/` is relative to `v1/` (as the client reads it). */
const IndexRefs = z.object({ shards: z.array(z.object({ path: z.string() })) });
const normalize = (p: string): string => (p.startsWith("v1/") ? p : `v1/${p}`);

const historyPath = (dir: string, tech: string): string => join(dir, "history", `${tech}.json`);

function readHistory(dir: string, tech: string): History {
  const file = historyPath(dir, tech);
  const empty: History = { schema: 1, technology: tech, unreferenced_since: {} };
  if (!existsSync(file)) return empty;
  // An unreadable history is not trusted: every unreferenced shard's clock starts again (keeps, never deletes).
  const parsed = History.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : empty;
}

function writeHistory(dir: string, h: History): void {
  const file = historyPath(dir, h.technology);
  const text = JSON.stringify(JSON.parse(canonical(h)), null, 1) + "\n";
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  if (!existsSync(file) && !Object.keys(h.unreferenced_since).length) return;
  writeAtomic(file, text);
}

/** The shard paths of a technology's published index, or undefined when there is none or it cannot be read. */
export function indexRefs(dir: string, tech: string): string[] | undefined {
  try {
    const parsed = IndexRefs.safeParse(JSON.parse(readFileSync(join(dir, "v1", "tech", `${tech}.json`), "utf8")));
    return parsed.success ? parsed.data.shards.map((s) => normalize(s.path)) : undefined;
  } catch {
    return undefined;
  }
}

/** Publisher side, before a technology's new index replaces the old one: the shards the old index named and the new
 * one does not are unreferenced from `now`; the new index's shards are referenced again (no clock). */
export function recordReplacedIndex(dir: string, tech: string, next: string[], now: Date): void {
  const before = indexRefs(dir, tech) ?? [];
  const h = readHistory(dir, tech);
  const keep = new Set(next.map(normalize));
  for (const p of keep) delete h.unreferenced_since[p];
  for (const p of before) if (!keep.has(p)) h.unreferenced_since[p] ??= now.toISOString();
  writeHistory(dir, h);
}

export interface PruneResult {
  /** Shard paths deleted (or that would be, with `dryRun`). */
  deleted: string[];
  /** Unreferenced shards still inside the grace period. */
  kept: string[];
  /** Unreferenced shards seen for the first time: their clock starts now. */
  started: string[];
  referenced: number;
  /** Indexes that could not be read; while there is one, nothing is deleted anywhere. */
  unreadable: string[];
}

export interface PruneOptions {
  now?: Date;
  dryRun?: boolean;
  /** Held per technology around its check and deletion (default: the technology lock, as a publish holds). */
  lock?: <T>(tech: string, fn: () => T) => T;
}

/** Deletes shard files no current index references whose last reference is more than 7 days before `now`. */
export function pruneCatalog(dir: string, opts: PruneOptions = {}): PruneResult {
  const now = opts.now ?? new Date();
  const lock = opts.lock ?? (<T>(tech: string, fn: () => T) => (opts.dryRun ? fn() : withTechLockSync(tech, "prune", fn)));
  const out: PruneResult = { deleted: [], kept: [], started: [], referenced: 0, unreadable: [] };
  const list = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);
  // Every current index's references, across technologies (a path may name another technology's directory).
  const referenced = new Set<string>();
  for (const f of list(join(dir, "v1", "tech")).filter((f) => f.endsWith(".json"))) {
    const refs = indexRefs(dir, f.slice(0, -5));
    if (!refs) out.unreadable.push(`v1/tech/${f}`);
    for (const p of refs ?? []) referenced.add(p);
  }
  out.referenced = referenced.size;
  for (const tech of list(join(dir, "v1", "shards"))) {
    lock(tech, () => {
      // Read again under the lock: a publish since the first read may name an old shard again.
      const refs = new Set([...referenced, ...(indexRefs(dir, tech) ?? [])]);
      const h = readHistory(dir, tech);
      const present = new Set<string>();
      for (const name of list(join(dir, "v1", "shards", tech)).filter((n) => SHARD_FILE.test(n))) {
        const path = `v1/shards/${tech}/${name}`;
        present.add(path);
        if (refs.has(path)) {
          delete h.unreferenced_since[path];
          continue;
        }
        const since = Date.parse(h.unreferenced_since[path] ?? "");
        if (!Number.isFinite(since)) {
          h.unreferenced_since[path] = now.toISOString();
          out.started.push(path);
        } else if (now.getTime() - since > GRACE_MS && !out.unreadable.length) {
          if (!opts.dryRun) unlinkSync(join(dir, path));
          delete h.unreferenced_since[path];
          out.deleted.push(path);
        } else out.kept.push(path);
      }
      // Entries for files already gone and no longer referenced are dropped.
      for (const p of Object.keys(h.unreferenced_since)) if (!present.has(p) && !refs.has(p)) delete h.unreferenced_since[p];
      if (!opts.dryRun) writeHistory(dir, h);
    });
  }
  return out;
}
