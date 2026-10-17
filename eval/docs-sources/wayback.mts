// Compressed-timeline test of the docs daily pass for sites with no docs repo. For every site-only package in the
// resolver sample, takes the Internet Archive's distinct captures of the site's docs pages over the last N days,
// samples pages that changed, and runs consecutive captures through the module's own HTML extraction, normalisation,
// section diff and attribution. Measures what share of byte changes survive extraction (template noise absorbed), and
// the kind and version share of the section changes that remain. Polite: one request at a time, paced, with backoff on
// 429. Responses are cached under --cache.
//
//   cd central && npx tsx ../eval/docs-sources/wayback.mts <out.json> [--days 90] [--pages 10] [--captures 4] [--cache <dir>]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_HTTP, HttpClient } from "../../central/src/collector/http.ts";
import { extract } from "../../central/src/collector/extract.ts";
import { normalize } from "../../central/src/collector/normalize.ts";
import { WatchSpec } from "../../central/src/collector/schema.ts";
import { sectionDiff } from "../../central/src/collector/sections.ts";
import { attribute, guideMajor, type Attribution } from "../../central/src/docs/attribute.ts";
import { latestVersion } from "../../central/src/docs/monitor.ts";
import { sleep } from "../../central/src/pipeline/util.ts";
import { noiseOf, type Noise } from "./materiality.mts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { days: { type: "string", default: "90" }, pages: { type: "string", default: "10" }, captures: { type: "string", default: "4" }, cache: { type: "string" }, only: { type: "string" } },
});
const OUT = positionals[0] ?? "wayback-results.json";
const DAYS = Number(values.days);
const CACHE = values.cache ?? join(process.env.TMPDIR ?? "/tmp", "docs-wayback-cache");
mkdirSync(CACHE, { recursive: true });
const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
const START = new Date(today.getTime() - DAYS * 86_400_000);
const stamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const HTML = WatchSpec.parse({ id: "x", url: "https://x.invalid/", format: "html" });
const http = new HttpClient(DEFAULT_HTTP);
let requests = 0;

async function archive(url: string): Promise<{ status: number; type: string | null; text: string }> {
  const path = join(CACHE, createHash("sha256").update(url).digest("hex") + ".json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  // The archive penalises retries during a 429: wait long, try few times, and give up on the request after that.
  for (let attempt = 0; ; attempt++) {
    await sleep(4000);
    requests++;
    let out: { status: number; type: string | null; text: string };
    try {
      const r = await fetch(url, { headers: { "user-agent": "unstale-docs-replay" }, signal: AbortSignal.timeout(120_000) });
      out = { status: r.status, type: r.headers.get("content-type"), text: await r.text() };
    } catch (e) {
      out = { status: 0, type: null, text: String(e) };
    }
    if ((out.status === 429 || out.status === 0 || out.status >= 500) && attempt < 2) {
      console.error(`  ${out.status || "timeout"} from the archive; waiting 15 min`);
      await sleep(900_000);
      continue;
    }
    if (out.status === 200 || out.status === 404) writeFileSync(path, JSON.stringify(out));
    return out;
  }
}

function sitePrefix(site: string): { host: string; prefix: string } {
  const u = new URL(site);
  const segs = u.pathname.split("/").filter(Boolean);
  return { host: u.hostname, prefix: /^docs?\./.test(u.hostname) || !segs.length ? "" : "/" + segs[0] };
}

interface Sec { site: string; url: string; from: string; to: string; path: string[]; status: string; attribution: Attribution; noise: Noise; chars: number; hunks: string }
interface SiteResult {
  site: string; purls: string[]; latest?: string | undefined; captured: number; changedPages: number; sampled: number;
  pairs: number; identicalText: number; failed: number; sections: number; error?: string;
}

const sites = new Map<string, string[]>();
for (const f of ["stage1-results.json", "stage2-results.json", "stage3-results.json"]) {
  for (const r of JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8")) as any[]) {
    if (r.answer?.kind !== "site-only" || !r.answer.pages) continue; // a site with no listed pages has nothing to replay
    const { host, prefix } = sitePrefix(r.answer.site);
    const key = `https://${host}${prefix}`;
    sites.set(key, [...(sites.get(key) ?? []), r.purl]);
  }
}
const list = [...sites].filter(([s]) => !values.only || s.includes(values.only));
console.error(`${list.length} sites, ${DAYS} days from ${START.toISOString().slice(0, 10)}`);

const secs: Sec[] = [];
const results: SiteResult[] = [];
for (const [site, purls] of list) {
  const latest = await latestVersion(http, purls[0]!.replace("%40", "@"));
  const maxMajor = latest?.split(".")[0];
  const res: SiteResult = { site, purls, latest, captured: 0, changedPages: 0, sampled: 0, pairs: 0, identicalText: 0, failed: 0, sections: 0 };
  results.push(res);
  const { host, prefix } = sitePrefix(site);
  // Distinct captures (adjacent duplicates collapsed), from 60 days before the window so each page has a baseline.
  const from = stamp(new Date(START.getTime() - 60 * 86_400_000));
  const cdx = await archive(`https://web.archive.org/cdx/search/cdx?url=${host}${prefix}/&matchType=prefix&from=${from}&to=${stamp(today)}&output=json&fl=timestamp,original,digest&filter=statuscode:200&filter=mimetype:text/html&collapse=digest&limit=5000`);
  if (cdx.status !== 200) {
    res.error = `CDX ${cdx.status}`;
    console.error(`${site}: ${res.error}`);
    continue;
  }
  const rows: string[][] = cdx.text.trim() ? JSON.parse(cdx.text).slice(1) : [];
  const byPage = new Map<string, Array<{ ts: string; url: string; digest: string }>>();
  for (const [ts, url, digest] of rows) {
    const u = new URL(url!);
    const key = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
    if (u.search || /\.(css|js|png|svg|json|xml|txt)$/i.test(u.pathname)) continue;
    const caps = byPage.get(key) ?? [];
    if (caps.at(-1)?.digest !== digest) caps.push({ ts: ts!, url: url!, digest: digest! });
    byPage.set(key, caps);
  }
  res.captured = byPage.size;
  const windowStart = stamp(START);
  const changed = [...byPage].filter(([, c]) => c.length >= 2 && c.some((x, i) => i > 0 && x.ts >= windowStart));
  res.changedPages = changed.length;
  // A deterministic sample: pages ordered by a hash of their address.
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  const sample = changed.sort(([a], [b]) => h(a).localeCompare(h(b))).slice(0, Number(values.pages));
  res.sampled = sample.length;
  for (const [, caps] of sample) {
    const firstIn = caps.findIndex((x) => x.ts >= windowStart);
    const use = caps.slice(Math.max(0, firstIn - 1)).slice(0, Number(values.captures));
    let before: string | undefined;
    let beforeTs = "";
    for (const c of use) {
      const r = await archive(`https://web.archive.org/web/${c.ts}id_/${c.url}`);
      let text: string | undefined;
      try {
        text = r.status === 200 ? normalize(extract(HTML, r.type, r.text), HTML.normalize) : undefined;
      } catch {
        text = undefined;
      }
      if (text === undefined) {
        res.failed++;
        continue;
      }
      if (before !== undefined) {
        res.pairs++;
        const changes = sectionDiff(before, text);
        if (!changes.length) res.identicalText++; // the bytes changed, the extracted text did not
        const gm = guideMajor(c.url, text);
        for (const s of changes) {
          secs.push({ site, url: c.url, from: beforeTs, to: c.ts, path: s.path, status: s.status, attribution: attribute(s, { guideMajor: gm, maxMajor }), noise: noiseOf(s.hunks), chars: s.hunks.length, hunks: s.hunks.slice(0, 4000) });
          res.sections++;
        }
      }
      before = text;
      beforeTs = c.ts;
    }
  }
  console.error(`${site}: ${res.captured} pages captured, ${res.changedPages} changed, ${res.sampled} sampled, ${res.pairs} pairs (${res.identicalText} identical text), ${res.sections} sections; ${requests} requests so far`);
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), days: DAYS, results, sections: secs }, null, 1) + "\n");
}
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), days: DAYS, results, sections: secs }, null, 1) + "\n");
console.error(`wrote ${OUT}: ${secs.length} sections, ${requests} requests`);
