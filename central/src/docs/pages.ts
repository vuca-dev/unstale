// One fetch per docs page per day, however many technologies watch it (vault: Central Scheduling and Infrastructure,
// "Scale probe": 29% of technology-page pairs were the same page, and one site was watched by 21 technologies). A
// docs page fetched for one technology is kept for `ttlMs` and served to the next technology that checks it, with
// the same request headers; each technology still keeps its own snapshots and events. A technology's own re-check
// always fetches (a second release the same day must see the page as it is now). Conditional requests are answered
// from the kept validators. Kept under the central cache, outside the saved state (it only matters within
// a day, and a run's packages that release together share most of it).
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpClient, type FetchResult } from "../collector/http.ts";
import { centralDir } from "../pipeline/paths.ts";
import { canonical, readJson, sha256, writeAtomic } from "../pipeline/util.ts";

interface Kept {
  at: string;
  /** The technology whose check fetched it. */
  by: string;
  finalUrl: string;
  headers: Record<string, string>;
}

const KEPT_HEADERS = ["content-type", "etag", "last-modified"];
const CONDITIONAL = new Set(["if-none-match", "if-modified-since"]);

export class SharedPages extends HttpClient {
  readonly inner: HttpClient;
  readonly technology: string;
  readonly dir: string;
  readonly ttlMs: number;
  hits = 0;
  constructor(inner: HttpClient, technology: string, ttlMs = 20 * 3600 * 1000, dir = join(centralDir(), "cache", "pages")) {
    super(inner.opts);
    this.inner = inner;
    this.technology = technology;
    this.ttlMs = ttlMs;
    this.dir = dir;
  }

  /** The request as far as the response depends on it: URL and headers, without the caller's validators. */
  private key(url: string, headers: Record<string, string>): string {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => !CONDITIONAL.has(k!)));
    return sha256(canonical({ url, headers: h }));
  }
  private paths(key: string) {
    const d = join(this.dir, key.slice(0, 2));
    return { d, meta: join(d, `${key}.json`), body: join(d, `${key}.br`) };
  }

  override async get(url: string, headers: Record<string, string>): Promise<FetchResult> {
    const p = this.paths(this.key(url, headers));
    const kept = readJson<Kept>(p.meta);
    if (kept && kept.by !== this.technology && Date.now() - Date.parse(kept.at) < this.ttlMs && existsSync(p.body)) {
      this.hits++;
      const h = new Headers(kept.headers);
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const etag = h.get("etag");
      if ((lower["if-none-match"] && etag && lower["if-none-match"] === etag) || (!lower["if-none-match"] && lower["if-modified-since"] && h.get("last-modified") === lower["if-modified-since"]))
        return { status: 304, finalUrl: kept.finalUrl, headers: h, body: new Uint8Array() };
      return { status: 200, finalUrl: kept.finalUrl, headers: h, body: new Uint8Array(brotliDecompressSync(readFileSync(p.body))) };
    }
    const res = await this.inner.get(url, headers);
    if (res.status === 200) {
      mkdirSync(p.d, { recursive: true });
      writeFileSync(p.body, brotliCompressSync(res.body));
      const h = Object.fromEntries(KEPT_HEADERS.flatMap((k) => (res.headers.get(k) ? [[k, res.headers.get(k)!]] : [])));
      writeAtomic(p.meta, JSON.stringify({ at: new Date().toISOString(), by: this.technology, finalUrl: res.finalUrl, headers: h } satisfies Kept));
    }
    return res;
  }

  override probe(url: string, headers: Record<string, string>): Promise<{ status: number; location?: string }> {
    return this.inner.probe(url, headers);
  }

  /** Drops pages kept longer than the TTL. */
  prune(now = Date.now()): number {
    let n = 0;
    if (!existsSync(this.dir)) return 0;
    for (const sub of readdirSync(this.dir)) {
      const d = join(this.dir, sub);
      if (!statSync(d).isDirectory()) continue;
      for (const f of readdirSync(d).filter((f) => f.endsWith(".json"))) {
        const kept = readJson<Kept>(join(d, f));
        if (kept && now - Date.parse(kept.at) < this.ttlMs) continue;
        rmSync(join(d, f), { force: true });
        rmSync(join(d, f.replace(/\.json$/, ".br")), { force: true });
        n++;
      }
    }
    return n;
  }
}

let pruned = false;
/** The shared page cache over `inner`; expired pages are dropped once per process. */
export function sharedPages(inner: HttpClient, technology: string): SharedPages {
  const c = new SharedPages(inner, technology);
  if (!pruned) {
    pruned = true;
    c.prune();
  }
  return c;
}
