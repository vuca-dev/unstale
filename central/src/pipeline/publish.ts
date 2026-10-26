// Publishing: one gzipped JSON-lines shard per technology and release line, named by content hash; then the
// technology's index; the root. Every line is validated by the generated Zod before it is written. Same store in,
// byte-identical files out. Shards the new index no longer names are recorded in the technology's history (prune.ts) so
// a prune can delete them after the grace period.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Root, ShardLine, TechIndex } from "../schema/catalog.ts";
import { recordReplacedIndex } from "./prune.ts";
import { highestLine, type StoredRecord, type TechStore } from "./store.ts";
import { canonical, compareVersions, sha256, writeAtomic } from "./util.ts";

export const MIN_CLIENT = "0.1.0";

/** The published line for a record; validated by the generated Zod unless `validate` is false (the caller checks). */
export function shardLine(r: StoredRecord, validate = true, counts?: Record<string, number>): ShardLine {
  const parse = (v: unknown): ShardLine => (validate ? ShardLine.parse(v) : (v as ShardLine));
  if (r.status === "merged") return parse({ status: "merged", id: r.id, merged_into: r.merged_into });
  if (r.status === "retracted") return parse({ status: "retracted", id: r.id });
  return parse({
    status: "active",
    id: r.id,
    technology: r.technology,
    revision: r.revision,
    label_version: r.label_version,
    change_type: r.change_type,
    breaking: r.breaking,
    surface: r.surface,
    subject: r.subject,
    subject_kind: r.subject_kind,
    ...(r.facet ? { facet: r.facet } : {}),
    summary: r.summary,
    benefit: r.benefit,
    releases: r.releases,
    prerequisites: r.prerequisites,
    conditions: r.conditions,
    requires: r.requires,
    introduces: r.introduces,
    // Own keys only: a term such as `constructor` must not read Object.prototype.
    terms: r.terms.map((t) => [t, counts && Object.hasOwn(counts, t) ? counts[t]! : 0]),
    replaces: r.replaces,
    evidence: r.evidence,
    related: r.related,
    ...(r.supersedes ? { supersedes: r.supersedes } : {}),
    ...(r.classifier ? { classifier: r.classifier } : {}),
    ...(r.advisories?.length ? { advisories: r.advisories } : {}),
  });
}

export const lineOf = (r: StoredRecord): string => (r.status === "active" ? highestLine(r) : (r.stub_line ?? "0"));

export interface PublishResult {
  index: TechIndex;
  bytes: number;
  written: number;
}

/** The term-rarity sample a technology publishes with (sample.ts); without one, counts are 0 and `sample_n` is 0. */
export interface PublishedSample {
  n: number;
  repos: Array<{ repo: string; commit: string }>;
  counts: Record<string, number>;
}

/** Every term of the store's active records (what a sample must have counted before publishing). */
export const activeTerms = (store: TechStore): string[] =>
  [...new Set(Object.values(store.records).filter((r) => r.status === "active").flatMap((r) => r.terms))].sort();

export function publishTechnology(store: TechStore, checked: string, outDir: string, sample?: PublishedSample, now = new Date()): PublishResult {
  const byLine = new Map<string, string[]>();
  for (const r of Object.values(store.records).sort((a, b) => a.id.localeCompare(b.id))) {
    const line = lineOf(r);
    const text = canonical(shardLine(r, true, sample?.counts));
    byLine.set(line, [...(byLine.get(line) ?? []), text]);
  }
  const shards: TechIndex["shards"] = [];
  let bytes = 0;
  let written = 0;
  for (const line of [...byLine.keys()].sort(compareVersions)) {
    const lines = byLine.get(line)!;
    const gz = gzipSync(Buffer.from(lines.join("\n") + "\n"), { level: 9 });
    const digest = sha256(gz);
    const path = `v1/shards/${store.technology}/${line}.${digest.slice(0, 16)}.jsonl.gz`;
    const file = join(outDir, path);
    // Immutable: an existing file with this name already has these bytes.
    if (!existsSync(file)) {
      writeAtomic(file, gz);
      written++;
    }
    shards.push({ line, path, sha256: digest, bytes: gz.length, records: lines.length });
    bytes += gz.length;
  }
  // Shards first, then the index that references them.
  const index = TechIndex.parse({
    schema: 1,
    technology: store.technology,
    sample_n: sample?.n ?? 0,
    checked,
    shards,
    ...(sample?.n ? { sample: sample.repos.map((r) => ({ repo: r.repo, commit: r.commit })) } : {}),
    // The release index with its derived lines (lines.ts), when the store has one.
    ...(store.releaseIndex?.releases.length ? { releases: store.releaseIndex.releases } : {}),
    // The affected APIs of the technology's advisories (advisory-apis.ts), for advisories no record locates.
    ...(store.advisoryApis?.length ? { advisory_apis: store.advisoryApis } : {}),
  });
  recordReplacedIndex(outDir, store.technology, shards.map((s) => s.path), now);
  writeIfChanged(join(outDir, "v1", "tech", `${store.technology}.json`), JSON.stringify(JSON.parse(canonical(index)), null, 1) + "\n");
  writeIfChanged(join(outDir, "v1", "root.json"), JSON.stringify(JSON.parse(canonical(Root.parse({ schema: 1, min_client: MIN_CLIENT }))), null, 1) + "\n");
  return { index, bytes, written };
}

function writeIfChanged(file: string, text: string): void {
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  writeAtomic(file, text);
}
