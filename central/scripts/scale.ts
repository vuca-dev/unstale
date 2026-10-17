// Throughput and memory at N watches, comparable to Slice 2 E4 (changedetection.io: 500 watches
// 40 s first / 86 s changed; 2,000 watches 321 s / 292 s, peak 281 MiB, single core).
// Serves the Node API HTML pages locally under N distinct URLs.
//   tsx scripts/scale.ts [--n 500,2000] [--corpus DIR]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Collector } from "../src/collector/collector.ts";
import { DEFAULT_HTTP, HttpClient } from "../src/collector/http.ts";
import { WatchSpec, type CheckResult } from "../src/collector/schema.ts";
import { FsStore } from "../src/collector/store.ts";

const { values } = parseArgs({
  options: {
    n: { type: "string", default: "500,2000" },
    corpus: { type: "string", default: join(homedir(), "Library/Caches/ati-slice2/replay") },
  },
});
const [FIRST, LAST] = ["v24.10.0", "v24.21.0"];
const load = (v: string) => {
  const dir = join(values.corpus, v);
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".html") && statSync(join(dir, f)).size > 0)
      .map((f) => [f.slice(0, -5), readFileSync(join(dir, f))]),
  );
};
const versions = { [FIRST as string]: load(FIRST as string), [LAST as string]: load(LAST as string) };
let current = FIRST as string;
const pages = [...(versions[FIRST as string] as Map<string, Buffer>).keys()];

const server = createServer((req, res) => {
  const m = /^\/p\/(\d+)\/([\w-]+)\.html$/.exec(req.url ?? "");
  const body = m ? versions[current]?.get(m[2] as string) : undefined;
  if (!body) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

function dirBytes(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += statSync(join(e.parentPath, e.name)).size;
  }
  return total;
}

for (const n of values.n.split(",").map(Number)) {
  current = FIRST as string;
  const dir = await mkdtemp(join(tmpdir(), "unstale-scale-"));
  const collector = new Collector(new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], concurrency: 32, perHost: 32 }), new FsStore(dir));
  const specs = Array.from({ length: n }, (_, i) =>
    WatchSpec.parse({ id: `s${i}`, url: `${base}/p/${i}/${pages[i % pages.length]}.html`, format: "html", selector: "#apicontent" }),
  );
  const pass = async (label: string) => {
    const cpu0 = process.cpuUsage();
    const t = performance.now();
    const rs: CheckResult[] = await collector.checkAll(specs);
    const cpu = process.cpuUsage(cpu0);
    const counts: Record<string, number> = {};
    for (const r of rs) counts[r.outcome.status] = (counts[r.outcome.status] ?? 0) + 1;
    return `${label} ${((performance.now() - t) / 1000).toFixed(1)} s (cpu ${((cpu.user + cpu.system) / 1e6).toFixed(1)} s) ${JSON.stringify(counts)}`;
  };
  const out = [await pass("first"), await pass("recheck-same")];
  current = LAST as string;
  out.push(await pass("recheck-changed"));
  console.log(
    `n=${n}: ${out.join(" | ")} | peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MiB | store ${(dirBytes(dir) / 1e6).toFixed(1)} MB`,
  );
  await rm(dir, { recursive: true, force: true });
}
server.close();
