// Acceptance test: replay 11 consecutive Node.js 24 releases over all API pages and score
// detection against Git ground truth, side by side with changedetection.io's results (E3).
//   tsx scripts/replay-node.ts [--corpus DIR] [--e3 FILE] [--no-etag]
// Corpus and E3 results come from the Slice 2 harness (~/ati-slice2).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { diffLines } from "diff";
import { Collector } from "../src/collector/collector.ts";
import { DEFAULT_HTTP, HttpClient } from "../src/collector/http.ts";
import { WatchSpec, type CheckResult } from "../src/collector/schema.ts";
import { FsStore } from "../src/collector/store.ts";

const { values } = parseArgs({
  allowNegative: true,
  options: {
    corpus: { type: "string", default: join(homedir(), "Library/Caches/ati-slice2/replay") },
    e3: { type: "string", default: join(homedir(), "ati-slice2/results/e3_replay.json") },
    etag: { type: "boolean", default: true },
  },
});
const CORPUS = values.corpus;
const VERSIONS = Array.from({ length: 12 }, (_, i) => `v24.${10 + i}.0`);

const file = (v: string, name: string) => join(CORPUS, v, name);
const exists = (p: string) => existsSync(p) && statSync(p).size > 0;
const pages = [...new Set(VERSIONS.flatMap((v) => readdirSync(join(CORPUS, v)).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5))))].sort();

// ---- replay server: one release at a time, with ETags so the 304 path is exercised -----
let current = VERSIONS[0] as string;
const server = createServer((req, res) => {
  const m = /^\/(api|md)\/([\w-]+)\.(html|md)$/.exec(req.url ?? "");
  const path = m ? file(current, `${m[2]}.${m[3]}`) : "";
  if (!m || !exists(path)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const body = readFileSync(path);
  const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
  if (values.etag && req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag }).end();
    return;
  }
  const type = m[3] === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8";
  res.writeHead(200, { "content-type": type, ...(values.etag ? { etag } : {}) }).end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const VARIANTS = {
  html: (p: string) => ({ url: `${base}/api/${p}.html`, format: "html" as const }),
  html_css: (p: string) => ({ url: `${base}/api/${p}.html`, format: "html" as const, selector: "#apicontent" }),
  md: (p: string) => ({ url: `${base}/md/${p}.md`, format: "markdown" as const }),
};
type Variant = keyof typeof VARIANTS;
const specs = pages.flatMap((p) =>
  (Object.keys(VARIANTS) as Variant[]).map((v) => WatchSpec.parse({ id: `${v}:${p}`, ...VARIANTS[v](p) })),
);

// ---- ground truth (same definition as E3) ------------------------------------------------
const md = (v: string, p: string) => (exists(file(v, `${p}.md`)) ? readFileSync(file(v, `${p}.md`), "utf8") : "");
function truthLines(a: string, b: string): string[] {
  return diffLines(a, b).filter((d) => d.added || d.removed).flatMap((d) => d.value.split("\n"));
}
const words = (t: string) =>
  new Set([...t.replace(/[`*_#>[\]()<>{}|]/g, " ").matchAll(/[A-Za-z][A-Za-z0-9.]{3,}/g)].map((m) => m[0].toLowerCase()));

// ---- run ---------------------------------------------------------------------------------
const storeDir = await mkdtemp(join(tmpdir(), "unstale-replay-"));
const collector = new Collector(
  new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], concurrency: 32, perHost: 32 }),
  new FsStore(storeDir),
);
const t0 = performance.now();
await collector.checkAll(specs); // baseline at the first release
interface Row { step: string; page: string; variant: Variant; detected: boolean; truth: boolean; covered?: number; wanted?: number; failure?: string }
const rows: Row[] = [];
const timings: number[] = [];
for (let i = 1; i < VERSIONS.length; i++) {
  const prev = VERSIONS[i - 1] as string;
  current = VERSIONS[i] as string;
  const s = performance.now();
  const results = new Map<string, CheckResult>((await collector.checkAll(specs)).map((r) => [r.id, r]));
  timings.push((performance.now() - s) / 1000);
  for (const spec of specs) {
    const [variant, page] = spec.id.split(":") as [Variant, string];
    const o = (results.get(spec.id) as CheckResult).outcome;
    const t = truthLines(md(prev, page), md(current, page));
    const row: Row = { step: current, page, variant, detected: o.status === "changed" || o.status === "first_seen", truth: t.some((l) => l.trim()) };
    if (o.status === "failed" && exists(file(current, `${page}.html`))) row.failure = o.failure;
    if (o.status === "changed" && row.truth) {
      const want = words(t.join(" "));
      const got = words([...o.diff.added, ...o.diff.removed].join(" "));
      row.wanted = want.size;
      row.covered = [...want].filter((w) => got.has(w)).length;
    }
    rows.push(row);
  }
}
const wall = (performance.now() - t0) / 1000;
server.close();
await rm(storeDir, { recursive: true, force: true });

// ---- score, next to changedetection.io ----------------------------------------------------
function score(rs: Array<{ detected: boolean; truth: boolean; covered?: number | undefined; wanted?: number | undefined }>) {
  const tp = rs.filter((r) => r.detected && r.truth).length;
  const fp = rs.filter((r) => r.detected && !r.truth).length;
  const fn = rs.filter((r) => !r.detected && r.truth).length;
  const cov = rs.filter((r) => r.wanted);
  const coverage = cov.reduce((a, r) => a + (r.covered ?? 0), 0) / Math.max(1, cov.reduce((a, r) => a + (r.wanted ?? 0), 0));
  return { tp, fp, fn, recall: +(tp / Math.max(1, tp + fn)).toFixed(3), precision: +(tp / Math.max(1, tp + fp)).toFixed(3), coverage: +coverage.toFixed(3) };
}
const e3 = existsSync(values.e3)
  ? (JSON.parse(readFileSync(values.e3, "utf8")).rows as Array<{ variant: Variant; detected: boolean; truth: boolean; truth_words?: number; covered_words?: number }>)
  : [];
const table = (Object.keys(VARIANTS) as Variant[]).map((v) => ({
  variant: v,
  unstale: score(rows.filter((r) => r.variant === v)),
  changedetection: score(e3.filter((r) => r.variant === v).map((r) => ({ detected: r.detected, truth: r.truth, covered: r.covered_words, wanted: r.truth_words }))),
}));
const failures = rows.filter((r) => r.failure);
console.log(JSON.stringify({ pages: pages.length, steps: VERSIONS.length - 1, wallS: +wall.toFixed(1), stepS: timings.map((t) => +t.toFixed(2)), failures: failures.length }, null, 0));
for (const t of table) console.log(t.variant.padEnd(9), "unstale", JSON.stringify(t.unstale), "\n".padEnd(11), "cd.io  ", JSON.stringify(t.changedetection));
const mismatch = rows.filter((r) => r.detected !== r.truth);
console.log("disagreements with truth:", mismatch.length);
for (const r of mismatch.slice(0, 40)) console.log(`  ${r.variant} ${r.step} ${r.page} detected=${r.detected} truth=${r.truth}`);
if (failures.length) console.log("failures:", failures.slice(0, 10));
