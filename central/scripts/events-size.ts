// Measures the change events a store would publish (events.ts): bytes of the gzipped event shards per technology, per
// technology-year and in total, from the release notes and upgrade guides the store already holds. No network and no
// model call: release lists and guides are read offline. It records and publishes events into the store it is given,
// so run it on a copy:
//
//   UNSTALE_STORE=<copy of a store> npx tsx scripts/events-size.ts [--since 2025-10-15] [--until 2026-10-16]
//
// Docs changes are not read (their notes need each technology's docs store); prints one JSON line.
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pipelineTechnology } from "../src/onboarding/discovery.ts";
import { savedJobs } from "../src/pipeline/export.ts";
import { publishEvents, recordNotes } from "../src/pipeline/events.ts";
import { fetchGuides, fetchReleases } from "../src/pipeline/fetch.ts";
import { centralDir } from "../src/pipeline/paths.ts";
import { SINCE, TECHNOLOGIES, type Technology } from "../src/pipeline/technologies.ts";
import { readJson } from "../src/pipeline/util.ts";

const { values } = parseArgs({ options: { since: { type: "string", default: SINCE }, until: { type: "string" } } });
const releasesDir = join(centralDir(), "releases");
const out = mkdtempSync(join(tmpdir(), "unstale-events-size-"));
const descriptors = new Map(
  savedJobs()
    .filter((j) => j.descriptor)
    .map((j) => [j.technology, j.descriptor as unknown as Parameters<typeof pipelineTechnology>[0]]),
);
const techOf = (id: string): Technology | undefined => TECHNOLOGIES[id] ?? (descriptors.has(id) ? pipelineTechnology(descriptors.get(id)!) : undefined);

const rows: Array<{ tech: string; events: number; chunks: number; text: number; bytes: number; shards: number; largest: number }> = [];
let skipped = 0;
let until = values.until ?? "";
for (const id of existsSync(releasesDir) ? readdirSync(releasesDir).sort() : []) {
  const t = techOf(id);
  if (!t || !existsSync(join(releasesDir, id, "index.json"))) {
    skipped++;
    continue;
  }
  const checked = readJson<{ checked: string }>(join(releasesDir, id, "index.json"))?.checked ?? "";
  if (!values.until && checked > until) until = checked.slice(0, 10);
  const { notes } = await fetchReleases(t, { offline: true });
  recordNotes(t, "releases", notes);
  try {
    recordNotes(t, "guides", await fetchGuides(t, notes, { offline: true }));
  } catch {
    // A guide that cannot be read offline: release notes only.
  }
  const p = publishEvents(t.id, out);
  const events = readJson<{ events: Record<string, { chunks: Array<{ text: string }> }> }>(join(centralDir(), "events", id, "notes.json"))?.events ?? {};
  const all = Object.values(events);
  rows.push({
    tech: id,
    events: all.length,
    chunks: all.reduce((n, e) => n + e.chunks.length, 0),
    text: all.reduce((n, e) => n + e.chunks.reduce((m, c) => m + Buffer.byteLength(c.text), 0), 0),
    bytes: p.bytes,
    shards: p.refs.length,
    largest: Math.max(0, ...p.refs.map((r) => r.bytes)),
  });
}
const years = (Date.parse(until) - Date.parse(values.since!)) / (365.25 * 86_400_000);
const sum = (k: keyof (typeof rows)[number]) => rows.reduce((n, r) => n + (r[k] as number), 0);
const withEvents = rows.filter((r) => r.events);
const sorted = withEvents.map((r) => r.bytes).sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
console.log(
  JSON.stringify({
    window: { since: values.since, until, years: Number(years.toFixed(2)) },
    technologies: rows.length,
    with_events: withEvents.length,
    skipped,
    events: sum("events"),
    chunks: sum("chunks"),
    text_bytes: sum("text"),
    shard_bytes: sum("bytes"),
    shards: sum("shards"),
    bytes_per_event: Math.round(sum("bytes") / Math.max(1, sum("events"))),
    bytes_per_technology_year: { all: Math.round(sum("bytes") / rows.length / years), with_events: Math.round(sum("bytes") / Math.max(1, withEvents.length) / years) },
    per_technology_bytes: { p50: q(0.5), p90: q(0.9), max: sorted.at(-1) ?? 0 },
    largest_shard: Math.max(0, ...rows.map((r) => r.largest)),
    top: [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((r) => `${r.tech} ${r.bytes}`),
  }),
);
