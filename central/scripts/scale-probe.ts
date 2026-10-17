// Scale probe: what a coverage run costs per technology before any model call, measured on a sample of real packages
// (vault: Central Scheduling and Infrastructure, "Storage and hosting at scale"). Per package, as a drain does for a
// new one: discovery, admission, and for an admitted package its release list and a forced docs pass. No extraction,
// classifier, advisory or publish step runs, and every request to a model host is refused and counted (the run fails
// if any is attempted). Packages come from eval/scope/pop.json, the same number per download band, chosen by sha256
// of the name; band populations weight the summary.
//
//   tsx scripts/scale-probe.ts [--per-band 8] [--concurrency 4] [--out <dir>] [--min-github 40]
// A second docs pass right after the baseline measures the steady state when a release lands and nothing changed
// (site signals, conditional requests, the shared page cache); releases in the last 90 days set how often a
// technology's docs are checked under the release gate (docs/extract.ts). Writes <out>/probe.jsonl (one line per
// package) and <out>/summary.json. Run against an empty UNSTALE_STORE, so the
// store's growth is the probe's. Stops starting packages when GitHub's remaining requests fall under --min-github.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HttpClient, DEFAULT_HTTP } from "../src/collector/http.ts";
import { dailyPass } from "../src/docs/extract.ts";
import { discoverTechnology, pipelineTechnology } from "../src/onboarding/discovery.ts";
import { noteTokens } from "../src/onboarding/limits.ts";
import { admit, signals, THRESHOLDS } from "../src/pipeline/admission.ts";
import { npmPurl } from "../src/pipeline/ecosystems.ts";
import { fetchReleases } from "../src/pipeline/fetch.ts";
import { centralDir } from "../src/pipeline/paths.ts";

const MODEL_HOSTS = ["ai-gateway.vercel.sh", "api.openai.com", "api.typesafe.ai", "thejevai.com"];

interface Counter {
  requests: Record<string, number>;
  bytes: Record<string, number>;
}
const scope = new AsyncLocalStorage<Counter>();
const total: Counter = { requests: {}, bytes: {} };
let modelAttempts = 0;
let githubRemaining = Number.POSITIVE_INFINITY;
let githubLimit = 0;

/** Every request: counted per host kind for the package in scope; a model host is refused. */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (MODEL_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
    modelAttempts++;
    throw new Error(`scale probe: model host ${url.hostname} refused`);
  }
  const kind = url.hostname === "api.github.com" ? "github_api" : /(^|\.)github(usercontent)?\.com$/.test(url.hostname) ? "github_web" : /registry\.npmjs\.org|api\.npmjs\.org|pypi\.org|pypistats\.org|ecosyste\.ms/.test(url.hostname) ? "registry" : "docs";
  const res = await realFetch(input, init);
  if (kind === "github_api") {
    const rem = Number(res.headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(rem) && res.headers.get("x-ratelimit-resource") !== "search") {
      githubRemaining = rem;
      githubLimit = Number(res.headers.get("x-ratelimit-limit")) || githubLimit;
    }
  }
  const bytes = Number(res.headers.get("content-length")) || 0;
  for (const c of [total, scope.getStore()]) {
    if (!c) continue;
    c.requests[kind] = (c.requests[kind] ?? 0) + 1;
    c.bytes[kind] = (c.bytes[kind] ?? 0) + bytes;
  }
  return res;
}) as typeof fetch;

/** Bytes under a path (0 when absent). */
function du(path: string): number {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((n, f) => n + du(join(path, f)), 0);
}
/** The store bytes one technology adds: every top-level central folder's entry named for it. */
function storeBytes(id: string): number {
  let n = 0;
  for (const dir of readdirSync(centralDir())) {
    const base = join(centralDir(), dir);
    if (!statSync(base).isDirectory()) continue;
    for (const f of readdirSync(base)) if (f === id || f.startsWith(`${id}.`) || f.startsWith(`${id}-`)) n += du(join(base, f));
  }
  return n;
}

const pep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Row {
  purl: string;
  band: string;
  outcome: "admitted" | "refused" | "no-sources" | "error";
  why?: string;
  ms: { discover: number; admit: number; releases?: number; docs?: number; docs2?: number; total: number };
  releases?: number;
  releases_90d?: number;
  /** The second pass: docs requests, pages checked page by page, sites skipped by a signal. */
  second?: { requests: number; checked: number; quiet: number; sites: number };
  note_tokens?: number;
  docs_pages?: number;
  docs_sites?: number;
  docs_failed?: number;
  store_bytes?: number;
  requests: Record<string, number>;
  bytes: Record<string, number>;
}

async function probe(purl: string, band: string, http: HttpClient): Promise<Row> {
  const c: Counter = { requests: {}, bytes: {} };
  return scope.run(c, async () => {
    const t0 = Date.now();
    const ms: Row["ms"] = { discover: 0, admit: 0, total: 0 };
    const row = (r: Partial<Row>): Row => ({ purl, band, outcome: "error", ...r, ms: { ...ms, total: Date.now() - t0 }, requests: c.requests, bytes: c.bytes });
    try {
      const t = await discoverTechnology(purl);
      ms.discover = Date.now() - t0;
      if (!t.repo && !t.homepage) return row({ outcome: "no-sources" });
      const ta = Date.now();
      const verdict = admit(await signals(purl, t.repo), THRESHOLDS[/^pkg:(\w+)\//.exec(purl)?.[1] ?? ""]);
      ms.admit = Date.now() - ta;
      if (!verdict.admit) return row({ outcome: "refused", why: verdict.why });
      const tech = pipelineTechnology(t);
      const tr = Date.now();
      const releases = t.repo ? await fetchReleases(tech) : { notes: [] };
      ms.releases = Date.now() - tr;
      const td = Date.now();
      const pass = await dailyPass(tech, { http, force: true });
      ms.docs = Date.now() - td;
      const c2: Counter = { requests: {}, bytes: {} };
      const t2 = Date.now();
      const again = await scope.run(c2, () => dailyPass(tech, { http, force: true }));
      ms.docs2 = Date.now() - t2;
      for (const k of Object.keys(c2.requests)) c.requests[`second_${k}`] = c2.requests[k]!;
      const failed = pass ? Object.entries(pass.outcomes).filter(([k]) => k.startsWith("failed")).reduce((n, [, v]) => n + v, 0) : 0;
      return row({
        outcome: "admitted",
        why: verdict.why,
        releases: releases.notes.length,
        releases_90d: releases.notes.filter((n) => Date.now() - Date.parse(n.date) < 90 * 86_400_000).length,
        second: { requests: (c2.requests.docs ?? 0) + (c2.requests.github_api ?? 0), checked: again?.checked ?? 0, quiet: Object.keys(again?.quiet ?? {}).length, sites: again?.sites.length ?? 0 },
        note_tokens: releases.notes.reduce((n, x) => n + noteTokens(x.notes), 0),
        docs_pages: pass?.checked ?? 0,
        docs_sites: pass?.sites.length ?? 0,
        docs_failed: failed,
        store_bytes: storeBytes(tech.id),
      });
    } catch (e) {
      return row({ outcome: "error", why: String(e instanceof Error ? e.message : e).slice(0, 200) });
    }
  });
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "per-band": { type: "string" }, concurrency: { type: "string" }, out: { type: "string" }, "min-github": { type: "string" } },
  });
  const perBand = Number(values["per-band"] ?? 8);
  const concurrency = Number(values.concurrency ?? 4);
  const minGithub = Number(values["min-github"] ?? 40);
  const out = values.out ?? "probe-out";
  mkdirSync(out, { recursive: true });
  const pop = JSON.parse(readFileSync(new URL("../../eval/scope/pop.json", import.meta.url), "utf8")) as Record<string, { population: number; packages: { name: string }[] }>;
  const sample: { purl: string; band: string }[] = [];
  const weight: Record<string, number> = {};
  for (const [band, b] of Object.entries(pop)) {
    const eco = band.startsWith("pypi") ? "pypi" : "npm";
    const picked = [...b.packages].sort((x, y) => sha(x.name).localeCompare(sha(y.name))).slice(0, perBand);
    weight[band] = b.population / Math.max(1, picked.length);
    for (const p of picked) sample.push({ purl: eco === "npm" ? npmPurl(p.name) : `pkg:pypi/${pep503(p.name)}`, band });
  }
  const http = new HttpClient({ ...DEFAULT_HTTP, concurrency: 8, perHost: 2 });
  const rows: Row[] = [];
  const t0 = Date.now();
  let next = 0;
  let stopped = "";
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < sample.length) {
        if (githubRemaining < minGithub) {
          stopped ||= `GitHub requests remaining ${githubRemaining} < ${minGithub}`;
          return;
        }
        const s = sample[next++]!;
        const r = await probe(s.purl, s.band, http);
        rows.push(r);
        appendFileSync(join(out, "probe.jsonl"), JSON.stringify(r) + "\n");
        console.log(`${rows.length}/${sample.length} ${r.outcome.padEnd(10)} ${(r.ms.total / 1000).toFixed(1).padStart(6)}s ${r.purl}${r.docs_pages ? ` docs ${r.docs_pages}` : ""}${r.why && r.outcome !== "admitted" ? ` (${r.why.slice(0, 80)})` : ""}`);
      }
    }),
  );
  const wall = (Date.now() - t0) / 1000;
  const adm = rows.filter((r) => r.outcome === "admitted");
  const per = (f: (r: Row) => number, xs = adm) => ({ p50: q(xs.map(f), 0.5), p90: q(xs.map(f), 0.9), max: q(xs.map(f), 1), mean: Math.round(mean(xs.map(f)) * 10) / 10 });
  // Band-weighted mean over admitted packages: each band's admitted mean, weighted by that band's admitted population.
  const weighted = (f: (r: Row) => number) => {
    let num = 0;
    let den = 0;
    for (const band of Object.keys(pop)) {
      const a = adm.filter((r) => r.band === band);
      if (!a.length) continue;
      const w = weight[band]! * a.length;
      num += w * mean(a.map(f));
      den += w;
    }
    return den ? Math.round((num / den) * 10) / 10 : 0;
  };
  const gh = (r: Row) => r.requests.github_api ?? 0;
  const pages = (r: Row) => r.docs_pages ?? 0;
  const secs = (r: Row) => r.ms.total / 1000;
  const summary = {
    sampled: sample.length,
    probed: rows.length,
    stopped: stopped || undefined,
    wall_s: Math.round(wall),
    concurrency,
    model_requests_refused: modelAttempts,
    outcomes: rows.reduce<Record<string, number>>((m, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {}),
    by_band: Object.fromEntries(Object.keys(pop).map((b) => [b, rows.filter((r) => r.band === b).reduce<Record<string, number>>((m, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {})])),
    admitted: {
      seconds: per(secs),
      docs_seconds: per((r) => (r.ms.docs ?? 0) / 1000),
      github_api_requests: per(gh),
      docs_pages: per(pages),
      docs_requests: per((r) => r.requests.docs ?? 0),
      store_bytes: per((r) => r.store_bytes ?? 0),
      note_tokens: per((r) => r.note_tokens ?? 0),
      weighted_mean: { seconds: weighted(secs), github_api_requests: weighted(gh), docs_pages: weighted(pages), store_bytes: weighted((r) => r.store_bytes ?? 0) },
    },
    // Under the release gate a technology's docs are checked per release, plus one follow-up pass.
    release_gate: (() => {
      const passesPerDay = (r: Row) => ((r.releases_90d ?? 0) / 90) * 2;
      const first = (r: Row) => (r.requests.docs ?? 0) + (r.requests.github_api ?? 0);
      const second = (r: Row) => r.second?.requests ?? 0;
      return {
        releases_90d: per((r) => r.releases_90d ?? 0),
        passes_per_day_weighted: Math.round(weighted(passesPerDay) * 1000) / 1000,
        second_pass: { requests: per(second), seconds: per((r) => (r.ms.docs2 ?? 0) / 1000), sites_quiet: adm.reduce((n, r) => n + (r.second?.quiet ?? 0), 0), sites: adm.reduce((n, r) => n + (r.second?.sites ?? 0), 0) },
        daily_requests_per_1k: {
          daily_full_pass: Math.round(weighted(first) * 1000),
          gate_if_docs_changed: Math.round(weighted((r) => passesPerDay(r) * first(r)) * 1000),
          gate_if_unchanged: Math.round(weighted((r) => passesPerDay(r) * second(r)) * 1000),
        },
      };
    })(),
    not_admitted: { seconds: per(secs, rows.filter((r) => r.outcome !== "admitted")), github_api_requests: per(gh, rows.filter((r) => r.outcome !== "admitted")) },
    throughput_per_hour: Math.round((rows.length / wall) * 3600),
    github: { limit: githubLimit, remaining_at_end: Number.isFinite(githubRemaining) ? githubRemaining : undefined },
    totals: total,
    store_bytes_total: du(centralDir()),
  };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  console.log(JSON.stringify(summary, null, 1));
  if (modelAttempts) throw new Error(`${modelAttempts} model requests were attempted`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
