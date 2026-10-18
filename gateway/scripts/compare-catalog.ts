// Fetches the same catalog and website URLs from two deployments and diffs status, headers and bytes: the check that
// packing (scripts/pack.ts) changes nothing a client sees. The URLs are a sample of an unpacked tree's files, read as
// clients read them: plain, conditional on the ETag the first deployment gave (304), HEAD, pages as a browser and as
// an agent asking for Markdown, the redirects into page directories, coverage statuses through `GET /coverage`, and
// lookups of files that do not exist.
//
//   node gateway/scripts/compare-catalog.ts <before base URL> <after base URL> <unpacked site dir> [--sample 200] [--seed 1]
//       [--etags compare|own]      own: each side's If-None-Match uses its own ETag, values not compared (wrangler dev)
//   node gateway/scripts/compare-catalog.ts --check-etags <base URL> <unpacked site dir>
//       whether a deployment's catalog ETags are Workers' asset hash of the bytes (the hash pack.ts gives packed files)
//
// Prints one line per difference and a JSON summary; exits 1 on any difference. Headers that differ per response
// (Date, CF-Ray, Report-To, NEL and the like) are not compared.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { assetHash } from "./pack.ts";

// Per response, or the edge cache's state (CF-Cache-Status), which depends on what was asked before.
const VOLATILE = new Set(["cf-cache-status", "date", "cf-ray", "report-to", "nel", "server", "alt-svc", "connection", "keep-alive", "transfer-encoding", "server-timing", "age"]);

interface Probe {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  /** Send If-None-Match with the ETag the before deployment gave for this path. */
  conditional?: boolean;
}

function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const path = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, path) : [path];
  });
}

/** A deterministic sample (seeded, so two runs compare the same URLs). */
function sample<T>(items: T[], n: number, seed: number): T[] {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) ^ (s + 0x6d2b79f5)) >>> 0) / 2 ** 32;
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n).sort();
}

/** The URLs to compare, from an unpacked tree. */
export function probes(site: string, n: number, seed: number): Probe[] {
  const files = walk(site).filter((f) => !f.startsWith("_pack/"));
  const current = new Set<string>();
  const indexes = files.filter((f) => /^v1\/tech\/[^/]+\.json$/.test(f));
  for (const f of indexes) for (const s of (JSON.parse(readFileSync(join(site, f), "utf8")) as { shards?: { path: string }[] }).shards ?? []) current.add(s.path.startsWith("v1/") ? s.path : `v1/${s.path}`);
  const shards = files.filter((f) => f.startsWith("v1/shards/"));
  const pages = files.filter((f) => /^(npm|pypi)\/.+\/index\.html$/.test(f)).map((f) => f.slice(0, -"index.html".length));
  const statuses = files.filter((f) => f.startsWith("v1/coverage/"));
  const out: Probe[] = [];
  const file = (path: string) => out.push({ path: `/${path}` }, { path: `/${path}`, conditional: true }, { path: `/${path}`, method: "HEAD" });
  for (const f of files.filter((f) => !f.includes("/") || f.startsWith(".well-known/"))) out.push({ path: `/${f}` });
  out.push({ path: "/v1/root.json", conditional: true });
  for (const f of sample(indexes, n, seed)) file(f), file(`${f}.sig`);
  for (const f of sample(shards.filter((s) => current.has(s)), n, seed)) file(f);
  for (const f of sample(shards.filter((s) => !current.has(s)), n, seed)) file(f);
  for (const f of sample(statuses, n, seed)) file(f);
  for (const p of sample(pages, n, seed)) {
    out.push(
      { path: `/${p}`, headers: { Accept: "text/html,*/*;q=0.8" } },
      { path: `/${p}`, headers: { Accept: "text/markdown" } },
      { path: `/${p}`, conditional: true },
      { path: `/${p}index.md` },
      { path: `/${p}index.md`, conditional: true },
      { path: `/${p}index.html` },
      { path: `/${p.slice(0, -1)}` },
    );
  }
  for (const f of sample(statuses, Math.min(n, 50), seed)) {
    const { purl } = JSON.parse(readFileSync(join(site, f), "utf8")) as { purl: string };
    out.push({ path: `/coverage?purl=${encodeURIComponent(purl)}` });
  }
  out.push(
    { path: "/v1/tech/no-such-technology.json" },
    { path: "/v1/tech/no-such-technology.json.sig" },
    { path: "/v1/shards/no-such-technology/1.0123456789abcdef.jsonl.gz" },
    { path: `/v1/coverage/${"0".repeat(64)}.json` },
    { path: "/npm/no-such-package-xyz/" },
    { path: "/npm/no-such-package-xyz" },
    { path: "/_pack/" },
  );
  return out;
}

interface Seen {
  status: number;
  headers: Record<string, string>;
  sha256: string;
  bytes: number;
}

async function fetchOne(base: string, p: Probe, etag?: string): Promise<Seen> {
  const headers: Record<string, string> = { "Accept-Encoding": "identity", ...p.headers };
  if (p.conditional && etag) headers["If-None-Match"] = etag;
  const res = await fetch(new URL(p.path, base), { method: p.method ?? "GET", headers, redirect: "manual" });
  const body = Buffer.from(await res.arrayBuffer());
  const h: Record<string, string> = {};
  // The deployment's own origin (in a redirect, a canonical link) is compared without it.
  const origin = new URL(base).origin;
  res.headers.forEach((v, k) => {
    if (!VOLATILE.has(k)) h[k] = v.replaceAll(origin, "");
  });
  return { status: res.status, headers: h, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
}

const label = (p: Probe) => `${p.method ?? "GET"} ${p.path}${p.conditional ? " (If-None-Match)" : ""}${p.headers?.Accept ? ` (Accept: ${p.headers.Accept})` : ""}`;

export async function compare(
  before: string,
  after: string,
  list: Probe[],
  opts: { etags?: "compare" | "own" } = {},
): Promise<{ compared: number; differences: string[]; statuses: Record<string, number> }> {
  const differences: string[] = [];
  const statuses: Record<string, number> = {};
  // Each side's own ETag for a conditional request: wrangler dev's ETags are not Cloudflare's, so a local comparison
  // (`etags: "own"`) checks that each side answers its own ETag with 304, not that the values agree.
  const etags = new Map<string, [string | undefined, string | undefined]>();
  for (const p of list) {
    if (p.conditional && !etags.has(p.path)) {
      const [a, b] = await Promise.all([fetchOne(before, { path: p.path }), fetchOne(after, { path: p.path })]);
      etags.set(p.path, [a.headers.etag, opts.etags === "own" ? b.headers.etag : a.headers.etag]);
    }
    const [ea, eb] = etags.get(p.path) ?? [];
    const [a, b] = await Promise.all([fetchOne(before, p, ea), fetchOne(after, p, eb)]);
    statuses[a.status] = (statuses[a.status] ?? 0) + 1;
    if (a.status !== b.status) differences.push(`${label(p)}: status ${a.status} -> ${b.status}`);
    if (a.sha256 !== b.sha256) differences.push(`${label(p)}: body ${a.bytes} bytes ${a.sha256.slice(0, 12)} -> ${b.bytes} bytes ${b.sha256.slice(0, 12)}`);
    for (const k of new Set([...Object.keys(a.headers), ...Object.keys(b.headers)])) {
      if (k === "etag" && opts.etags === "own" && !!a.headers[k] === !!b.headers[k]) continue;
      if (a.headers[k] !== b.headers[k]) differences.push(`${label(p)}: ${k}: ${a.headers[k] ?? "(none)"} -> ${b.headers[k] ?? "(none)"}`);
    }
  }
  return { compared: list.length, differences, statuses };
}

/** Whether a deployment's ETags are Workers' asset hash of the bytes (scripts/pack.ts, assetHash): checked against
 * production, it shows a packed file keeps the ETag clients hold for it. */
export async function checkEtags(base: string, list: Probe[]): Promise<{ checked: number; mismatches: string[] }> {
  const mismatches: string[] = [];
  let checked = 0;
  for (const p of list.filter((p) => !p.method && !p.conditional && !p.headers && p.path.startsWith("/v1/"))) {
    const res = await fetch(new URL(p.path, base), { headers: { "Accept-Encoding": "identity" }, redirect: "manual" });
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200) continue;
    checked++;
    const want = `"${assetHash(p.path, body)}"`;
    if (res.headers.get("etag") !== want) mismatches.push(`${p.path}: ETag ${res.headers.get("etag")}, asset hash ${want}`);
  }
  return { checked, mismatches };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { sample: { type: "string", default: "200" }, seed: { type: "string", default: "1" }, etags: { type: "string", default: "compare" }, "check-etags": { type: "string" } },
  });
  const [before, after, site] = values["check-etags"] ? [undefined, undefined, positionals[0]] : positionals;
  if (!site || (!values["check-etags"] && (!before || !after)))
    throw new Error("usage: compare-catalog.ts <before URL> <after URL> <unpacked site dir> [--sample N] [--seed N] [--etags compare|own]\n       compare-catalog.ts --check-etags <URL> <unpacked site dir> [--sample N]");
  const list = probes(site, Number(values.sample), Number(values.seed));
  if (values["check-etags"]) {
    const r = await checkEtags(values["check-etags"], list);
    for (const m of r.mismatches) console.log(m);
    console.log(JSON.stringify({ checked: r.checked, mismatches: r.mismatches.length }));
    process.exitCode = r.mismatches.length ? 1 : 0;
  } else {
    const r = await compare(before!, after!, list, { etags: values.etags === "own" ? "own" : "compare" });
    for (const d of r.differences) console.log(d);
    console.log(JSON.stringify({ compared: r.compared, differences: r.differences.length, statuses: r.statuses }));
    process.exitCode = r.differences.length ? 1 : 0;
  }
}
