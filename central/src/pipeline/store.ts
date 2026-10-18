// The central record store: records per technology, persisted across runs, with two counters: which field bumps
// `revision` and which `label_version`.
import { join } from "node:path";
import type { CapabilityRecord } from "../schema/catalog.ts";
import { centralDir } from "./paths.ts";
import { combineByLine, lineFn, type ReleaseIndex } from "./lines.ts";
import { compareVersions, readJson, writeAtomic } from "./util.ts";

export type Release = CapabilityRecord["releases"][number];
export type Evidence = CapabilityRecord["evidence"][number];

export interface StoredRecord {
  id: string;
  technology: string;
  status: "active" | "merged" | "retracted";
  merged_into?: string;
  /** The shard line a stub stays in (set when the record becomes a stub). */
  stub_line?: string;
  revision: number;
  label_version: number;
  change_type: CapabilityRecord["change_type"];
  breaking: boolean;
  surface: CapabilityRecord["surface"];
  subject: string;
  subject_kind: CapabilityRecord["subject_kind"];
  facet?: string;
  summary: string;
  benefit: CapabilityRecord["benefit"];
  releases: Release[];
  prerequisites: CapabilityRecord["prerequisites"];
  conditions: string[];
  requires: string[];
  introduces: string[];
  /** Search terms; published with a sample count of 0 (no central sample). */
  terms: string[];
  replaces: string[];
  evidence: Evidence[];
  related: string[];
  supersedes?: string;
  classifier?: NonNullable<CapabilityRecord["classifier"]>;
  /** Reviewed security advisories whose fix this record describes (advisories.ts). */
  advisories?: NonNullable<CapabilityRecord["advisories"]>;
  /** Central only: incoming extraction keys folded into this record, and what changed it. */
  sources: string[];
  history: Array<{ action: string; detail?: string; revision: number; label_version: number; judged?: Judged[] }>;
}

/** One candidate's same-or-new judgement at ingest and what the pick made of it (kept for threshold evaluation). */
export interface Judged {
  id: string;
  p: number;
  /** "unasked": retrieved below QUESTION_FLOOR, so no question was asked (p is 0). */
  outcome: "same" | "below" | "unasked" | "not-best" | "guard:breaking" | "guard:advisory" | "guard:quote" | "guard:cross" | "guard:lineage";
}

export interface TechStore {
  technology: string;
  records: Record<string, StoredRecord>;
  /** Incoming extraction key → the record it went into (a rerun skips these). */
  ingested: Record<string, string>;
  /** The technology's release index and derived line depth (lines.ts), recomputed on every run; published in the tech
   * index. Absent in stores written before 16 October 2026 (lines then follow the old rule). */
  releaseIndex?: ReleaseIndex;
}

const path = (tech: string) => join(centralDir(), "records", `${tech}.json`);

export function loadStore(tech: string): TechStore {
  return readJson<TechStore>(path(tech)) ?? { technology: tech, records: {}, ingested: {} };
}

/** Compact JSON: a record store is internal state, never published or signed (the catalog's shards and indexes are
 * written from it, publish.ts), and indentation was 28% of its bytes. A store written indented still reads. */
export function saveStore(s: TechStore): void {
  const records = Object.fromEntries(Object.keys(s.records).sort().map((k) => [k, s.records[k]!]));
  const ingested = Object.fromEntries(Object.keys(s.ingested).sort().map((k) => [k, s.ingested[k]!]));
  writeAtomic(path(s.technology), JSON.stringify({ technology: s.technology, records, ingested, ...(s.releaseIndex ? { releaseIndex: s.releaseIndex } : {}) }) + "\n");
}

/** Fields whose change bumps `revision` (re-opens declines); the rest of the record's fields bump `label_version`. */
export const REVISION_FIELDS = ["change_type", "breaking", "releases", "prerequisites", "requires", "replaces"] as const;
export const LABEL_FIELDS = [
  "surface", "subject", "subject_kind", "facet", "summary", "benefit", "introduces", "terms", "related", "supersedes", "conditions",
  // Advisory ids and ranges annotate the same change; the releases they add bump `revision` on their own.
  "advisories",
] as const;
export type RevisionField = (typeof REVISION_FIELDS)[number];
export type LabelField = (typeof LABEL_FIELDS)[number];
export type EditableField = RevisionField | LabelField;

/** `{technology}:{slug}` from the first extraction's subject and facet; a collision gets `~2`, `~3`, ... */
export function mintId(technology: string, subject: string, facet: string | undefined, taken: (id: string) => boolean): string {
  const slug =
    `${subject} ${facet ?? ""}`
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "change";
  const base = `${technology}:${slug}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}~${n}`)) return `${base}~${n}`;
}

/** The highest release line a record lists: the shard it lives in. */
export function highestLine(r: Pick<StoredRecord, "releases">): string {
  return r.releases.map((x) => x.line).sort(compareVersions).at(-1) ?? "0";
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies field changes and bumps each counter at most once: `revision` if a revision field changed (or `claim`
 * says the meaning of the claim was corrected), `label_version` if a label field changed. Returns what bumped.
 */
export function applyChange(
  r: StoredRecord,
  changes: Partial<Pick<StoredRecord, EditableField>>,
  action: string,
  opts: { claim?: boolean; detail?: string } = {},
): { revision: boolean; label: boolean } {
  let revision = !!opts.claim;
  let label = false;
  const rec = r as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(changes)) {
    if (same(rec[k], v)) continue;
    if (v === undefined) delete rec[k];
    else rec[k] = v;
    if ((REVISION_FIELDS as readonly string[]).includes(k)) revision = true;
    else if ((LABEL_FIELDS as readonly string[]).includes(k)) label = true;
    else throw new Error(`not an editable field: ${k}`);
  }
  if (revision) r.revision++;
  if (label) r.label_version++;
  if (revision || label || opts.detail) {
    r.history.push({ action, ...(opts.detail ? { detail: opts.detail } : {}), revision: r.revision, label_version: r.label_version });
  }
  return { revision, label };
}

/**
 * One release per component and line: the earliest version that shipped the change on that line. `lineOf` gives the
 * line (lines.ts `lineFn` of the store: the derived line); without it, the release's own `line` field (the old rule).
 */
export function combineReleases(a: Release[], b: Release[], lineOf?: (version: string) => string): Release[] {
  if (lineOf) return combineByLine(a, b, lineOf);
  const by = new Map<string, Release>();
  for (const r of [...a, ...b]) {
    const k = `${r.component}\u0000${r.line}`;
    const prev = by.get(k);
    if (!prev || compareVersions(r.version, prev.version) < 0) by.set(k, r);
  }
  return [...by.values()].sort((x, y) => x.component.localeCompare(y.component) || compareVersions(x.line, y.line));
}

export const union = <T,>(a: T[], b: T[]): T[] => [...a, ...b.filter((x) => !a.includes(x))];

/** Turns a record into a merged stub; its evidence and releases move to the target (which keeps its id). */
export function mergeInto(s: TechStore, fromId: string, intoId: string, detail = "manual merge"): void {
  const from = s.records[fromId];
  const into = s.records[intoId];
  if (!from || !into) throw new Error(`unknown record: ${!from ? fromId : intoId}`);
  if (from.status !== "active" || into.status !== "active") throw new Error("both records must be active");
  if (fromId === intoId) throw new Error("cannot merge a record into itself");
  const evidence = [...into.evidence];
  for (const e of from.evidence) if (!evidence.some((x) => x.url === e.url && x.quote === e.quote)) evidence.push(e);
  into.evidence = evidence;
  applyChange(
    into,
    {
      releases: combineReleases(into.releases, from.releases, lineFn(s)),
      breaking: into.breaking || from.breaking,
      terms: union(into.terms, union(from.subject_kind === "literal" ? [from.subject] : [], from.terms)),
      related: into.related.filter((x) => x !== fromId),
      // The advisories the stub held describe the same change; they stay with it (one advisory, one record).
      ...(from.advisories?.length
        ? { advisories: [...(into.advisories ?? []), ...from.advisories.filter((a) => !(into.advisories ?? []).some((x) => x.id === a.id))].sort((x, y) => x.id.localeCompare(y.id)) }
        : {}),
    },
    "merge-target",
    { detail: `${detail}: ${fromId}` },
  );
  into.sources = union(into.sources, from.sources);
  for (const [k, v] of Object.entries(s.ingested)) if (v === fromId) s.ingested[k] = intoId;
  const line = highestLine(from);
  for (const k of Object.keys(from) as Array<keyof StoredRecord>) {
    if (!["id", "technology", "status", "revision", "label_version", "history", "sources"].includes(k)) delete from[k];
  }
  Object.assign(from, { status: "merged", merged_into: intoId, stub_line: line, releases: [], evidence: [] });
  from.history.push({ action: "merged", detail: `${detail} into ${intoId}`, revision: from.revision, label_version: from.label_version });
  // Records that pointed at the stub now point at the target.
  for (const r of Object.values(s.records)) {
    if (r.status === "active" && r.related.includes(fromId)) {
      applyChange(r, { related: union(r.related.filter((x) => x !== fromId), r.id === intoId ? [] : [intoId]) }, "relink");
    }
  }
}

export function retract(s: TechStore, id: string, reason = "manual retraction"): void {
  const r = s.records[id];
  if (!r) throw new Error(`unknown record: ${id}`);
  if (r.status !== "active") throw new Error(`${id} is already ${r.status}`);
  const line = highestLine(r);
  for (const k of Object.keys(r) as Array<keyof StoredRecord>) {
    if (!["id", "technology", "status", "revision", "label_version", "history", "sources"].includes(k)) delete r[k];
  }
  Object.assign(r, { status: "retracted", stub_line: line, releases: [], evidence: [] });
  r.history.push({ action: "retracted", detail: reason, revision: r.revision, label_version: r.label_version });
  for (const o of Object.values(s.records)) {
    if (o.status === "active" && o.related.includes(id)) applyChange(o, { related: o.related.filter((x) => x !== id) }, "unlink");
  }
}
