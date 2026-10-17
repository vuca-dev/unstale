// Run Markdown copy discovery over the HTML watches in a watch list and print what was found.
//   tsx scripts/discover.ts <watches.json> [--out FILE]
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { discoverMany } from "../src/collector/discover.ts";
import { DEFAULT_HTTP, HttpClient } from "../src/collector/http.ts";
import { WatchSpec } from "../src/collector/schema.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" } } });
const specs = z.array(WatchSpec).parse(JSON.parse(await readFile(positionals[0] as string, "utf8"))).filter((s) => s.format === "html");
const http = new HttpClient({ ...DEFAULT_HTTP, perHost: 2, concurrency: 12 });

const t0 = performance.now();
const results = await discoverMany(http, specs.map((s) => s.url));
const byHost = new Map<string, { n: number; found: number; methods: Record<string, number>; cov: number[]; rejected: string[] }>();
for (const r of results) {
  const host = new URL(r.page).host;
  const h = byHost.get(host) ?? { n: 0, found: 0, methods: {}, cov: [], rejected: [] };
  byHost.set(host, h);
  h.n++;
  if ("error" in r) {
    h.rejected.push(r.error);
    continue;
  }
  if (r.copy) {
    h.found++;
    h.methods[r.copy.method] = (h.methods[r.copy.method] ?? 0) + 1;
    h.cov.push(r.copy.coverage);
  } else {
    const best = r.candidates.filter((c) => c.coverage !== undefined).sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0))[0];
    h.rejected.push(best ? `${best.method} coverage ${best.coverage}` : r.candidates.map((c) => c.reason).join("; ").slice(0, 120));
  }
}
const found = [...byHost.values()].reduce((a, h) => a + h.found, 0);
console.log(`pages ${results.length}, copies accepted ${found}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
for (const [host, h] of [...byHost].sort()) {
  const med = h.cov.sort()[Math.floor(h.cov.length / 2)];
  console.log(`${host.padEnd(28)} ${h.found}/${h.n} ${JSON.stringify(h.methods)} ${med !== undefined ? `median coverage ${med}` : ""}${h.rejected.length ? `  rejected: ${[...new Set(h.rejected)].slice(0, 3).join(" | ")}` : ""}`);
}
if (values.out) await writeFile(values.out, JSON.stringify(results, null, 1));
