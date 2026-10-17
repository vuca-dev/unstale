// Run the collector over a watch list.
//   collect <watches.json> [--store DIR] [--report FILE] [--concurrency N] [--per-host N] [--allow-host HOST]... [--allow-private]
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { Collector } from "./collector.ts";
import { DEFAULT_HTTP, HttpClient } from "./http.ts";
import { WatchSpec } from "./schema.ts";
import { FsStore } from "./store.ts";
import { findTemplateChanges } from "./template.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    store: { type: "string", default: ".store" },
    report: { type: "string" },
    concurrency: { type: "string", default: String(DEFAULT_HTTP.concurrency) },
    "per-host": { type: "string", default: String(DEFAULT_HTTP.perHost) },
    "allow-private": { type: "boolean", default: false },
    "allow-host": { type: "string", multiple: true, default: [] },
  },
});
const file = positionals[0];
if (!file) {
  console.error("usage: collect <watches.json> [--store DIR] [--report FILE]");
  process.exit(2);
}

const specs = z.array(WatchSpec).parse(JSON.parse(await readFile(file, "utf8")));
const http = new HttpClient({
  ...DEFAULT_HTTP,
  concurrency: Number(values.concurrency),
  perHost: Number(values["per-host"]),
  allowPrivate: values["allow-private"],
  allowHosts: values["allow-host"],
});
const started = performance.now();
const cpu0 = process.cpuUsage();
const results = await new Collector(http, new FsStore(values.store)).checkAll(specs);
const cpu = process.cpuUsage(cpu0);

const counts: Record<string, number> = {};
for (const r of results) {
  const key = r.outcome.status === "failed" ? `failed:${r.outcome.failure}` : r.outcome.status;
  counts[key] = (counts[key] ?? 0) + 1;
}
const templates = findTemplateChanges(results);
const templated = new Set(templates.flatMap((t) => t.ids));
const summary = {
  watches: results.length,
  wallS: +((performance.now() - started) / 1000).toFixed(2),
  cpuS: +((cpu.user + cpu.system) / 1e6).toFixed(2),
  peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  outcomes: counts,
  templateEvents: templates.map((t) => ({ host: t.host, pages: t.ids.length, added: t.added.length, removed: t.removed.length })),
};
console.log(JSON.stringify(summary));
for (const r of results) {
  if (r.outcome.status === "failed") console.log(`  ${r.outcome.failure}: ${r.url} — ${r.outcome.detail}`);
  if (r.outcome.status === "changed" && !templated.has(r.id)) {
    const flap = r.outcome.revertsTo ? ` — reverts to snapshot from ${r.outcome.revertsTo} (flapping?)` : "";
    console.log(`  changed: ${r.url} (+${r.outcome.diff.added.length} -${r.outcome.diff.removed.length})${flap}`);
  }
}
if (values.report) await writeFile(values.report, JSON.stringify({ summary, templates, results }, null, 1));
process.exitCode = results.some((r) => r.outcome.status === "failed") ? 1 : 0;
