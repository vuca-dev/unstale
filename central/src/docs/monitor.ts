// The docs module's daily pass for one technology: resolve its docs sources (cached), list each site's pages, check
// every page through the Collector, and record change events: created, modified, deleted, moved, template and
// restructure, each changed section attributed to a version where the page says which. Events are append-only and keyed
// by (document, previous snapshot, new snapshot), so a rerun adds nothing. Extraction reads the events later
// (extract.ts); this pass makes no model calls.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Collector } from "../collector/collector.ts";
import { discoverMany } from "../collector/discover.ts";
import { DEFAULT_HEADERS, FetchFailure, type HttpClient } from "../collector/http.ts";
import { WatchSpec, type CheckResult, type WatchSpecInput } from "../collector/schema.ts";
import { allAdded, sectionDiff, type Context, type SectionChange } from "../collector/sections.ts";
import { FsStore } from "../collector/store.ts";
import { findTemplateChanges } from "../collector/template.ts";
import { centralDir } from "../pipeline/paths.ts";
import { ensureLocal } from "../state/client.ts";
import { readJson, sha256, writeAtomic } from "../pipeline/util.ts";
import { attribute, guideCandidate, guideMajor, publishable, type Attribution } from "./attribute.ts";
import { httpFetcher } from "./fetcher.ts";
import { listSite, type Listing, type ListedPage } from "./listing.ts";
import { createResolver, type Resolution } from "./resolve.ts";
import { RobotsCache } from "./robots.ts";
import { sharedPages } from "./pages.ts";
import { siteSignal } from "./signals.ts";

export type EventKind = "created" | "modified" | "deleted" | "moved" | "template" | "restructure";

/** A changed section as logged: no hunks (they are recomputed from the snapshots), with its attribution. */
export interface LoggedSection {
  path: string[];
  from?: string[];
  status: SectionChange["status"];
  added: number;
  removed: number;
  attribution: Attribution;
}

export interface DocsEvent {
  key: string;
  technology: string;
  kind: EventKind;
  at: string;
  url: string;
  /** Moved: where the page went. */
  to?: string;
  site: string;
  watch?: string;
  previous?: string;
  snapshot?: string;
  sections?: LoggedSection[];
  /** Template and restructure events: pages involved. */
  pages?: number;
  revertsTo?: string;
}

interface PageState {
  site: string;
  watch: WatchSpecInput & { id: string };
  guideMajor?: string;
  namespaceMajor?: string;
  /** When the page was last checked: a run under a page budget checks the least recently checked first. */
  checked?: string;
}

interface SiteState {
  site: string;
  prefix: string;
  /** How a page URL becomes its Markdown copy, decided once per site from sampled pages. */
  copyRule: "llms" | "append-md" | "index-md" | "negotiated" | "html";
  listing: Omit<Listing, "pages">;
  /** sha256 of the site's llms-full.txt when every one of its pages was last checked (signals.ts). */
  llmsFull?: string;
  /** The listing named no page (the site had pages when resolved); its previous pages, if any, were kept. */
  listingFailed?: boolean;
}

interface State {
  technology: string;
  at: string;
  sites: SiteState[];
  pages: Record<string, PageState>;
}

export interface Source {
  technology: string;
  /** The technology's components: its docs are traced from each, and the strongest answers kept. */
  purls: string[];
}

export const docsDir = (tech: string) => join(centralDir(), "docs", tech);
/** A technology's page snapshots and watch states, restored from the saved state on first use (state/client.ts). */
export const docsStore = (tech: string): FsStore => new FsStore(join(docsDir(tech), "store"), () => ensureLocal(`docs:${tech}`));

export async function latestVersion(http: HttpClient, purl: string): Promise<string | undefined> {
  const [, type, rest] = /^pkg:(\w+)\/(.+)$/.exec(purl) ?? [];
  const name = decodeURIComponent(rest ?? "");
  const url =
    type === "npm" ? `https://registry.npmjs.org/${name.replace("/", "%2f")}/latest` : type === "pypi" ? `https://pypi.org/pypi/${name}/json` : type === "cargo" ? `https://crates.io/api/v1/crates/${name}` : undefined;
  if (!url) return undefined;
  try {
    const j = JSON.parse(Buffer.from((await http.get(url, { ...DEFAULT_HEADERS, accept: "application/json" })).body).toString("utf8"));
    return type === "npm" ? j.version : type === "pypi" ? j.info?.version : j.crate?.max_stable_version;
  } catch (e) {
    if (e instanceof FetchFailure || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

const DEPS_DEV: Record<string, string> = { npm: "npm", pypi: "pypi", cargo: "cargo" };

/**
 * Every published version of a package, from deps.dev (one compact list for npm, PyPI and crates.io; 43 kB for
 * Next.js against 2 MB for its npm document), with each minor as `x.y.0` too, so a "since v16.4" marker matches a
 * line whose first release was 16.4.1. A marker naming a version the package never had (another product on a shared
 * docs host, a typo) is then ignored (attribute.ts). Undefined when the list cannot be read: markers are then checked
 * against the current major only, as before.
 */
export async function releasedVersions(http: HttpClient, purl: string): Promise<Set<string> | undefined> {
  const [, type, rest] = /^pkg:(\w+)\/(.+)$/.exec(purl) ?? [];
  const system = DEPS_DEV[type ?? ""];
  if (!system) return undefined;
  const name = decodeURIComponent(rest ?? "");
  try {
    const res = await http.get(`https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}`, { ...DEFAULT_HEADERS, accept: "application/json" });
    const j = JSON.parse(Buffer.from(res.body).toString("utf8")) as { versions?: Array<{ versionKey?: { version?: string } }> };
    const out = new Set<string>();
    for (const v of j.versions ?? []) {
      const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.versionKey?.version ?? "");
      if (!m) continue;
      out.add(`${m[1]}.${m[2]}.${m[3] ?? 0}`);
      out.add(`${m[1]}.${m[2]}.0`);
    }
    return out.size ? out : undefined;
  } catch (e) {
    if (e instanceof FetchFailure || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

export async function resolveSources(http: HttpClient, robots: RobotsCache, src: Source, refresh = false): Promise<Resolution[]> {
  const path = join(docsDir(src.technology), "sources.json");
  const cached = readJson<{ at: string; purls: string[]; resolutions: Resolution[] }>(path);
  if (cached && !refresh && cached.purls?.join(" ") === src.purls.join(" ")) return cached.resolutions; // another package set (or format) re-resolves
  const resolver = createResolver(httpFetcher(http, robots));
  const resolutions: Resolution[] = [];
  for (const purl of src.purls) resolutions.push(await resolver.resolve(purl));
  writeAtomic(path, JSON.stringify({ at: new Date().toISOString(), purls: src.purls, resolutions }, null, 1) + "\n");
  return resolutions;
}

const STRENGTH = ["site+repo", "site-only", "repo-only", "readme-only", "none"];

/**
 * Live sites, one per final URL, from the components whose answer is strongest (a validated site and repository over
 * a site alone): a CLI package with no docs of its own does not dilute its technology's site.
 */
export function sitesOf(rs: readonly Resolution[]): Array<{ site: string; prefix: string }> {
  const kind = (r: Resolution) => STRENGTH.indexOf((r.answer as { kind: string }).kind);
  const best = Math.min(...rs.map(kind));
  const out = new Map<string, { site: string; prefix: string }>();
  for (const r of rs.filter((x) => kind(x) === best)) {
    const a = r.answer as { sites?: Array<{ site: string; pages: number; prefix?: string }> };
    for (const s of a.sites ?? []) if (s.pages > 0 && !out.has(s.site)) out.set(s.site, { site: s.site, prefix: s.prefix ?? "" });
  }
  return [...out.values()];
}

async function copyRule(http: HttpClient, pages: ListedPage[]): Promise<SiteState["copyRule"]> {
  if (pages.length && pages.filter((p) => p.copy).length >= pages.length * 0.5) return "llms";
  const sample = [0.2, 0.5, 0.8].map((f) => pages[Math.floor(f * (pages.length - 1))]).filter((p): p is ListedPage => !!p);
  if (!sample.length) return "html";
  const found = await discoverMany(http, [...new Set(sample.map((p) => p.url))]);
  const rules = found.map((d) => {
    if ("error" in d || !d.copy) return "html" as const;
    if (d.copy.negotiated) return "negotiated" as const;
    const page = d.page.replace(/\/$/, "");
    if (d.copy.url === `${page}.md`) return "append-md" as const;
    if (d.copy.url === `${page}/index.md`) return "index-md" as const;
    return "html" as const;
  });
  const best = rules.find((r) => r !== "html" && rules.filter((x) => x === r).length >= Math.min(2, rules.length));
  return best ?? "html";
}

function watchFor(page: ListedPage, rule: SiteState["copyRule"]): WatchSpecInput & { id: string } {
  const md = { format: "markdown" as const, normalize: { canonicalMarkdown: true, dropFrontMatter: true } };
  const u = page.url;
  if (page.copy && (rule === "llms" || rule === "html")) return { id: `${u} llms-md`, url: page.copy, ...md };
  if (rule === "append-md") return { id: `${u} md`, url: `${u}.md`, ...md };
  if (rule === "index-md") return { id: `${u} md`, url: `${u}/index.md`, ...md };
  if (rule === "negotiated") return { id: `${u} negotiated`, url: u, headers: { accept: "text/markdown" }, ...md };
  return { id: `${u} html`, url: u, format: "html" };
}

export interface RefreshOptions {
  http: HttpClient;
  now?: () => Date;
  /** Re-run source resolution (otherwise the cached resolution is used). */
  resolve?: boolean;
  /** Check at most this many pages per site (a trial run); the listing is still complete. */
  limit?: number;
  /**
   * Check at most this many pages in all, new pages and then the least recently checked first (upgrade guides are
   * always checked): a large site is covered over several runs, and a change on a page not checked this run is found
   * on a later one, diffed against the snapshot it had.
   */
  budget?: number;
  /** Pages checked so far and pages to check in this run. */
  progress?: (done: number, total: number) => void;
  log?: (s: string) => void;
}

export interface RefreshReport {
  technology: string;
  sites: Array<{ site: string; prefix: string; method: string; pages: number; listingFailed?: boolean; copyRule: string; dropped: Listing["dropped"]; namespaces: string[] }>;
  checked: number;
  outcomes: Record<string, number>;
  events: Record<string, number>;
  sections: { publishable: number; held: Record<string, number> };
  baseline: boolean;
  /** Sites whose pages were not checked because a site-level signal says nothing changed (signals.ts). */
  quiet?: Record<string, "llms-full" | "repo">;
}

export async function refresh(src: Source, opts: RefreshOptions): Promise<RefreshReport> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const dir = docsDir(src.technology);
  const robots = new RobotsCache(opts.http);
  const resolutions = await resolveSources(opts.http, robots, src, opts.resolve);
  const latest = (await Promise.all(src.purls.map((p) => latestVersion(opts.http, p)))).filter((v): v is string => !!v).sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]))[0];
  const latestMajor = latest?.split(".")[0];
  // The versions of every component, or none when any list is unreadable (a partial list would drop real markers).
  const lists = await Promise.all(src.purls.map((p) => releasedVersions(opts.http, p)));
  const versions = lists.every(Boolean) && lists.length ? new Set(lists.flatMap((l) => [...l!])) : undefined;
  const prev = readJson<State>(join(dir, "state.json"));
  const at = now().toISOString();

  // 1. Listing, per site. Every site here had pages when resolved (sitesOf), so a listing of none is a failed listing:
  //    the site's previous pages are kept and checked as before (never "deleted"), and a site that had none yet is a
  //    baseline when its pages first appear (never "created").
  const sites: SiteState[] = [];
  const listed = new Map<string, { site: SiteState; page: ListedPage }>();
  const hadPages = (site: string) => !!prev && Object.values(prev.pages).some((p) => p.site === site);
  const baselineSites = new Set<string>();
  for (const { site, prefix } of sitesOf(resolutions)) {
    const listing = await listSite(opts.http, robots, site, prefix, { latestMajor });
    if (!hadPages(site)) baselineSites.add(site);
    // The copy rule is learned from listed pages; one learned from an empty listing is learned again.
    const known = hadPages(site) ? prev?.sites.find((s) => s.site === site) : undefined;
    const rule = known?.copyRule ?? (await copyRule(opts.http, listing.pages));
    const { pages, ...rest } = listing;
    const st: SiteState = { site, prefix, copyRule: rule, listing: rest };
    sites.push(st);
    for (const p of pages) if (!listed.has(p.url)) listed.set(p.url, { site: st, page: p });
    if (!pages.length) {
      st.listingFailed = true;
      for (const [u, p] of Object.entries(prev?.pages ?? {})) if (p.site === site && !listed.has(u)) listed.set(u, { site: st, page: { url: u } });
    }
    log(`${site}: ${pages.length} pages (${listing.method})${st.listingFailed ? ", listing failed" : ""}, copy rule ${rule}`);
  }

  const pages: Record<string, PageState> = {};
  for (const [url, { site, page }] of listed) {
    const ns = site.listing.namespaces.find((n) => n.kept && n.kind === "version" && new URL(url).pathname.split("/")[n.position] === n.segment);
    const old = prev?.pages[url];
    // A page kept from an earlier listing (this one failed) keeps the namespace that listing found.
    const nsMajor = (ns && /^v?(\d+)/i.exec(ns.segment)?.[1]) || (site.listingFailed ? old?.namespaceMajor : undefined);
    // An unnumbered guide's major was read from its text when first seen (below); the URL alone cannot restore it.
    const gm = guideMajor(url) ?? old?.guideMajor;
    pages[url] = {
      site: site.site,
      // A watch keeps its representation across runs: a new copy rule applies to new pages only, so it never rebaselines.
      watch: old && old.site === site.site ? old.watch : watchFor(page, site.copyRule),
      ...(gm ? { guideMajor: gm } : {}),
      ...(nsMajor ? { namespaceMajor: nsMajor } : {}),
      ...(old?.checked ? { checked: old.checked } : {}),
    };
  }

  // 2. Pages that left the listing: a permanent redirect is a move, 404 or 410 a deletion, 200 an incomplete listing
  // (kept). A large share leaving at once is one restructure event.
  const store = docsStore(src.technology);
  const events: DocsEvent[] = [];
  const gone = prev ? Object.keys(prev.pages).filter((u) => !pages[u]) : [];
  const movedTo = new Map<string, { from: string; snapshot?: string }>();
  const restructure = prev && gone.length > Math.max(20, 0.3 * Object.keys(prev.pages).length);
  if (restructure) {
    events.push(ev(src, { kind: "restructure", at, url: sites[0]?.site ?? "", site: sites[0]?.site ?? "", pages: gone.length }));
    log(`restructure: ${gone.length} pages left the listing; new pages are baselined, not reported as created`);
  } else {
    for (const u of gone) {
      const old = prev!.pages[u]!;
      const last = (await store.getState(old.watch.id))?.snapshot;
      let status = 0;
      let location: string | undefined;
      try {
        if (await robots.allowed(u)) ({ status, location } = await opts.http.probe(u, { ...DEFAULT_HEADERS, accept: "text/html" }));
      } catch (e) {
        if (!(e instanceof FetchFailure)) throw e;
      }
      if (status >= 300 && status < 400 && location) {
        const to = (() => {
          try {
            const x = new URL(location);
            x.hash = "";
            x.search = "";
            if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
            return x.toString();
          } catch {
            return location;
          }
        })();
        movedTo.set(to, { from: u, ...(last ? { snapshot: last } : {}) });
        if (!pages[to]) events.push(ev(src, { kind: "moved", at, url: u, to, site: old.site, ...(last ? { previous: last } : {}) }));
      } else if (status === 404 || status === 410) {
        const sections = last ? log_(sectionDiff(await store.getBlob(last), ""), pages[u] ?? old, undefined) : [];
        events.push(ev(src, { kind: "deleted", at, url: u, site: old.site, watch: old.watch.id, ...(last ? { previous: last } : {}), sections }));
      } else if (status === 200) pages[u] = old; // still served: the listing is incomplete
    }
  }

  // 3. Site-level signals (signals.ts): a site its llms-full.txt or its source repository shows unchanged since every
  //    one of its pages was last checked is not checked page by page.
  const fetcher = httpFetcher(opts.http, robots);
  const quiet: Record<string, "llms-full" | "repo"> = {};
  const signals = new Map<string, string | undefined>();
  for (const st of sites) {
    const own = Object.entries(pages).filter(([, p]) => p.site === st.site);
    const checks = own.map(([, p]) => p.checked);
    const since = own.length && checks.every(Boolean) ? (checks as string[]).sort()[0]! : undefined;
    const before = prev?.sites.find((x) => x.site === st.site);
    const newPages = own.some(([u]) => !prev?.pages[u]);
    const sig = await siteSignal(fetcher, st, resolutions, before && since ? { since, llmsFull: before.llmsFull, newPages } : undefined);
    signals.set(st.site, sig.llmsFull);
    if (before?.llmsFull) st.llmsFull = before.llmsFull;
    if (sig.quiet) {
      quiet[st.site] = sig.quiet;
      log(`${st.site}: unchanged (${sig.quiet}); pages not checked`);
    }
  }

  // 4. Check pages: upgrade guides first (release priority), then new pages, then the least recently checked, within
  //    robots.txt and the run's budget.
  const guide = (u: string, p: PageState) => !!p.guideMajor || guideCandidate(u);
  const order = Object.entries(pages).sort(([a, x], [b, y]) => Number(guide(b, y)) - Number(guide(a, x)) || (x.checked ?? "").localeCompare(y.checked ?? "") || a.localeCompare(b));
  const specs: WatchSpec[] = [];
  const perSite = new Map<string, number>();
  let taken = 0;
  for (const [u, p] of order) {
    if (quiet[p.site]) continue;
    const n = perSite.get(p.site) ?? 0;
    if (!guide(u, p) && ((opts.limit !== undefined && n >= opts.limit) || (opts.budget !== undefined && taken >= opts.budget))) continue; // guides always
    if (!(await robots.allowed(p.watch.url))) continue;
    perSite.set(p.site, n + 1);
    if (!guide(u, p)) taken++;
    p.checked = at;
    specs.push(WatchSpec.parse(p.watch));
  }
  // A site's llms-full.txt hash is kept once every one of its pages has been checked against it.
  for (const st of sites) {
    const sig = signals.get(st.site);
    if (sig && !quiet[st.site] && Object.values(pages).every((p) => p.site !== st.site || p.checked === at)) st.llmsFull = sig;
  }
  const byId = new Map(Object.entries(pages).map(([u, p]) => [p.watch.id, { url: u, page: p }]));
  // Pages fetched for another technology today are served from the shared page cache (pages.ts).
  const collector = new Collector(sharedPages(opts.http, src.technology), store);
  let done = 0;
  const results = await collector.checkAll(specs, () => {
    if (++done % 100 === 0) log(`checked ${done}/${specs.length}`);
    opts.progress?.(done, specs.length);
  });

  // 5. Outcomes to events. Template changes (one identical diff on several pages of a site) are one event.
  const siteOfId = (r: CheckResult) => byId.get(r.id)?.page.site ?? new URL(r.url).host;
  const templates = findTemplateChanges(results, 3, siteOfId);
  const templated = new Set(templates.flatMap((t) => t.ids));
  for (const t of templates) events.push(ev(src, { kind: "template", at, url: t.host, site: t.host, pages: t.ids.length, snapshot: t.signature }));
  const outcomes: Record<string, number> = {};
  const urls = Object.keys(pages);
  for (const r of results) {
    const key = r.outcome.status === "failed" ? `failed:${r.outcome.failure}` : r.outcome.status;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    const hit = byId.get(r.id)!;
    const o = r.outcome;
    // The site's copy rule does not hold for every page: a page whose copy is missing or not Markdown falls back to
    // its HTML from the next run (a new watch, baselined silently since the page is already listed).
    if (o.status === "failed" && (o.httpStatus === 404 || o.failure === "format_mismatch") && !r.id.endsWith(" html")) {
      hit.page.watch = watchFor({ url: hit.url }, "html");
    }
    // An unnumbered guide (`/migration-guide`) names its major in its text: read once, kept with the page.
    // A page with pages under it (`/guides/upgrading`) is the index of the guides, not one of them.
    // A page baselined before its major was kept (unchanged since) is read once from its current snapshot.
    const fresh = o.status === "first_seen" || o.status === "changed" || o.status === "rebaseline";
    const quiet = (o.status === "not_modified" || o.status === "unchanged") && guideCandidate(hit.url);
    if ((fresh || quiet) && !hit.page.guideMajor && !urls.some((u) => u.startsWith(hit.url + "/"))) {
      const snapshot = "snapshot" in o ? o.snapshot : (await store.getState(r.id))?.snapshot;
      const gm = snapshot ? guideMajor(hit.url, await store.getBlob(snapshot)) : undefined;
      if (gm) hit.page.guideMajor = gm;
    }
    if (o.status === "changed" && !templated.has(r.id)) {
      const text = await store.getBlob(o.snapshot);
      const sections = log_(o.sections ?? sectionDiff(await store.getBlob(o.previous), text), hit.page, text);
      events.push(ev(src, { kind: "modified", at, url: hit.url, site: hit.page.site, watch: r.id, previous: o.previous, snapshot: o.snapshot, sections, ...(o.revertsTo ? { revertsTo: o.revertsTo } : {}) }));
    } else if (o.status === "first_seen" && prev && !restructure && !prev.pages[hit.url] && !baselineSites.has(hit.page.site)) {
      const text = await store.getBlob(o.snapshot);
      const from = movedTo.get(hit.url);
      if (from) {
        const sections = from.snapshot ? log_(sectionDiff(await store.getBlob(from.snapshot), text), hit.page, text) : [];
        events.push(ev(src, { kind: "moved", at, url: from.from, to: hit.url, site: hit.page.site, watch: r.id, snapshot: o.snapshot, ...(from.snapshot ? { previous: from.snapshot } : {}), sections }));
      } else events.push(ev(src, { kind: "created", at, url: hit.url, site: hit.page.site, watch: r.id, snapshot: o.snapshot, sections: log_(allAdded(text), hit.page, text) }));
    }
  }

  // 6. Persist: events appended once each, then the state.
  const logPath = join(dir, "events.jsonl");
  const have = new Set(existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as DocsEvent).key) : []);
  const fresh = events.filter((e) => !have.has(e.key));
  if (fresh.length) appendFileSync(logPath, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // Every listed page is kept, checked or not (a trial limit): "created" means new to the listing, so a page first
  // checked on a later run is baselined, not reported.
  // Compact JSON: internal state, never published (13% smaller than indented).
  writeAtomic(join(dir, "state.json"), JSON.stringify({ technology: src.technology, at, sites, pages } satisfies State) + "\n");

  const sections = { publishable: 0, held: {} as Record<string, number> };
  for (const e of fresh) for (const s of e.sections ?? []) {
    if (publishable(s.attribution)) sections.publishable++;
    else sections.held[s.attribution.by] = (sections.held[s.attribution.by] ?? 0) + 1;
  }
  const counts: Record<string, number> = {};
  for (const e of fresh) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return {
    technology: src.technology,
    sites: sites.map((s) => ({
      site: s.site,
      prefix: s.prefix,
      method: s.listing.method,
      pages: Object.values(pages).filter((p) => p.site === s.site).length,
      ...(s.listingFailed ? { listingFailed: true } : {}),
      copyRule: s.copyRule,
      dropped: s.listing.dropped,
      namespaces: s.listing.namespaces.map((n) => `${n.kept ? "+" : "-"}${n.kind}:${n.segment}@${n.position}(${n.pages}, mirror ${n.mirror})`),
    })),
    checked: specs.length,
    outcomes,
    events: counts,
    sections,
    baseline: !prev,
    ...(Object.keys(quiet).length ? { quiet } : {}),
  };

  function log_(changes: SectionChange[], page: PageState, text: string | undefined): LoggedSection[] {
    const gm = page.guideMajor ?? (text !== undefined ? guideMajor(page.watch.url.replace(/\.md$/, ""), text) : undefined);
    return changes.map(({ hunks, ...c }) => ({ ...c, attribution: attribute({ ...c, hunks }, { guideMajor: gm, namespaceMajor: page.namespaceMajor, maxMajor: latestMajor, versions }) }));
  }
}

function ev(src: Source, e: Omit<DocsEvent, "key" | "technology">): DocsEvent {
  const key = sha256([e.kind, e.url, e.to ?? "", e.previous ?? "", e.snapshot ?? ""].join(" ")).slice(0, 24);
  return { key, technology: src.technology, ...e };
}

export function readEvents(tech: string): DocsEvent[] {
  const p = join(docsDir(tech), "events.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as DocsEvent) : [];
}

/** The hunks of an event's sections, recomputed from its snapshots (the log keeps only their hashes). */
export async function eventChanges(e: DocsEvent, context: Context = 3): Promise<SectionChange[]> {
  const store = docsStore(e.technology);
  const before = e.previous ? await store.getBlob(e.previous) : "";
  const after = e.snapshot && e.kind !== "template" ? await store.getBlob(e.snapshot) : "";
  if (e.kind === "created") return allAdded(after);
  return sectionDiff(before, after, context);
}
