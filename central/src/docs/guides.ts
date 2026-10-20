// The upgrade guides of a technology, found by the docs module for any technology: the pages its listing names as
// guides (`upgrading/version-16`, `upgrade-prisma-orm/v7`, or an unnumbered `migration-guide` read from its text), for
// the current and the previous major, as the site's own copy. Replaces the hand-kept per-technology table of guide
// paths. A guide in another variant's section of a shared site (Android's on Sentry's site for the Python SDK, Vue's
// on TanStack's for React Query) or for another named thing's version (`migrate-to-config-v2`) is not the
// technology's (`ownGuide`).
import { join } from "node:path";
import type { HttpClient } from "../collector/http.ts";
import { readJson } from "../pipeline/util.ts";
import { guideCandidate } from "./attribute.ts";
import { docsDir, docsStore, latestVersion, refresh, type Source } from "./monitor.ts";

export interface CurrentGuide {
  url: string;
  major: string;
  text: string;
  /** `sha256:<hex>` of the text as stored. */
  snapshot: string;
}

interface StoredState {
  sites?: Array<{ site: string }>;
  pages: Record<string, { guideMajor?: string; watch: { id: string } }>;
}

/** The languages a package ecosystem's docs name it by: a site's `/python/` section is the PyPI package's. */
const ECOSYSTEM: Record<string, string[]> = { npm: ["javascript", "js", "node", "nodejs", "typescript", "ts"], pypi: ["python", "py"], cargo: ["rust"] };
const JOINERS = new Set(["for", "and", "the", "with", "of", "in", "to", "on"]);

/** The words of a path segment, host or package name; numbers and version labels (`v2`, `v6x`) are not words. */
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !/^\d+$/.test(w) && !/^v\d+x?$/.test(w));
const segments = (u: string): string[] => new URL(u).pathname.toLowerCase().split("/").filter(Boolean);

/**
 * Whether a listed upgrade guide is the technology's own. A shared docs site gives each variant (platform, language,
 * framework, product) a section of its own: `/platforms/<python|android|…>/`, `/framework/<react|vue|…>/`,
 * `/drivers/<node|java|…>/`. When a section beside the guide's is named by the technology (all of its words are the
 * technology's package words, its ecosystem's language or the site's own name, and one is the package's or the
 * language's) and is known to be the technology's (it holds upgrade guides, or the technology's docs entry lies in it),
 * a guide under a sibling section that the technology does not name is that other variant's. The package's own words
 * are tried before its ecosystem's (`/react/` over `/node/` for a React package). A guide whose title names its target
 * as another thing's version (`migrate-to-config-v2`, `upgrade-to-grid-v2`) shares no word with the technology and is
 * not a guide to its major either. Deterministic: the listing, the docs entries and the package URLs only.
 */
export function ownGuide(url: string, ctx: { purls: readonly string[]; pages: readonly string[]; guides: ReadonlySet<string>; entries: readonly string[] }): boolean {
  const host = new URL(url).hostname;
  const site = new Set(words(host));
  const name = new Set<string>();
  const lang = new Set<string>();
  for (const purl of ctx.purls) {
    const [, type, rest] = /^pkg:(\w+)\/(.+)$/.exec(purl) ?? [];
    for (const w of words(decodeURIComponent(rest ?? ""))) name.add(w);
    for (const w of ECOSYSTEM[type ?? ""] ?? []) lang.add(w);
  }
  for (const w of name) lang.delete(w);
  const known = (w: string) => name.has(w) || lang.has(w) || site.has(w) || JOINERS.has(w);
  /** A segment the technology names: every word its own, one of them from `by` and not the site's name. */
  const names = (v: string, by: ReadonlySet<string>) => {
    const ws = words(v);
    return ws.length > 0 && ws.every(known) && ws.some((x) => by.has(x) && !site.has(x));
  };
  const g = segments(url);
  const target = /(?:^|-)to-([a-z][a-z-]*?)-v?\d+(?:[.-]\d+)*(?:\.x)?$/.exec(g.at(-1) ?? "")?.[1];
  if (target && !words(target).some((w) => name.has(w) || lang.has(w) || site.has(w))) return false;
  const sameHost = (u: string) => {
    try {
      return new URL(u).hostname === host;
    } catch {
      return false;
    }
  };
  const listed = ctx.pages.filter(sameHost).map((u) => ({ s: segments(u), guide: ctx.guides.has(u) || guideCandidate(u) }));
  const entries = ctx.entries.filter(sameHost).map(segments);
  const under = (s: string[], i: number) => g.slice(0, i).every((x, k) => s[k] === x);
  for (let i = 0; i < g.length - 1; i++) {
    const w = g[i]!;
    const inside = listed.filter((p) => p.s.length > i + 1 && under(p.s, i));
    const sections = new Set([w, ...inside.map((p) => p.s[i]!), ...entries.filter((e) => e.length > i && under(e, i)).map((e) => e[i]!)]);
    if (sections.size < 2) continue;
    // The package's words first, then its ecosystem's. A docs entry marks a section the package names only when it lies
    // below it (`/sdk-for-javascript/v3/…`, not the single page `/material-icons/`); the language's, at it (`/python/`).
    for (const [by, depth] of [[name, i + 2], [lang, i + 1]] as const) {
      const own = new Set([...sections].filter((v) => names(v, by)));
      if (!own.size) continue;
      if (own.has(w) || names(w, name)) break;
      if (inside.some((p) => own.has(p.s[i]!) && p.guide) || entries.some((e) => e.length >= depth && under(e, i) && own.has(e[i]!))) return false;
      break;
    }
  }
  return true;
}

/** The technology's guide filter over its stored docs state (`ownGuide`); the stored state is read when not given. */
export function guideFilter(src: Source, state: StoredState | undefined = readJson<StoredState>(join(docsDir(src.technology), "state.json"))): (url: string) => boolean {
  const pages = Object.keys(state?.pages ?? {});
  const guides = new Set(Object.entries(state?.pages ?? {}).filter(([, p]) => p.guideMajor).map(([u]) => u));
  const entries = (state?.sites ?? []).map((s) => s.site);
  return (url) => ownGuide(url, { purls: src.purls, pages, guides, entries });
}

/**
 * Checks the technology's guide pages (a limited refresh: guides and guide-like pages only, so nothing else is
 * fetched) unless offline, then returns those for the current and the previous major from the stored state.
 */
export async function currentGuides(src: Source, opts: { http: HttpClient; offline?: boolean; checked?: boolean; log?: (s: string) => void }): Promise<CurrentGuide[]> {
  // `checked`: the daily pass has just checked every guide page, so the stored state is current.
  if (!opts.offline && !opts.checked) await refresh(src, { http: opts.http, limit: 0, ...(opts.log ? { log: opts.log } : {}) });
  const state = readJson<StoredState>(join(docsDir(src.technology), "state.json"));
  if (!state) return [];
  const own = guideFilter(src, state);
  const pages = Object.entries(state.pages).filter(([url, p]) => p.guideMajor && own(url));
  const latest = opts.offline ? undefined : (await Promise.all(src.purls.map((p) => latestVersion(opts.http, p)))).find(Boolean);
  const majors = pages.map(([, p]) => Number(p.guideMajor)).filter((n) => Number.isFinite(n));
  const max = latest ? Number(latest.split(".")[0]) : Math.max(...majors);
  const store = docsStore(src.technology);
  const out: CurrentGuide[] = [];
  for (const [url, p] of pages) {
    const major = Number(p.guideMajor);
    if (!p.guideMajor || major > max || major < max - 1) continue; // the attribution rule: current or previous major
    const snap = (await store.getState(p.watch.id))?.snapshot;
    if (!snap) continue;
    out.push({ url, major: p.guideMajor, text: await store.getBlob(snap), snapshot: `sha256:${snap}` });
  }
  return out.sort((a, b) => Number(b.major) - Number(a.major) || a.url.localeCompare(b.url));
}
