// One check per watch: conditional fetch, skip on unchanged bytes, extract, normalize,
// compare with the stored snapshot, and record the outcome as state.
import { decode } from "./decode.ts";
import { lineDiff } from "./diff.ts";
import { sectionDiff } from "./sections.ts";
import { extract, ExtractFailure } from "./extract.ts";
import { DEFAULT_HEADERS, FetchFailure, HttpClient } from "./http.ts";
import { canonicalJson, normalize, sha256 } from "./normalize.ts";
import type { CheckResult, Outcome, WatchSpec, WatchState } from "./schema.ts";
import type { Store } from "./store.ts";

/** Pinned Accept per expected format; a watch's own headers override it. */
export const FORMAT_ACCEPT: Readonly<Record<WatchSpec["format"], string>> = {
  markdown: "text/markdown, text/plain;q=0.9, */*;q=0.1",
  text: "text/plain, text/markdown;q=0.9, */*;q=0.1",
  html: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  json: "application/json, */*;q=0.1",
  feed: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1",
};

export interface CollectorOptions {
  /** Snapshots kept per watch (older history entries are dropped; blobs are shared). */
  maxHistory: number;
  now: () => Date;
}

export const DEFAULT_COLLECTOR: CollectorOptions = { maxHistory: 20, now: () => new Date() };

/** Everything that changes how a response becomes text. A change forces a rebaseline. */
export function configHash(spec: WatchSpec): string {
  const { id: _id, ...rest } = spec;
  return sha256(canonicalJson({ ...rest, headers: lower(rest.headers) }));
}

export class Collector {
  readonly http: HttpClient;
  readonly store: Store;
  readonly opts: CollectorOptions;
  constructor(http: HttpClient, store: Store, opts: CollectorOptions = DEFAULT_COLLECTOR) {
    this.http = http;
    this.store = store;
    this.opts = opts;
  }

  /**
   * Check every watch with a bounded worker pool. Each worker takes the next watch whose host has
   * spare capacity, so a slow or rate-limited host cannot hold every worker (head-of-line blocking),
   * and only `concurrency` checks hold bodies in memory at once. Results are in input order;
   * `onResult` lets a caller stream them instead of keeping diffs until the end.
   */
  async checkAll(specs: readonly WatchSpec[], onResult?: (r: CheckResult) => void): Promise<CheckResult[]> {
    const ids = new Set<string>();
    for (const s of specs) {
      if (ids.has(s.id)) throw new Error(`duplicate watch id ${s.id}`);
      ids.add(s.id);
    }
    const results: CheckResult[] = new Array(specs.length);
    const pending = specs.map((spec, index) => ({ spec, index, host: new URL(spec.url).host }));
    const busy = new Map<string, number>();
    const { concurrency, perHost } = this.http.opts;
    const waiting: Array<() => void> = [];
    const worker = async () => {
      while (pending.length) {
        const i = pending.findIndex((p) => (busy.get(p.host) ?? 0) < perHost);
        if (i < 0) {
          await new Promise<void>((r) => waiting.push(r)); // every pending host is at capacity
          continue;
        }
        const [{ spec, index, host }] = pending.splice(i, 1) as [(typeof pending)[number]];
        busy.set(host, (busy.get(host) ?? 0) + 1);
        try {
          const r = await this.check(spec);
          results[index] = r;
          onResult?.(r);
        } finally {
          busy.set(host, (busy.get(host) ?? 1) - 1);
          for (const w of waiting.splice(0)) w(); // waiters re-check; they exit once nothing is pending
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, worker));
    return results;
  }

  async check(spec: WatchSpec): Promise<CheckResult> {
    const started = performance.now();
    const at = this.opts.now().toISOString();
    const cfg = configHash(spec);
    const prev = await this.store.getState(spec.id);
    const sameConfig = prev?.configHash === cfg && prev.snapshot !== undefined;

    const headers: Record<string, string> = { ...DEFAULT_HEADERS, accept: FORMAT_ACCEPT[spec.format], ...lower(spec.headers) };
    if (sameConfig && prev?.etag) headers["if-none-match"] = prev.etag;
    if (sameConfig && prev?.lastModified) headers["if-modified-since"] = prev.lastModified;

    const base: WatchState = prev ?? { configHash: cfg, consecutiveFailures: 0, history: [] };
    let outcome: Outcome;
    let next: WatchState;
    let bytes = 0;
    let finalUrl: string | undefined;
    try {
      const res = await this.http.get(spec.url, headers);
      bytes = res.body.byteLength;
      finalUrl = res.finalUrl;
      const validators = {
        ...(res.headers.get("etag") ? { etag: res.headers.get("etag") as string } : {}),
        ...(res.headers.get("last-modified") ? { lastModified: res.headers.get("last-modified") as string } : {}),
      };
      if (res.status === 304) {
        if (!sameConfig) throw new FetchFailure("http_status", "304 without a stored snapshot", 304);
        outcome = { status: "not_modified" };
        next = { ...base, lastCheckedAt: at, consecutiveFailures: 0 };
      } else {
        const rawHash = sha256(res.body);
        const { lastFailure: _lf, etag: _e, lastModified: _lm, ...kept } = base;
        if (sameConfig && prev?.rawHash === rawHash) {
          outcome = { status: "unchanged" };
          next = { ...kept, ...validators, rawHash, lastCheckedAt: at, consecutiveFailures: 0 };
        } else {
          const text = normalize(
            extract(spec, res.headers.get("content-type"), decode(res.body, res.headers.get("content-type"))),
            spec.normalize,
          );
          const snapshot = await this.store.putBlob(text);
          const common = { ...kept, ...validators, configHash: cfg, rawHash, snapshot, lastCheckedAt: at, consecutiveFailures: 0 };
          if (!prev?.snapshot) {
            outcome = { status: "first_seen", snapshot };
            next = { ...common, history: [{ at, snapshot }] };
          } else if (!sameConfig) {
            outcome = { status: "rebaseline", snapshot };
            next = { ...common, history: cap([...prev.history, { at, snapshot }], this.opts.maxHistory) };
          } else if (snapshot === prev.snapshot) {
            outcome = { status: "unchanged" };
            next = common;
          } else {
            const before = await this.store.getBlob(prev.snapshot);
            const diff = lineDiff(before, text);
            const sections = spec.format === "markdown" || spec.format === "html" ? { sections: sectionDiff(before, text) } : {};
            const earlier = prev.history.findLast((h) => h.snapshot === snapshot);
            outcome = { status: "changed", snapshot, previous: prev.snapshot, diff, ...sections, ...(earlier ? { revertsTo: earlier.at } : {}) };
            next = { ...common, lastChangedAt: at, history: cap([...prev.history, { at, snapshot }], this.opts.maxHistory) };
          }
        }
      }
    } catch (e) {
      if (!(e instanceof FetchFailure || e instanceof ExtractFailure)) throw e;
      const httpStatus = e instanceof FetchFailure ? e.httpStatus : undefined;
      outcome = { status: "failed", failure: e.kind, detail: e.message, ...(httpStatus ? { httpStatus } : {}) };
      // Keep the last good snapshot and validators; a failure is coverage state, never "the page became empty".
      next = {
        ...base,
        lastCheckedAt: at,
        consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        lastFailure: { kind: e.kind, detail: e.message, at },
      };
    }
    await this.store.putState(spec.id, next);
    return {
      id: spec.id,
      url: spec.url,
      ...(finalUrl && finalUrl !== spec.url ? { finalUrl } : {}),
      outcome,
      ms: Math.round(performance.now() - started),
      bytes,
    };
  }
}

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

function cap<T>(xs: T[], n: number): T[] {
  return xs.length > n ? xs.slice(xs.length - n) : xs;
}
