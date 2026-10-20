// Official GitHub release notes, cached under the central store. A release already stored is never requested again;
// the release list is requested at most once per freshness window (or with `refresh`). Each release is dated by the
// registry's publish time of its version where the registry has one (`publishDates`), else by the GitHub release.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { centralDir } from "./paths.ts";
import { SINCE, type Technology } from "./technologies.ts";
import { compareVersions, isRepoSlug, readJson, releaseLine, sha256, writeAtomic } from "./util.ts";
import { DEFAULT_HTTP, HttpClient } from "../collector/http.ts";
import { currentGuides, guideFilter } from "../docs/guides.ts";
import { lineBound } from "../docs/attribute.ts";
import { githubToken } from "../docs/fetcher.ts";
import { ecosystemOf } from "./ecosystems.ts";
import { isStable } from "./lines.ts";
import { registryCache } from "./registry.ts";
import { techLocal } from "../state/client.ts";
import { capped, pageText, pickChangelog, pointerLinks, repoFileLink, sectionFor, siteOf, versionSections } from "./changelog.ts";
import { httpFetcher } from "../docs/fetcher.ts";
import { RobotsCache } from "../docs/robots.ts";
import type { Fetcher } from "../docs/resolve.ts";

export interface ReleaseNote {
  technology: string;
  tag: string;
  version: string;
  /** The day the version was published: the registry's publish time where it has one, else the GitHub release's. */
  date: string;
  /** The day GitHub dates the release, when `date` is the registry's: the extraction prompt's date, so the prompt
   * (the extraction cache's key) does not move when a release gets its registry date. */
  noteDate?: string;
  url: string;
  /** `sha256:` + digest of the raw body as GitHub returned it; for a pointer body, of the body and the document it
   * links (so a release read again through its link is a new extraction); for a changelog section, of the section. */
  snapshot: string;
  /** The body with non-change parts removed; quotes are taken from this. */
  notes: string;
  /** Extraction-key tag of a note read through its link (`+linked.<first 8 hex of the linked snapshot>`): its records
   * never take the keys of those extracted from the bare pointer before. */
  keyTag?: string;
  /** Set for a note read from a moving page (an upgrade guide first read, or edited, after its major line moved past
   * x.0): the change shipped in a release from `version` up to this one (docs/attribute.ts `lineBound`). */
  noLaterThan?: string;
}

/** A release as the stored index keeps it: `date` is the GitHub release's day, `published` the registry's. */
interface StoredRelease {
  technology: string;
  tag: string;
  version: string;
  date: string;
  published?: string;
  url: string;
  snapshot: string;
  /** A pointer body's linked document (`<version>.linked.md`): its URL and `sha256:` snapshot; null when the body was
   * checked and nothing it links could be read as this release's notes. Absent: not checked yet. */
  linked?: { url: string; snapshot: string } | null;
}

interface ReleaseIndex {
  checked: string;
  tagPattern?: string;
  /** Whether any GitHub release of the repository (of any date) matched the tag pattern at the last listing. None
   * did: the project ships no GitHub releases for the package, and its changelog file is read instead. */
  matched?: boolean;
  releases: StoredRelease[];
}

const FRESH_MS = 12 * 3600 * 1000;
const dir = (t: Technology) => join(centralDir(), "releases", techLocal(t.id));
const indexPath = (t: Technology) => join(dir(t), "index.json");
const bodyPath = (t: Technology, version: string) => join(dir(t), `${version}.md`);
const timesName = (component: string) => {
  const type = /^pkg:([a-z0-9.+-]+)\//i.exec(component)?.[1]?.toLowerCase() ?? "other";
  return `${type}/times/${sha256(component).slice(0, 32)}`;
};

let token: string | undefined;
function ghToken(): string {
  // GITHUB_TOKEN, else `gh auth token`; read once, inside this process only; never printed.
  token ??= githubToken();
  if (!token) throw new Error("GitHub token required: set GITHUB_TOKEN or run `gh auth login`");
  return token;
}

interface GhRelease {
  tag_name: string;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  body: string | null;
  html_url: string;
}

async function listPage(repo: string, page: number): Promise<GhRelease[]> {
  if (!isRepoSlug(repo)) throw new Error(`not a GitHub repository: ${repo}`);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${ghToken()}`, Accept: "application/vnd.github+json", "User-Agent": "unstale-central" },
    });
    if (res.ok) return (await res.json()) as GhRelease[];
    if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`GitHub ${repo} page ${page}: ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

async function releaseByTag(repo: string, tag: string): Promise<GhRelease | undefined> {
  if (!isRepoSlug(repo)) throw new Error(`not a GitHub repository: ${repo}`);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: { Authorization: `Bearer ${ghToken()}`, Accept: "application/vnd.github+json", "User-Agent": "unstale-central" },
    });
    if (res.ok) return (await res.json()) as GhRelease;
    if (res.status === 404) return undefined;
    if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`GitHub ${repo} tag ${tag}: ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

/** The first release of `version`'s line (lines.ts: the major, or `0.minor` below 1.0): `7.0.0`, `0.21.0`. Undefined
 * for a version that is not plain `x.y.z`. */
export function lineStart(version: string): string | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return undefined;
  return m[1] === "0" ? `0.${m[2]}.0` : `${m[1]}.0.0`;
}

export interface FetchStats {
  requests: number;
  newReleases: number;
}

/**
 * The day each of `versions` was published to the registry, from the technology's components in order (the first
 * that lists the version). A component's publish times are cached under `cache/registry/<type>/times/` and read again
 * only when a version asked for is missing and the cache is older than the freshness window (or `refresh`); a
 * published version's time does not change. Offline, or when the registry cannot be read, the cache alone answers
 * (fails open: a version with no registry time keeps its GitHub date).
 */
export async function publishDates(t: Technology, versions: readonly string[], opts: { refresh?: boolean; offline?: boolean } = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let missing = [...new Set(versions)];
  for (const component of t.components) {
    if (!missing.length) break;
    const hook = ecosystemOf(component).publishTimes;
    if (!hook) continue;
    const p = timesName(component);
    const kept = registryCache().get(p);
    let cached = kept && (JSON.parse(kept.toString("utf8")) as { checked: string; times: Record<string, string> | null });
    const stale = !cached || opts.refresh || Date.now() - Date.parse(cached.checked) >= FRESH_MS;
    if (!opts.offline && stale && missing.some((v) => !cached?.times?.[v])) {
      try {
        cached = { checked: new Date().toISOString().replace(/\.\d+Z$/, "Z"), times: (await hook(component)) ?? null };
        registryCache().put(p, JSON.stringify(cached) + "\n");
      } catch (e) {
        console.error(`releases: ${t.id}: publish times of ${component} unreadable (${e instanceof Error ? e.message : e}); GitHub dates kept`);
      }
    }
    for (const v of missing) {
      const iso = cached?.times?.[v];
      if (iso && !Number.isNaN(Date.parse(iso))) out.set(v, new Date(iso).toISOString().slice(0, 10));
    }
    missing = missing.filter((v) => !out.has(v));
  }
  return out;
}

/**
 * The versions the registry published in the window, for a technology with no GitHub release notes (a changelog file
 * only: markdown-it, mathjs): the release index the advisories stage resolves against, so its advisories are not lost
 * for want of notes. Stable versions (lines.ts), dated by the registry (UTC day), each pointing at its registry page.
 * The first component whose ecosystem has the `publishTimes` and `versionPage` hooks answers; its publish times are
 * the cache `publishDates` keeps. Empty when none can be read (fails open: no advisories, as before).
 */
export async function registryReleases(t: Technology, opts: { refresh?: boolean; offline?: boolean } = {}): Promise<Array<{ version: string; date: string; url: string }>> {
  for (const component of t.components) {
    const eco = ecosystemOf(component);
    if (!eco.publishTimes || !eco.versionPage) continue;
    const p = timesName(component);
    const kept = registryCache().get(p);
    let cached = kept && (JSON.parse(kept.toString("utf8")) as { checked: string; times: Record<string, string> | null });
    const stale = !cached || opts.refresh || Date.now() - Date.parse(cached.checked) >= FRESH_MS;
    if (!opts.offline && stale) {
      try {
        cached = { checked: new Date().toISOString().replace(/\.\d+Z$/, "Z"), times: (await eco.publishTimes(component)) ?? null };
        registryCache().put(p, JSON.stringify(cached) + "\n");
      } catch (e) {
        console.error(`releases: ${t.id}: publish times of ${component} unreadable (${e instanceof Error ? e.message : e})`);
      }
    }
    const out: Array<{ version: string; date: string; url: string }> = [];
    for (const [version, iso] of Object.entries(cached?.times ?? {})) {
      if (!isStable(version) || Number.isNaN(Date.parse(iso))) continue;
      const date = new Date(iso).toISOString().slice(0, 10);
      if (date >= SINCE) out.push({ version, date, url: eco.versionPage(component, version) });
    }
    if (out.length) return out.sort((a, b) => a.date.localeCompare(b.date) || compareVersions(a.version, b.version));
  }
  return [];
}

/** The releases the advisories stage resolves against: the release notes when GitHub lists any, else the registry's
 * versions in the window (`registryReleases`). */
export async function advisoryReleases(
  t: Technology,
  notes: ReadonlyArray<{ version: string; date: string; url: string }>,
  opts: { refresh?: boolean; offline?: boolean } = {},
): Promise<ReadonlyArray<{ version: string; date: string; url: string }>> {
  return notes.length ? notes : registryReleases(t, opts);
}

export async function fetchReleases(t: Technology, opts: { refresh?: boolean; offline?: boolean } = {}): Promise<{ notes: ReleaseNote[]; checked: string; stats: FetchStats }> {
  let index = readJson<ReleaseIndex>(indexPath(t));
  const stats: FetchStats = { requests: 0, newReleases: 0 };
  const fresh = index && index.tagPattern === t.tag.source && Date.now() - Date.parse(index.checked) < FRESH_MS;
  // `offline`: the stored release list is used whatever its age (a rebuild that must not pick up new releases). An
  // empty index from before `matched` was kept is listed once more, to learn whether the changelog is the source.
  const listed = !index || opts.refresh || (!opts.offline && (!fresh || (!index.releases.length && index.matched === undefined)));
  const known = new Map((index?.releases ?? []).filter((r) => !listed || t.tag.test(r.tag)).map((r) => [r.tag, r]));
  const found = new Map<string, { r: GhRelease; release: StoredRelease }>();
  let matched = false;
  let truncated = true;
  if (listed) {
    for (let page = 1; page < 60; page++) {
      const rows = await listPage(t.repo, page);
      stats.requests++;
      for (const r of rows) {
        const m = t.tag.exec(r.tag_name);
        if (m && !r.draft) matched = true;
        const date = (r.published_at ?? "").slice(0, 10);
        if (!m || r.prerelease || r.draft || date < SINCE || known.has(r.tag_name) || found.has(r.tag_name)) continue;
        found.set(r.tag_name, { r, release: { technology: t.id, tag: r.tag_name, version: m[1]!, date, url: r.html_url, snapshot: `sha256:${sha256(r.body ?? "")}` } });
      }
      const oldest = rows.at(-1)?.published_at ?? "";
      if (rows.length < 100 || (oldest && oldest.slice(0, 10) < SINCE)) {
        truncated = false;
        break;
      }
    }
    // A listing that ran out of pages before the window's start (a repository releasing many packages: vercel/ai
    // tags about 100 a day, so its 59 pages reach back two months) misses the start of an older line, the x.0.0 release
    // whose notes carry the major's changes. Each line's start is then asked for by its tag, its line's tag with the
    // version replaced; one request per missing line start per listing.
    if (truncated) {
      const seen = new Map<string, string>();
      for (const r of [...known.values(), ...[...found.values()].map((f) => f.release)]) seen.set(r.version, r.tag);
      for (const [version, tag] of [...seen]) {
        const start = lineStart(version);
        if (!start || seen.has(start)) continue;
        const startTag = tag.split(version).join(start);
        seen.set(start, startTag);
        if (t.tag.exec(startTag)?.[1] !== start) continue;
        const r = await releaseByTag(t.repo, startTag);
        stats.requests++;
        const date = (r?.published_at ?? "").slice(0, 10);
        if (!r || r.prerelease || r.draft || date < SINCE) continue;
        found.set(r.tag_name, { r, release: { technology: t.id, tag: r.tag_name, version: start, date, url: r.html_url, snapshot: `sha256:${sha256(r.body ?? "")}` } });
      }
    }
  }
  // Dated by the registry: a stored release without a registry day gets one when the registry has it (stored indexes
  // are corrected on their next read), and a new release is in the window by that day, so a bulk import of old tags
  // as GitHub releases (jsdom: every release through 29.x on one day) is not taken for new releases.
  const undated = [...[...known.values()].filter((r) => !r.published), ...[...found.values()].map((f) => f.release)].map((r) => r.version);
  const days = undated.length ? await publishDates(t, undated, opts) : new Map<string, string>();
  let changed = false;
  for (const r of known.values()) {
    const d = r.published ? undefined : days.get(r.version);
    if (d) {
      r.published = d;
      changed = true;
    }
  }
  for (const { r, release } of found.values()) {
    const d = days.get(release.version);
    if (d) release.published = d;
    if ((release.published ?? release.date) < SINCE) continue;
    writeAtomic(bodyPath(t, release.version), r.body ?? "");
    known.set(release.tag, release);
    stats.newReleases++;
  }
  const day = (r: StoredRelease) => r.published ?? r.date;
  const prev = index;
  if (listed || changed || !prev) {
    // Only a listing renews the check time and tag pattern; filling in registry days alone keeps them.
    const releases = [...known.values()].sort((a, b) => day(a).localeCompare(day(b)) || compareVersions(a.version, b.version));
    index = prev && !listed ? { ...prev, releases } : { tagPattern: t.tag.source, checked: new Date().toISOString().replace(/\.\d+Z$/, "Z"), matched, releases };
    writeAtomic(indexPath(t), JSON.stringify(index, null, 1) + "\n");
  }
  if (!index) throw new Error(`release index unreadable: ${indexPath(t)}`);
  // No GitHub release of this package at all: its changelog file is its release notes.
  if (!index.releases.length && index.matched === false && t.repo) {
    const notes = await changelogNotes(t, opts, stats);
    return { notes, checked: index.checked, stats };
  }
  // Pointer bodies are read through their link once (a release body is never requested again, nor its link).
  if (!opts.offline && index.releases.some((r) => r.linked === undefined)) {
    let fetcher: Fetcher | undefined;
    let sites: Promise<Set<string> | undefined> | undefined;
    for (const r of index.releases) {
      if (r.linked !== undefined) continue;
      const raw = readBody(t, r);
      const urls = pointerLinks(raw);
      if (!urls.length) {
        r.linked = null;
        continue;
      }
      fetcher ??= linkFetcher();
      sites ??= publisherSites(t, fetcher);
      const doc = await linkedDocument(t, urls, r.version, fetcher, await sites, stats);
      if (doc === "retry") continue; // a link that could not be read now is tried again on the next read
      if (doc) writeAtomic(linkedPath(t, r.version), doc.text);
      r.linked = doc ? { url: doc.url, snapshot: `sha256:${sha256(doc.text)}` } : null;
    }
    writeAtomic(indexPath(t), JSON.stringify(index, null, 1) + "\n");
  }
  // A document several releases link (TypeScript 6.0.2 and 6.0.3 both link the 6.0 announcement) goes with the first
  // of them only: the later ones are their own bodies, so it is never extracted twice.
  const taken = new Set<string>();
  // A repository's tag on a release line none of the technology's packages ever published, while the registry went on
  // publishing them on that day or later, is another package line's (the MCP TypeScript SDK's `v2.3.0` covers its
  // split v2 packages; `@modelcontextprotocol/sdk` is published on 1.x only, 1.32.1 after it): not this technology's
  // release, so its notes are not dated to one of its versions. A new line the registry has not caught up with yet
  // (tagged after its newest publish) is kept.
  const reg = publishedLines(t);
  const own = index.releases.filter((r) => !reg || reg.lines.has(releaseLine(r.version)) || reg.newest < day(r));
  const notes = own.map((r) => {
    const raw = readBody(t, r);
    const { published, linked, ...rest } = r;
    let notes = t.clean(raw);
    let snapshot = r.snapshot;
    let keyTag: string | undefined;
    if (linked && !taken.has(linked.snapshot) && existsSync(linkedPath(t, r.version))) {
      const doc = readFileSync(linkedPath(t, r.version), "utf8");
      if (`sha256:${sha256(doc)}` !== linked.snapshot) throw new Error(`linked notes changed on disk: ${linkedPath(t, r.version)}`);
      taken.add(linked.snapshot);
      notes = `${notes.trim()}\n\n---\n\nRelease notes linked from this release (${linked.url}):\n\n${doc}`;
      snapshot = `sha256:${sha256(`${r.snapshot}\n${linked.snapshot}`)}`;
      keyTag = `+linked.${linked.snapshot.slice(7, 15)}`;
    }
    return { ...rest, snapshot, ...(keyTag ? { keyTag } : {}), ...(published && published !== r.date ? { date: published, noteDate: r.date } : {}), notes };
  });
  return { notes, checked: index.checked, stats };
}

/**
 * The release lines (major, or 0.minor) the technology's packages published and the day of the newest publish, from
 * the registry publish times `publishDates` caches; undefined when any component's cannot be told (no registry hook, nothing cached, unreadable):
 * then no release is left out (fails open).
 */
export function publishedLines(t: Pick<Technology, "components">): { lines: Set<string>; newest: string } | undefined {
  const lines = new Set<string>();
  let newest = "";
  for (const component of t.components) {
    if (!ecosystemOf(component).publishTimes) return undefined;
    const kept = registryCache().get(timesName(component));
    const times = kept && (JSON.parse(kept.toString("utf8")) as { times: Record<string, string> | null }).times;
    if (!times || !Object.keys(times).length) return undefined;
    for (const [v, iso] of Object.entries(times)) {
      if (Number.isNaN(Date.parse(iso))) continue;
      lines.add(releaseLine(v));
      const d = new Date(iso).toISOString().slice(0, 10);
      if (d > newest) newest = d;
    }
  }
  return { lines, newest };
}

function readBody(t: Technology, r: StoredRelease): string {
  const p = bodyPath(t, r.version);
  if (!existsSync(p)) throw new Error(`release body missing: ${p}`);
  const raw = readFileSync(p, "utf8");
  if (`sha256:${sha256(raw)}` !== r.snapshot) throw new Error(`release body changed on disk: ${p}`);
  return raw;
}

const linkedPath = (t: Technology, version: string) => join(dir(t), `${version}.linked.md`);
const linkHttp = () => new HttpClient({ ...DEFAULT_HTTP, perHost: 2 });
function linkFetcher(): Fetcher {
  const http = linkHttp();
  return httpFetcher(http, new RobotsCache(http), ghToken());
}

/** The sites the publisher declares (the repository's homepage, its owner's website), as registrable domains: a page
 * a pointer body links counts as release notes only there. A code host is nobody's publisher site. Undefined when
 * GitHub could not be read (the links are tried again later). */
async function publisherSites(t: Technology, f: Fetcher): Promise<Set<string> | undefined> {
  const out = new Set<string>();
  const owner = t.repo.split("/")[0]!;
  for (const [path, field] of [[`repos/${t.repo}`, "homepage"], [`users/${owner}`, "blog"]] as const) {
    const r = await f.get(`https://api.github.com/${path}`, "application/vnd.github+json", true);
    if (r.status === 404) continue;
    if (r.status !== 200) return undefined;
    try {
      const v = (JSON.parse(r.text) as Record<string, unknown>)[field];
      if (typeof v !== "string" || !v.trim()) continue;
      const host = new URL(/^https?:/i.test(v) ? v : `https://${v}`).hostname;
      if (!/(^|\.)(github\.com|github\.io|gitlab\.com|npmjs\.com)$/i.test(host)) out.add(siteOf(host));
    } catch {
      /* not a URL: no site */
    }
  }
  return out;
}

/** The first link of a pointer body that reads as this release's notes: the version's section of a Markdown file in
 * the repository, or a page on a publisher site. */
async function linkedDocument(t: Technology, urls: string[], version: string, f: Fetcher, sites: Set<string> | undefined, stats: FetchStats): Promise<{ url: string; text: string } | "retry" | undefined> {
  let transient = false;
  const failed = (status: number) => (transient ||= status === 0 || status === 429 || status >= 500);
  for (const url of urls.slice(0, 3)) {
    const file = repoFileLink(url);
    if (file) {
      if (file.repo.toLowerCase() !== t.repo.toLowerCase()) continue;
      const r = await f.get(file.raw, "text/plain, text/markdown;q=0.9, */*;q=0.1");
      stats.requests++;
      failed(r.status);
      const section = r.status === 200 ? sectionFor(r.text, version) : undefined;
      if (section && section.text.length > section.heading.length + 20) return { url, text: section.text + "\n" };
      continue;
    }
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") continue;
      host = u.hostname;
    } catch {
      continue;
    }
    if (/(^|\.)github\.com$/i.test(host)) continue;
    if (!sites) {
      transient = true;
      continue;
    }
    if (!sites.has(siteOf(host))) continue;
    const r = await f.get(url.replace(/#.*$/, ""), "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1");
    stats.requests++;
    if (r.status !== 200) {
      failed(r.status);
      continue;
    }
    let page: string;
    try {
      page = /^\s*</.test(r.text) ? pageText(r.text) : r.text;
    } catch {
      continue;
    }
    // A changelog page (Cypress's docs changelog, one heading per version) gives the version's section, or nothing
    // when it has none for it; a page that names no version in its headings (an announcement post) is read whole.
    const sections = versionSections(page);
    const own = sections.find((x) => x.version === version);
    const text = own ? own.text : sections.length >= 2 ? "" : capped(page);
    if (text.trim().length >= (own ? 40 : 500)) return { url, text: text.trim() + "\n" };
  }
  return transient ? "retry" : undefined;
}

// ---- Changelog files: a package with no GitHub release ships its notes in the repository (changelog.ts).

interface ChangelogIndex {
  checked: string;
  /** The file read (repository path) and the commit it was read at; null when the repository has none. */
  path: string | null;
  commit?: string;
  releases: StoredRelease[];
}

const changelogDir = (t: Technology) => join(dir(t), "changelog");
const changelogPath = (t: Technology, version: string) => join(changelogDir(t), `${version}.md`);

/** GitHub's anchor for a heading. */
const anchor = (heading: string) =>
  heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");

/**
 * The technology's changelog as release notes: the package directory's changelog file, else the repository root's,
 * read at the last commit that touched it, one note per stable version section. A version is taken when its
 * registry knows it (dated by its publish day) and it is in the window; where the registry has no publish times, a
 * date in its heading dates it. Each version is stored once and never read again; the file is checked at most once
 * per freshness window.
 */
async function changelogNotes(t: Technology, opts: { refresh?: boolean; offline?: boolean }, stats: FetchStats): Promise<ReleaseNote[]> {
  const ip = join(changelogDir(t), "index.json");
  let cl = readJson<ChangelogIndex>(ip);
  const fresh = cl && Date.now() - Date.parse(cl.checked) < FRESH_MS;
  if (!opts.offline && (!fresh || opts.refresh)) {
    const f = linkFetcher();
    const api = async <T>(path: string): Promise<T | undefined> => {
      stats.requests++;
      const r = await f.get(`https://api.github.com/repos/${t.repo}/${path}`, "application/vnd.github+json", true);
      if (r.status === 404) return undefined;
      if (r.status !== 200) throw new Error(`GitHub ${t.repo} ${path}: ${r.status}`);
      return JSON.parse(r.text) as T;
    };
    let path: string | undefined;
    for (const d of [...new Set([t.directory?.replace(/^\/+|\/+$/g, "") ?? "", ""])]) {
      const list = await api<Array<{ name: string; type: string }>>(`contents/${d.split("/").map(encodeURIComponent).join("/")}`);
      const name = Array.isArray(list) ? pickChangelog(list.filter((e) => e.type === "file").map((e) => e.name)) : undefined;
      if (name) {
        path = d ? `${d}/${name}` : name;
        break;
      }
    }
    const releases = cl?.releases ?? [];
    let commit = cl?.commit;
    if (path) {
      const commits = await api<Array<{ sha: string }>>(`commits?path=${encodeURIComponent(path)}&per_page=1`);
      const sha = commits?.[0]?.sha;
      if (sha && (sha !== cl?.commit || path !== cl?.path)) {
        stats.requests++;
        const r = await f.get(`https://raw.githubusercontent.com/${t.repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`, "text/plain, */*;q=0.1");
        if (r.status !== 200) throw new Error(`changelog ${t.repo}/${path}: ${r.status}`);
        const have = new Set(releases.map((x) => x.version));
        const sections = versionSections(r.text).filter((s) => !have.has(s.version));
        const days = await publishDates(t, sections.map((s) => s.version), opts);
        const registryDated = t.components.some((c) => ecosystemOf(c).publishTimes);
        for (const s of sections) {
          const day = days.get(s.version) ?? (registryDated ? undefined : /\b(20\d\d-\d\d-\d\d)\b/.exec(s.heading)?.[1]);
          if (!day || day < SINCE) continue;
          const text = s.text + "\n";
          writeAtomic(changelogPath(t, s.version), text);
          releases.push({ technology: t.id, tag: `${path}@${s.version}`, version: s.version, date: day, url: `https://github.com/${t.repo}/blob/${sha}/${path}#${anchor(s.heading)}`, snapshot: `sha256:${sha256(text)}` });
          stats.newReleases++;
        }
        commit = sha;
      }
    }
    releases.sort((a, b) => a.date.localeCompare(b.date) || compareVersions(a.version, b.version));
    cl = { checked: new Date().toISOString().replace(/\.\d+Z$/, "Z"), path: path ?? null, ...(commit ? { commit } : {}), releases };
    writeAtomic(ip, JSON.stringify(cl, null, 1) + "\n");
  }
  return (cl?.releases ?? []).map((r) => {
    const p = changelogPath(t, r.version);
    const raw = readFileSync(p, "utf8");
    if (`sha256:${sha256(raw)}` !== r.snapshot) throw new Error(`changelog section changed on disk: ${p}`);
    return { ...r, notes: t.clean(raw) };
  });
}

// ---- Upgrade guides. The docs module finds a technology's guides for the current and previous major (docs/guides.ts),
// so no table of guide paths is kept. Each guide page is ingested whole once, at the first snapshot seen; later edits
// reach extraction as section notes from the docs module, matched to these records by lineage (match.ts sameLineage),
// so a guide is never re-extracted whole. The stored index keeps, per page, that first snapshot and its text.

export interface GuideNote extends ReleaseNote {
  kind: "upgrade_guide";
  /** Extraction-key tag: `+guide.<first 8 hex of the snapshot>`. */
  keyTag: string;
}

interface GuideIndex {
  checked: string;
  /** `read`: the day the guide was first read (absent in entries written before 20 October 2026). */
  guides: Array<Omit<GuideNote, "notes" | "noLaterThan"> & { read?: string }>;
}

/**
 * The bound of a guide ingested whole (`ReleaseNote.noLaterThan`): a guide is a moving page, so one first read after
 * its major line moved past x.0 may carry sections added for any later release of the line read by then (TanStack's
 * `latest` v5 guide, first read at 5.104, describes `queryClient.query` of a later 5.x minor as if 5.0.0's). An entry
 * from before the read day was kept is dated its first read day unless that is its x.0.0 release's day.
 */
function guideBound(g: GuideIndex["guides"][number], releases: ReadonlyArray<{ version: string; date: string }>): string | undefined {
  const read = g.read ?? (releases.some((r) => r.version === g.version && r.date === g.date) ? undefined : g.date);
  if (!read) return undefined;
  return lineBound(g.version.split(".")[0]!, releases.filter((r) => r.date <= read).map((r) => r.version));
}

/**
 * Every ingested guide's bound by snapshot (other variants' guides too: records already cite them), for records the
 * store holds from before bounds were kept (`boundGuideRecords`).
 */
export function guideBounds(t: Technology, releases: ReadonlyArray<{ version: string; date: string }>): Map<string, { version: string; noLaterThan: string }> {
  const index = readJson<GuideIndex>(join(guideDir(t), "index.json"));
  const out = new Map<string, { version: string; noLaterThan: string }>();
  for (const g of index?.guides ?? []) {
    const b = guideBound(g, releases);
    if (b) out.set(g.snapshot, { version: g.version, noLaterThan: b });
  }
  return out;
}

const guideDir = (t: Technology) => join(centralDir(), "guides", techLocal(t.id));

export async function fetchGuides(
  t: Technology,
  releases: Array<{ version: string; date: string }>,
  opts: { refresh?: boolean; offline?: boolean; http?: HttpClient; checked?: boolean } = {},
): Promise<GuideNote[]> {
  const ip = join(guideDir(t), "index.json");
  const index = readJson<GuideIndex>(ip) ?? { checked: "", guides: [] };
  const fresh = index.checked && Date.now() - Date.parse(index.checked) < FRESH_MS;
  if (!opts.offline && (opts.refresh || opts.checked || !fresh)) {
    const found = await currentGuides({ technology: t.id, purls: t.components.map((p) => p.replace("%40", "@")) }, { http: opts.http ?? new HttpClient(DEFAULT_HTTP), ...(opts.checked ? { checked: true } : {}) });
    for (const g of found) {
      if (index.guides.some((x) => x.url === g.url)) continue; // ingested whole once; edits come as section notes
      const version = `${g.major}.0.0`;
      // Dated to the x.0.0 release it describes; today when that release is outside the window.
      const date = releases.find((r) => r.version === version)?.date ?? new Date().toISOString().slice(0, 10);
      writeAtomic(join(guideDir(t), `${g.major}.${g.snapshot.slice(7, 15)}.md`), g.text);
      const read = new Date().toISOString().slice(0, 10);
      index.guides.push({ technology: t.id, kind: "upgrade_guide", tag: `guide-${g.major}`, version, date, url: g.url, snapshot: g.snapshot, keyTag: `+guide.${g.snapshot.slice(7, 15)}`, read });
    }
    index.checked = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    writeAtomic(ip, JSON.stringify(index, null, 1) + "\n");
  }
  // Entries from the old table-driven path (a repository file at a commit) stay in the index as history but are no
  // longer sources: a newer repository snapshot there would re-extract the whole guide. A guide ingested before the
  // technology's own were told from other variants' (docs/guides.ts `ownGuide`) stays in the index but is no source.
  const own = guideFilter({ technology: t.id, purls: t.components.map((p) => p.replace("%40", "@")) });
  return index.guides
    .filter((g) => !("repo" in g) && own(g.url))
    .map((g) => {
      const p = join(guideDir(t), `${g.version.split(".")[0]}.${g.snapshot.slice(7, 15)}.md`);
      const { read: _, ...note } = g;
      const bound = guideBound(g, releases);
      return { ...note, ...(bound ? { noLaterThan: bound } : {}), notes: readFileSync(p, "utf8") };
    });
}
