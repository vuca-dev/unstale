// Polite HTTP: global and per-host concurrency, pinned headers, conditional requests,
// manual redirects re-validated at every hop, timeouts, size cap, and retries on
// network errors and timeouts only (never on HTTP statuses).
//
// Requests use node:http(s) rather than fetch so the address checked is the address connected to: the socket's own
// DNS lookup refuses a private, loopback or link-local answer, so a name cannot pass the check and then rebind.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { assertFetchable, BlockedUrlError, isBlockedAddress } from "./url-safety.ts";
import type { FailureKind } from "./schema.ts";

export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": "unstale-collector/0.0 (+https://github.com/vuca-dev/unstale)",
  accept: "*/*",
};

export class FetchFailure extends Error {
  readonly kind: FailureKind;
  readonly httpStatus: number | undefined;
  /** The server's Retry-After on a 429 or 503 it answered (longer than this client waits itself), in milliseconds. */
  readonly retryAfterMs: number | undefined;
  constructor(kind: FailureKind, message: string, httpStatus?: number, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
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

  /**
   * GET with redirects followed manually. Credentials and conditional headers are dropped on cross-origin redirects.
   * `vet`, when given, vets each HTTP(S) redirect target before it is requested (robots.txt for a crawl; other schemes are
   * refused by the fetchability check); refused is
   * `blocked_url`.
   */
  async get(url: string, headers: Record<string, string>, vet?: (next: URL) => Promise<boolean>): Promise<FetchResult> {
    let current = new URL(url);
    const origin = current.origin;
    for (let hop = 0; hop <= this.opts.maxRedirects; hop++) {
      const sent = current.origin === origin ? headers : crossOrigin(headers);
      const res = await this.#once(current, sent);
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get("location");
        if (!location) throw new FetchFailure("http_status", `redirect ${res.status} without Location`, res.status);
        current = new URL(location, current);
        if (vet && /^https?:$/.test(current.protocol) && !(await vet(current))) throw new FetchFailure("blocked_url", `redirect to ${current.href} refused`);
        continue;
      }
      if (res.status === 304 || (res.status >= 200 && res.status < 300)) {
        return { status: res.status, finalUrl: current.toString(), headers: res.headers, body: res.body };
      }
      const retryAfter = res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      throw new FetchFailure("http_status", `HTTP ${res.status}`, res.status, retryAfter);
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
      const lookup = this.opts.allowPrivate || this.opts.allowHosts.includes(url.hostname) ? undefined : guardedLookup;
      try {
        const res = await send(url, headers, this.opts.timeoutMs, lookup);
        const status = res.statusCode ?? 0;
        const responseHeaders = headersOf(res);
        const retryAfter = status === 429 || status === 503 ? parseRetryAfter(responseHeaders.get("retry-after")) : undefined;
        if (retryAfter !== undefined && !honouredRetryAfter && retryAfter <= this.opts.maxRetryAfterMs) {
          res.destroy();
          honouredRetryAfter = true;
          waitMs = retryAfter;
          attempt--; // a server-requested wait is not a failed attempt
        } else {
          const body = status >= 300 && status < 400 ? (res.destroy(), new Uint8Array()) : await readCapped(res, responseHeaders, this.opts.maxBytes);
          return { status, headers: responseHeaders, body };
        }
      } catch (e) {
        if (e instanceof FetchFailure) throw e;
        if (e instanceof BlockedUrlError) throw new FetchFailure("blocked_url", e.message);
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

/** Headers for another origin: a token or cookie meant for the first host is never sent on to where it redirects. */
function crossOrigin(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!/^(if-(none-match|modified-since)|authorization|proxy-authorization|cookie)$/i.test(k)) out[k] = v;
  }
  return out;
}

/** DNS for a socket: every answer must be a public address, checked on the answer the connection then uses. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as unknown as LookupAddress[];
    const blocked = list.find((a) => isBlockedAddress(a.address));
    if (blocked) return callback(new BlockedUrlError(`${hostname} resolves to blocked address ${blocked.address}`), "", 0);
    if (!list[0]) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), "", 0);
    if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

/** One GET; the response's headers are in, its body still to read. Times out as a whole, like AbortSignal.timeout. */
function send(url: URL, headers: Record<string, string>, timeoutMs: number, lookup: LookupFunction | undefined): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, { method: "GET", headers: { "accept-encoding": "gzip, deflate, br", ...headers }, ...(lookup ? { lookup } : {}) }, resolve);
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { name: "TimeoutError" })), timeoutMs);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e) => reject((e as { cause?: unknown }).cause instanceof BlockedUrlError ? (e as { cause: BlockedUrlError }).cause : e));
    req.end();
  });
}

function headersOf(res: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
  }
  return h;
}

/** The body, decoded per Content-Encoding, capped at `max` bytes after decoding (a small gzip cannot fill memory). */
async function readCapped(res: IncomingMessage, headers: Headers, max: number): Promise<Uint8Array> {
  const declared = Number(headers.get("content-length") ?? "NaN");
  const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (declared > max && !encoding) {
    res.destroy();
    throw new FetchFailure("too_large", `content-length ${declared} > ${max}`);
  }
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : undefined;
  const stream = decoder ? res.pipe(decoder) : res;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.byteLength;
      if (total > max) throw new FetchFailure("too_large", `body exceeds ${max} bytes`);
      chunks.push(chunk);
    }
  } finally {
    res.destroy();
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
