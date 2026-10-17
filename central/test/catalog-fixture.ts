// A small catalog store for the prune and export tests: two records on lines 15 and 16 of `next`.
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";

export function rec(id: string, line: string, summary = `Adds ${id}.`): StoredRecord {
  return {
    id,
    technology: "next",
    status: "active",
    revision: 1,
    label_version: 1,
    change_type: "new_option",
    breaking: false,
    surface: "configuration",
    subject: id.split(":")[1]!,
    subject_kind: "literal",
    summary,
    benefit: ["none"],
    releases: [{ component: "pkg:npm/next", version: `${line}.1.0`, date: "2026-01-01", line }],
    prerequisites: [],
    conditions: [],
    requires: [],
    introduces: [],
    terms: ["next.config.js"],
    replaces: [],
    evidence: [{ kind: "release_notes", url: "u", quote: "q", snapshot: `sha256:${"ab".repeat(32)}` }],
    related: [],
    sources: [],
    history: [],
  };
}

export function store(summary?: string): TechStore {
  const s: TechStore = { technology: "next", records: {}, ingested: {} };
  for (const r of [rec("next:a", "15"), rec("next:b", "16", summary)]) s.records[r.id] = r;
  return s;
}
