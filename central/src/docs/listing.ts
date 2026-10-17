// Page listing for one docs site (vault: Docs Monitoring - Handoff, gap 6). Sources, in order: robots.txt `Sitemap:`
// lines, sitemap.xml at the docs path and the origin (indexes followed), then llms.txt. A Markdown URL that llms.txt
// names is kept as the page's copy: the site itself publishes it for agents, and on a JavaScript-only site it is the
// only readable form. The listing is cut to the resolver's scope prefix, robots.txt, and one version and locale:
// version and locale namespaces are found from the listing itself (a path segment whose pages mirror unprefixed pages,
// or that has sibling namespaces), not from a hand-kept list.
import { decode } from "../collector/decode.ts";
import { DEFAULT_HEADERS, FetchFailure, type HttpClient } from "../collector/http.ts";
import type { RobotsCache } from "./robots.ts";

export interface ListedPage {
  /** The published URL: the document's identity. */
  url: string;
  /** A Markdown copy named by the site's llms.txt. */
  copy?: string;
}

export interface Namespace {
  segment: string;
  position: number;
  kind: "version" | "locale";
  pages: number;
  /** Share of its pages whose path minus the segment is also listed. */
  mirror: number;
  kept: boolean;
}

export interface Listing {
  site: string;
  prefix: string;
  method: "sitemap" | "llms.txt" | "sitemap+llms.txt" | "none";
  pages: ListedPage[];
  namespaces: Namespace[];
  /** Pages dropped: outside the prefix or host, disallowed by robots.txt, or in an excluded namespace. */
  dropped: { scope: number; robots: number; namespace: number };
  sitemaps: number;
  truncated: boolean;
}

export interface ListOptions {
  /** The technology's current major, to choose among sibling version namespaces. */
  latestMajor?: string | undefined;
  maxSitemaps: number;
  maxPages: number;
}

const DEFAULTS: ListOptions = { maxSitemaps: 50, maxPages: 5000 };
const NOT_A_PAGE = /\.(css|js|mjs|png|jpe?g|gif|svg|ico|webp|avif|xml|json|txt|pdf|zip|gz|woff2?|ttf|mp4|webm)$/i;
/** Release notes are the release pipeline's source; as docs pages their "markers" name past fixes (SQLAlchemy). */
export const RELEASE_NOTES = /\/(changelogs?|changes|release-notes|releases)(\/|$)/i;
const VERSION = /^(v?\d+(\.(\d+|x))*|latest|stable|next|canary|dev|main|master)$/i;
// Languages docs sites are commonly translated into; a bare two-letter test would take `ai`, `db` or `js` for locales.
const LOCALE = /^(ar|bg|bn|ca|cs|da|de|el|en|es|fa|fi|fr|he|hi|hu|id|it|ja|ko|ms|nl|no|pl|pt|ro|ru|sk|sv|th|tr|uk|ur|vi|zh)([-_][a-z]{2,4})?$/i;
const ENGLISH = /^en([-_](us|gb))?$/i;

/** Published URL identity: no fragment or query, lower-case host, no trailing slash except at the root. */
export function normalizeUrl(u: string): string {
  const x = new URL(u);
  x.hash = "";
  x.search = "";
  x.hostname = x.hostname.toLowerCase();
  if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
  return x.toString();
}

async function text(http: HttpClient, url: string, accept: string): Promise<string | undefined> {
  try {
    const res = await http.get(url, { ...DEFAULT_HEADERS, accept });
    return decode(res.body, res.headers.get("content-type"));
  } catch (e) {
    if (e instanceof FetchFailure) return undefined;
    throw e;
  }
}

/** Pages named by llms.txt; a `.md` link is a copy of the page at the URL without it. */
export function llmsPages(body: string, host: string): ListedPage[] {
  const out: ListedPage[] = [];
  for (const m of body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
    let u: URL;
    try {
      u = new URL(m[1]!);
    } catch {
      continue;
    }
    if (u.hostname.toLowerCase() !== host) continue;
    if (/\.md$/.test(u.pathname)) {
      const page = new URL(u);
      page.pathname = u.pathname.replace(/\/index\.md$/, "/").replace(/\.md$/, "");
      out.push({ url: normalizeUrl(page.toString()), copy: u.toString() });
    } else out.push({ url: normalizeUrl(u.toString()) });
  }
  return out;
}

export async function listSite(http: HttpClient, robots: RobotsCache, site: string, prefix: string, options: Partial<ListOptions> = {}): Promise<Listing> {
  const opts = { ...DEFAULTS, ...options };
  const root = new URL(site);
  const host = root.hostname.toLowerCase();
  const r = await robots.for(site);
  const base = (prefix || "") + "/";
  const todo = [...new Set([...r.sitemaps, new URL(base + "sitemap.xml", root).href, new URL("/sitemap.xml", root).href, new URL("/sitemap-index.xml", root).href])];
  const seen = new Set<string>();
  const found = new Map<string, ListedPage>();
  let truncated = false;
  let sitemaps = 0;
  while (todo.length) {
    const s = todo.shift()!;
    if (seen.has(s)) continue;
    if (seen.size >= opts.maxSitemaps) {
      truncated = true;
      break;
    }
    seen.add(s);
    if (new URL(s).hostname.toLowerCase() !== host) continue;
    const body = await text(http, s, "application/xml, text/xml;q=0.9");
    if (!body || !/<(urlset|sitemapindex)[\s>]/.test(body)) continue;
    sitemaps++;
    const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
    if (/<sitemapindex[\s>]/.test(body)) todo.push(...locs);
    else for (const l of locs) {
      try {
        const u = normalizeUrl(l);
        if (!found.has(u)) found.set(u, { url: u });
      } catch {
        /* not a URL */
      }
    }
  }
  const fromSitemap = found.size > 0;
  let fromLlms = false;
  for (const at of [...new Set([new URL(base + "llms.txt", root).href, new URL("/llms.txt", root).href])]) {
    const body = await text(http, at, "text/plain, text/markdown;q=0.9");
    if (!body || /^\s*</.test(body)) continue; // an HTML fallback page, not llms.txt
    for (const p of llmsPages(body, host)) {
      const had = found.get(p.url);
      if (had) {
        if (p.copy && !had.copy) had.copy = p.copy;
      } else if (!fromSitemap) {
        found.set(p.url, p);
        fromLlms = true;
      } else if (p.copy) fromLlms = true;
    }
  }

  const dropped = { scope: 0, robots: 0, namespace: 0 };
  let pages: ListedPage[] = [];
  for (const p of found.values()) {
    const u = new URL(p.url);
    const inScope = u.hostname === host && (!prefix || u.pathname === prefix || u.pathname.startsWith(prefix + "/")) && !NOT_A_PAGE.test(u.pathname) && !RELEASE_NOTES.test(u.pathname);
    if (!inScope) dropped.scope++;
    else if (!r.allowed(p.url)) dropped.robots++;
    else pages.push(p);
  }
  const namespaces = findNamespaces(pages.map((p) => new URL(p.url).pathname), opts.latestMajor);
  const excluded = namespaces.filter((n) => !n.kept);
  const before = pages.length;
  pages = pages.filter((p) => {
    const segs = new URL(p.url).pathname.split("/");
    return !excluded.some((n) => segs[n.position] === n.segment);
  });
  dropped.namespace = before - pages.length;
  pages.sort((a, b) => a.url.localeCompare(b.url));
  if (pages.length > opts.maxPages) {
    pages = pages.slice(0, opts.maxPages);
    truncated = true;
  }
  const method = fromSitemap && fromLlms ? "sitemap+llms.txt" : fromSitemap ? "sitemap" : fromLlms ? "llms.txt" : "none";
  return { site, prefix, method, pages, namespaces, dropped, sitemaps, truncated };
}

const major = (s: string) => /^v?(\d+)/i.exec(s)?.[1];
const numeric = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
function newer(a: string, b: string): number {
  const x = numeric(a);
  const y = numeric(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * Version and locale namespaces in a set of paths, and which to keep:
 * - a namespace whose pages mirror unprefixed pages is an alternate copy (older versions, translations): excluded;
 * - among sibling version namespaces at one position, the one for the current major is kept (else the newest);
 * - among sibling locales, English is kept.
 * A lone namespace with no mirror and no siblings is ordinary site structure and kept.
 */
export function findNamespaces(paths: readonly string[], latestMajor?: string): Namespace[] {
  const set = new Set(paths);
  const cands = new Map<string, Namespace & { paths: string[] }>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i]!;
      const kind = VERSION.test(seg) ? "version" : LOCALE.test(seg) ? "locale" : undefined;
      if (!kind) continue;
      const key = `${i} ${seg}`;
      const c = cands.get(key) ?? { segment: seg, position: i, kind, pages: 0, mirror: 0, kept: true, paths: [] };
      c.paths.push(p);
      c.pages++;
      cands.set(key, c);
    }
  }
  const list = [...cands.values()].filter((c) => c.pages >= 3);
  for (const c of list) {
    const hits = c.paths.filter((p) => {
      const segs = p.split("/");
      segs.splice(c.position, 1);
      return set.has(segs.join("/") || "/");
    }).length;
    c.mirror = Math.round((hits / c.pages) * 100) / 100;
  }
  for (const c of list) {
    const siblings = list.filter((x) => x !== c && x.position === c.position && x.kind === c.kind && x.mirror < 0.3);
    if (c.kind === "locale") {
      c.kept = ENGLISH.test(c.segment) || (c.mirror < 0.3 && siblings.length === 0);
      continue;
    }
    if (c.mirror >= 0.3) {
      c.kept = false;
      continue;
    }
    if (!siblings.length) continue;
    const group = [c, ...siblings];
    const current = latestMajor ? group.filter((x) => major(x.segment) === latestMajor) : [];
    const pool = current.length ? current : group.filter((x) => /\d/.test(x.segment));
    const alias = group.find((x) => /^(stable|latest)$/i.test(x.segment));
    const keep = current.length ? pool.sort((a, b) => newer(b.segment, a.segment))[0] : alias ?? pool.sort((a, b) => newer(b.segment, a.segment))[0];
    c.kept = c === keep;
  }
  return list.map(({ paths: _p, ...n }) => n).sort((a, b) => a.position - b.position || a.segment.localeCompare(b.segment));
}
