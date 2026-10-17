// Polite HTTP: global and per-host concurrency, pinned headers, conditional requests,
// manual redirects re-validated at every hop, timeouts, size cap, and retries on
// network errors and timeouts only (never on HTTP statuses).
import { setTimeout as sleep } from "node:timers/promises";
import { assertFetchable, BlockedUrlError } from "./url-safety.ts";
import type { FailureKind } from "./schema.ts";

export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": "unstale-collector/0.0 (+https://github.com/jasontd92/unstale)",
  accept: "*/*",
};

export class FetchFailure extends Error {
  readonly kind: FailureKind;
  readonly httpStatus: number | undefined;
  constructor(kind: FailureKind, message: string, httpStatus?: number) {
    super(message);
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

export class Semaphore {
  #active = 0;
  readonly #waiting: Array<() => void> = [];
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async acquire(): Promise<() => void> {
    if (this.#active >= this.limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      this.#waiting.shift()?.();
    };
  }
}

export interface HttpOptions {
  concurrency: number;
  perHost: number;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  retries: number;
  retryBaseMs: number;
  allowPrivate: boolean;
  /** Hostnames exempt from the private-address check (exact match). */
  allowHosts: readonly string[];
  /** Longest Retry-After honoured on 429/503, once per request; longer waits fail. */
  maxRetryAfterMs: number;
}

export const DEFAULT_HTTP: HttpOptions = {
  concurrency: 20,
  perHost: 2,
  timeoutMs: 30_000,
  maxBytes: 20 * 1024 * 1024,
  maxRedirects: 5,
  retries: 2,
  retryBaseMs: 1_000,
  allowPrivate: false,
  allowHosts: [],
  maxRetryAfterMs: 30_000,
};

export interface FetchResult {
  status: number; // 200..299 or 304
  finalUrl: string;
  headers: Headers;
  body: Uint8Array;
}

export class HttpClient {
  readonly #global: Semaphore;
  readonly #hosts = new Map<string, Semaphore>();
  readonly opts: HttpOptions;
  constructor(opts: HttpOptions = DEFAULT_HTTP) {
    this.opts = opts;
    this.#global = new Semaphore(opts.concurrency);
  }

  #host(host: string): Semaphore {
    let s = this.#hosts.get(host);
    if (!s) this.#hosts.set(host, (s = new Semaphore(this.opts.perHost)));
    return s;
  }

  /** GET with redirects followed manually. Conditional headers are dropped on cross-origin redirects. */
  async get(url: string, headers: Record<string, string>): Promise<FetchResult> {
    let current = new URL(url);
    const origin = current.origin;
    for (let hop = 0; hop <= this.opts.maxRedirects; hop++) {
      const sent = current.origin === origin ? headers : withoutConditional(headers);
      const res = await this.#once(current, sent);
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get("location");
        if (!location) throw new FetchFailure("http_status", `redirect ${res.status} without Location`, res.status);
        current = new URL(location, current);
        continue;
      }
      if (res.status === 304 || (res.status >= 200 && res.status < 300)) {
        return { status: res.status, finalUrl: current.toString(), headers: res.headers, body: res.body };
      }
      throw new FetchFailure("http_status", `HTTP ${res.status}`, res.status);
    }
    throw new FetchFailure("too_many_redirects", `more than ${this.opts.maxRedirects} redirects`);
  }

  /**
   * One request without following redirects: what a URL answers now. Used to classify a page that dropped out of its
   * source's listing (a permanent redirect is a move, 404 or 410 a deletion). Network failures still throw.
   */
  async probe(url: string, headers: Record<string, string>): Promise<{ status: number; location?: string }> {
    const res = await this.#once(new URL(url), headers);
    const location = res.headers.get("location");
    return { status: res.status, ...(location ? { location: new URL(location, url).toString() } : {}) };
  }

  async #once(url: URL, headers: Record<string, string>) {
    try {
      await assertFetchable(url, this.opts.allowPrivate, this.opts.allowHosts);
    } catch (e) {
      if (e instanceof BlockedUrlError) throw new FetchFailure("blocked_url", e.message);
      throw new FetchFailure("network", `DNS: ${(e as Error).message}`);
    }
    let honouredRetryAfter = false;
    for (let attempt = 0; ; attempt++) {
      const releaseHost = await this.#host(url.host).acquire();
      const releaseGlobal = await this.#global.acquire();
      let waitMs = this.opts.retryBaseMs * 3 ** attempt;
      try {
        const res = await fetch(url, {
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        const retryAfter = res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
        if (retryAfter !== undefined && !honouredRetryAfter && retryAfter <= this.opts.maxRetryAfterMs) {
          await res.body?.cancel();
          honouredRetryAfter = true;
          waitMs = retryAfter;
          attempt--; // a server-requested wait is not a failed attempt
        } else {
          const body = res.status >= 300 && res.status < 400 ? new Uint8Array() : await readCapped(res, this.opts.maxBytes);
          return { status: res.status, headers: res.headers, body };
        }
      } catch (e) {
        if (e instanceof FetchFailure) throw e;
        const kind: FailureKind = isTimeout(e) ? "timeout" : "network";
        if (attempt >= this.opts.retries) throw new FetchFailure(kind, describe(e));
      } finally {
        releaseGlobal();
        releaseHost();
      }
      await sleep(waitMs);
    }
  }
}

/** Retry-After as delay-seconds or an HTTP date, in milliseconds. */
export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function withoutConditional(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!/^if-(none-match|modified-since)$/i.test(k)) out[k] = v;
  }
  return out;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (declared > max) {
    await res.body?.cancel();
    throw new FetchFailure("too_large", `content-length ${declared} > ${max}`);
  }
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > max) throw new FetchFailure("too_large", `body exceeds ${max} bytes`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function isTimeout(e: unknown): boolean {
  const err = e as { name?: string; cause?: { name?: string; code?: string } };
  return err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError" || err?.cause?.code === "UND_ERR_HEADERS_TIMEOUT" || err?.cause?.code === "UND_ERR_BODY_TIMEOUT";
}

function describe(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  return [err?.message, err?.cause?.code ?? err?.cause?.message].filter(Boolean).join(": ").slice(0, 300);
}
