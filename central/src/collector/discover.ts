// Find and validate the Markdown copy of a docs page, per Source Registry#Agent-facing docs surfaces:
// <link rel=alternate type=text/markdown> or a Link header, then URL conventions, then
// Accept: text/markdown. A candidate is accepted only if it is Markdown (not an HTML soft 404)
// and covers enough of the rendered page's content words.
import { decode } from "./decode.ts";
import { detectFormat, htmlToMarkdown } from "./extract.ts";
import { DEFAULT_HEADERS, FetchFailure, type HttpClient } from "./http.ts";
import { FORMAT_ACCEPT } from "./collector.ts";
import type { WatchSpecInput } from "./schema.ts";

export type DiscoveryMethod = "link" | "header" | "suffix" | "accept" | "source";

export interface Candidate {
  method: DiscoveryMethod;
  url: string;
  accepted: boolean;
  coverage?: number; // share of the page's content words found in the copy
  reason?: string;
}

export interface Discovery {
  page: string;
  copy?: { method: DiscoveryMethod; url: string; coverage: number; negotiated: boolean };
  candidates: Candidate[];
}

export const MIN_COVERAGE = 0.9;

export function suffixCandidates(pageUrl: string): string[] {
  const u = new URL(pageUrl);
  u.hash = "";
  u.search = "";
  const p = u.pathname;
  const at = (path: string) => new URL(path, u).toString();
  if (p.endsWith("/")) return [at(`${p.replace(/\/+$/, "")}.md`), at(`${p}index.md`), at(`${p}index.html.md`)];
  if (p.endsWith(".html")) return [at(`${p.slice(0, -5)}.md`), at(`${p}.md`)];
  if (p.endsWith(".md")) return [];
  return [at(`${p}.md`), at(`${p}/index.md`)];
}

const WORD = /[a-z][a-z0-9_]{2,}/g;
export function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(WORD) ?? []);
}

function markdownWords(md: string): Set<string> {
  return contentWords(
    md
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      .replace(/\]\([^)]*\)/g, "]")
      .replace(/<[^>]+>/g, " "),
  );
}

/** Share of the page's content words found in the copy. Words in `ignore` (host chrome) are left out. */
export function coverage(pageText: string, md: string, ignore: ReadonlySet<string> = new Set()): number {
  const page = [...contentWords(pageText)].filter((w) => !ignore.has(w));
  if (page.length === 0) return 0;
  const copy = markdownWords(md);
  let hit = 0;
  for (const w of page) if (copy.has(w)) hit++;
  return hit / page.length;
}

/**
 * Words on most of a host's pages: unmarked navigation and other chrome that a copy rightly omits.
 * Needs at least three pages; returns an empty set otherwise.
 */
export function hostChromeWords(pageTexts: readonly string[], share = 0.8): Set<string> {
  if (pageTexts.length < 3) return new Set();
  const counts = new Map<string, number>();
  for (const t of pageTexts) for (const w of contentWords(t)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const min = Math.max(3, Math.ceil(share * pageTexts.length));
  return new Set([...counts].filter(([, n]) => n >= min).map(([w]) => w));
}

function linkHeaderMarkdown(link: string | null, base: string): string | undefined {
  for (const part of (link ?? "").split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>(.*)/.exec(part.trim());
    if (m?.[1] && /type\s*=\s*"?text\/markdown/i.test(m[2] ?? "") && /rel\s*=\s*"?[^";]*alternate/i.test(m[2] ?? "")) {
      return new URL(m[1], base).toString();
    }
  }
  return undefined;
}

function linkTagMarkdown(html: string, base: string): string | undefined {
  const head = html.slice(0, 500_000);
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    if (/type\s*=\s*["']text\/markdown["']/i.test(tag) && /rel\s*=\s*["'][^"']*alternate/i.test(tag)) {
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (href) return new URL(href.replace(/&amp;/g, "&"), base).toString();
    }
  }
  return undefined;
}

/** Sphinx "view source" links: `_sources/<page>.rst.txt` (or `.md.txt`). */
function sphinxSource(html: string, base: string): string | undefined {
  const href = /href\s*=\s*["']([^"']*_sources\/[^"']+\.txt)["']/i.exec(html)?.[1];
  return href ? new URL(href.replace(/&amp;/g, "&"), base).toString() : undefined;
}

export interface LoadedPage {
  url: string;
  finalUrl: string;
  headers: Headers;
  html: string;
  text: string; // the page as the HTML watch would see it (no selector)
}

export async function loadPage(http: HttpClient, pageUrl: string): Promise<LoadedPage> {
  const page = await http.get(pageUrl, { ...DEFAULT_HEADERS, accept: FORMAT_ACCEPT.html });
  const ct = page.headers.get("content-type");
  const html = decode(page.body, ct);
  if (detectFormat(ct, html) !== "html") throw new FetchFailure("format_mismatch", `page is not HTML (${ct})`);
  return { url: pageUrl, finalUrl: page.finalUrl, headers: page.headers, html, text: htmlToMarkdown(html, undefined, []) };
}

export interface DiscoverOptions {
  minCoverage: number;
  /** Host chrome words to leave out of coverage (see hostChromeWords). */
  ignoreWords: ReadonlySet<string>;
}

export async function discoverMarkdownCopy(http: HttpClient, pageUrl: string, opts: Partial<DiscoverOptions> = {}): Promise<Discovery> {
  return discoverFromPage(http, await loadPage(http, pageUrl), opts);
}

/** Discover for many pages; pages of the same host share a chrome-word list. */
export async function discoverMany(http: HttpClient, pageUrls: readonly string[], opts: Partial<DiscoverOptions> = {}): Promise<Array<Discovery | { page: string; error: string }>> {
  const loaded = await Promise.all(
    pageUrls.map(async (u) => {
      try {
        return await loadPage(http, u);
      } catch (e) {
        if (e instanceof FetchFailure) return { page: u, error: `${e.kind}: ${e.message}` };
        throw e;
      }
    }),
  );
  const byHost = new Map<string, string[]>();
  for (const p of loaded) {
    if ("error" in p) continue;
    const host = new URL(p.finalUrl).host;
    byHost.set(host, [...(byHost.get(host) ?? []), p.text]);
  }
  const chrome = new Map([...byHost].map(([h, texts]) => [h, hostChromeWords(texts)]));
  return Promise.all(
    loaded.map((p) => ("error" in p ? p : discoverFromPage(http, p, { ...opts, ignoreWords: chrome.get(new URL(p.finalUrl).host) ?? new Set() }))),
  );
}

export async function discoverFromPage(http: HttpClient, page: LoadedPage, opts: Partial<DiscoverOptions> = {}): Promise<Discovery> {
  const minCoverage = opts.minCoverage ?? MIN_COVERAGE;
  const ignore = opts.ignoreWords ?? new Set<string>();
  const out: Discovery = { page: page.url, candidates: [] };
  const { html, text: pageText } = page;

  const ordered: Array<{ method: DiscoveryMethod; url: string; negotiated?: boolean }> = [];
  const fromHeader = linkHeaderMarkdown(page.headers.get("link"), page.finalUrl);
  if (fromHeader) ordered.push({ method: "header", url: fromHeader });
  const fromTag = linkTagMarkdown(html, page.finalUrl);
  if (fromTag && fromTag !== fromHeader) ordered.push({ method: "link", url: fromTag });
  for (const u of suffixCandidates(page.finalUrl)) ordered.push({ method: "suffix", url: u });
  ordered.push({ method: "accept", url: page.finalUrl, negotiated: true });
  const source = sphinxSource(html, page.finalUrl);
  if (source) ordered.push({ method: "source", url: source });

  for (const cand of ordered) {
    const c: Candidate = { method: cand.method, url: cand.url, accepted: false };
    out.candidates.push(c);
    try {
      const res = await http.get(cand.url, { ...DEFAULT_HEADERS, accept: FORMAT_ACCEPT.markdown });
      const rct = res.headers.get("content-type");
      const text = decode(res.body, rct);
      const fmt = detectFormat(rct, text);
      if (fmt !== "markdown" && fmt !== "text") {
        c.reason = `not Markdown (${rct ?? "no content-type"})`;
        continue;
      }
      if (!text.trim()) {
        c.reason = "empty";
        continue;
      }
      c.coverage = +coverage(pageText, text, ignore).toFixed(3);
      if (c.coverage < minCoverage) {
        c.reason = `coverage ${c.coverage} < ${minCoverage}`;
        continue;
      }
      c.accepted = true;
      out.copy = { method: cand.method, url: res.finalUrl, coverage: c.coverage, negotiated: cand.negotiated ?? false };
      return out;
    } catch (e) {
      if (!(e instanceof FetchFailure)) throw e;
      c.reason = `${e.kind}${e.httpStatus ? ` ${e.httpStatus}` : ""}`;
    }
  }
  return out;
}

/** A watch for the discovered copy; falls back to the HTML page when none was accepted. */
export function watchFor(d: Discovery, id: string, fallback: Partial<WatchSpecInput> = {}): WatchSpecInput {
  if (d.copy) {
    return {
      id,
      url: d.copy.url,
      format: "markdown",
      // Generated copies can change formatting site-wide on a renderer change; compare canonical form.
      normalize: { canonicalMarkdown: true },
      // A negotiated copy shares its URL with the HTML page, so the pinned Accept is what selects it.
      ...(d.copy.negotiated ? { headers: { accept: "text/markdown" } } : {}),
    };
  }
  return { id, url: d.page, format: "html", ...fallback };
}
