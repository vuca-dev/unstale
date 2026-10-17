// D1 (vault: "Docs Sources - Eval"; design: "Source Registry and Coverage" > "Docs sources traced from the package").
// Deterministic chain from a package URL to its official docs site and docs repository, with validation. No model
// calls and no web search. Every HTTP response is cached under $CACHE, so reruns make no requests. The chain is
// central/src/docs/resolve.ts (the docs module); this script is its sample runner.
//
//   cd central && CACHE=<dir> npx tsx ../eval/docs-sources/resolve.mts ../eval/docs-sources/sample-stage1.json <out.json>
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createResolver } from "../../central/src/docs/resolve.ts";

const CACHE = process.env.CACHE ?? "/tmp/docs-sources-cache";
mkdirSync(CACHE, { recursive: true });
const TOKEN = process.env.GITHUB_TOKEN ?? execSync("gh auth token").toString().trim();
const UA = "unstale-docs-sources-eval";
let requests = 0;

interface Res { status: number; url: string; text: string }
async function get(url: string, accept = "text/html,*/*;q=0.8", gh = false): Promise<Res> {
  const key = createHash("sha256").update(accept + " " + url).digest("hex");
  const path = join(CACHE, key + ".json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  requests++;
  let res: Res;
  try {
    const headers: Record<string, string> = { accept, "user-agent": UA };
    if (gh) headers.authorization = `Bearer ${TOKEN}`;
    const r = await fetch(url.replace(/#retry$/, ""), { headers, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await r.arrayBuffer());
    res = { status: r.status, url: r.url, text: buf.length > 80_000_000 ? "" : buf.toString("utf8") };
  } catch (e) {
    res = { status: 0, url, text: String(e).slice(0, 200) };
  }
  if (res.status === 0 && !url.includes("#retry")) return get(url + "#retry", accept, gh);
  if (res.status !== 0) writeFileSync(path, JSON.stringify(res));
  return res;
}

// The resolver itself lives in the docs module; this script supplies the cached fetcher and the sample loop.
const { resolve } = createResolver({ get requests() { return requests; }, get });

const [sampleFile, outFile] = process.argv.slice(2);
const sample = JSON.parse(readFileSync(sampleFile!, "utf8")) as { packages: Array<{ purl: string; expect: string }> };
const results = [];
for (const p of sample.packages) {
  const t0 = Date.now();
  try { results.push({ ...(await resolve(p.purl)), expect: p.expect, seconds: (Date.now() - t0) / 1000 }); }
  catch (e) { results.push({ purl: p.purl, expect: p.expect, error: String(e) }); }
  const r = results.at(-1) as any;
  console.error(`${p.purl}: ${JSON.stringify(r.answer ?? r.error)} (${r.requests ?? 0} req)`);
}
writeFileSync(outFile!, JSON.stringify(results, null, 1));
