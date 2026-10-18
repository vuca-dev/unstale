// One fetch per docs page per day, however many technologies watch it (in the scale probe, 29 % of technology-page
// pairs were the same page, and one site was watched by 21 technologies). A docs page fetched for one technology is
// kept for `ttlMs` and served to the next technology that checks it, with the same request headers; each technology
// still keeps its own snapshots and events. A technology's own re-check always fetches (a second release the same day
// must see the page as it is now). Conditional requests are answered from the kept validators. Kept under the central
// cache, outside the saved state (it only matters within a day, and a run's packages that release together share most
// of it). A page is one pack record (pipeline/packs.ts): its metadata line, then its Brotli body.
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HttpClient, type FetchResult } from "../collector/http.ts";
import { centralDir } from "../pipeline/paths.ts";
import { Packs } from "../pipeline/packs.ts";
import { canonical, sha256 } from "../pipeline/util.ts";

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
  private readonly packs: Packs;
  hits = 0;
  constructor(inner: HttpClient, technology: string, ttlMs = 20 * 3600 * 1000, dir = join(centralDir(), "cache", "pages")) {
    super(inner.opts);
    this.inner = inner;
    this.technology = technology;
    this.ttlMs = ttlMs;
    this.dir = dir;
    this.packs = new Packs(dir, { width: 2 });
  }

  /** The request as far as the response depends on it: URL and headers, without the caller's validators. */
  private key(url: string, headers: Record<string, string>): string {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => !CONDITIONAL.has(k!)));
    return sha256(canonical({ url, headers: h }));
  }
  private read(key: string): { kept: Kept; body: Buffer } | undefined {
    const v = this.packs.get(key);
    const nl = v?.indexOf(0x0a) ?? -1;
    if (!v || nl < 0) return undefined;
    return { kept: JSON.parse(v.subarray(0, nl).toString("utf8")) as Kept, body: v.subarray(nl + 1) };
  }

  override async get(url: string, headers: Record<string, string>): Promise<FetchResult> {
    const key = this.key(url, headers);
    const page = this.read(key);
    const kept = page?.kept;
    if (page && kept && kept.by !== this.technology && Date.now() - Date.parse(kept.at) < this.ttlMs) {
      this.hits++;
      const h = new Headers(kept.headers);
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const etag = h.get("etag");
      if ((lower["if-none-match"] && etag && lower["if-none-match"] === etag) || (!lower["if-none-match"] && lower["if-modified-since"] && h.get("last-modified") === lower["if-modified-since"]))
        return { status: 304, finalUrl: kept.finalUrl, headers: h, body: new Uint8Array() };
      return { status: 200, finalUrl: kept.finalUrl, headers: h, body: new Uint8Array(brotliDecompressSync(page.body)) };
    }
    const res = await this.inner.get(url, headers);
    if (res.status === 200) {
      const h = Object.fromEntries(KEPT_HEADERS.flatMap((k) => (res.headers.get(k) ? [[k, res.headers.get(k)!]] : [])));
      const meta = JSON.stringify({ at: new Date().toISOString(), by: this.technology, finalUrl: res.finalUrl, headers: h } satisfies Kept);
      this.packs.put(key, Buffer.concat([Buffer.from(`${meta}\n`), brotliCompressSync(res.body)]));
    }
    return res;
  }

  override probe(url: string, headers: Record<string, string>): Promise<{ status: number; location?: string }> {
    return this.inner.probe(url, headers);
  }

  /** Drops pages kept longer than the TTL, and the one-file-per-page layout this cache had before packs. */
  prune(now = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    for (const sub of readdirSync(this.dir)) if (/^[0-9a-f]{2}$/.test(sub)) rmSync(`${this.dir}/${sub}`, { recursive: true, force: true });
    let n = 0;
    for (const f of this.packs.files())
      n += this.packs.compact(f, (_, data) => {
        const nl = data.indexOf(0x0a);
        try {
          return nl > 0 && now - Date.parse((JSON.parse(data.subarray(0, nl).toString("utf8")) as Kept).at) < this.ttlMs;
        } catch {
          return false;
        }
      });
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
