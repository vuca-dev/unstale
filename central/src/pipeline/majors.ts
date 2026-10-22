// A major's upgrade material beyond the docs listing, read only for majors someone is behind (demand-driven).
//
// The docs module finds the upgrade guides its listing names (docs/guides.ts), for the current and previous major. Most
// urgent breaking changes a codebase still hits are documented elsewhere: a major-release blog post or a guide the
// x.0.0 release links (React 19, Babel 8, LangChain v1), the x.0.0 release body itself when it is older than the release
// window (tough-cookie 5, yargs 18), or the package directory's changelog when the major has no GitHub release
// (a monorepo's packages). This module finds those, per major, in this order:
//   1. the x.0.0 notes: the GitHub release of the line start (in the window, or by its tag), else its section of the
//      changelog in the package's directory or one above it;
//   2. the pages those notes link that are this major's upgrade material: a guide path naming the major
//      (`v8-migration`, `react-19-upgrade-guide`) first, then a page whose path names the release (`8.0.0`,
//      `langchain-v1`); the Markdown copy (`<url>.md`) before the page;
//   3. the x.0.0 notes themselves, when older than the window (newer ones are read as release notes already);
//   4. the repository's own upgrade files (`UPGRADING.md`, `MIGRATION.md`, `docs/*migrat*`), when 1 to 3 found none.
// Each document is ingested whole once (fetch.ts `fetchGuides`), so a major costs its extraction once.
//
// Demand: clients send no installed versions (Source Registry and Coverage: privacy), so "a registered repository is
// behind major N" is read from the registry's public per-version downloads (ecosystems.ts `versionDownloads`): a major
// is wanted when at least BEHIND_SHARE of last week's downloads are on stable lines below it. An ecosystem without
// per-version downloads, or a count that cannot be read, falls back to the current and previous major (the docs
// guides' window). A technology nobody is behind gets nothing here: no request past the registry's and no tokens.
// Majors below 1 (0.x lines) are not majors here: every 0.minor is a line, so a 0.x technology would read one guide
// per release.
import { createHash } from "node:crypto";
import { guideMajor } from "../docs/attribute.ts";
import type { Fetcher } from "../docs/resolve.ts";
import { capped, pageText, pickChangelog, pointerLinks, repoFileLink, sectionFor, siteOf, versionSections } from "./changelog.ts";
import { ecosystemOf } from "./ecosystems.ts";
import { isStable } from "./lines.ts";
import { registryCache } from "./registry.ts";
import type { Technology } from "./technologies.ts";

/** Share of last week's downloads on lines below a major that makes it wanted. */
export const BEHIND_SHARE = 0.01;
/** Linked documents read per major. */
const LINKS_PER_MAJOR = 2;
/** Notes or a section shorter than this carry no change (nanoid 6.0.0's one line, "Removed Node.js 18 and 20 support", is
 * longer). */
const MIN_NOTES = 40;
/** A linked page shorter than this is a stub or a redirect page. */
const MIN_PAGE = 500;
const DOWNLOADS_FRESH_MS = 7 * 24 * 3600 * 1000;

export interface MajorDoc {
  major: string;
  url: string;
  text: string;
  /** Where it was found: a page the notes link, the x.0.0 notes themselves, or the repository's upgrade file. */
  via: "linked" | "release" | "repo-file";
}

export interface Wanted {
  majors: number[];
  /** `adoption`: from per-version downloads; `window`: the current and previous major (no downloads to read). */
  basis: "adoption" | "window";
}

const majorOf = (v: string): number => Number(v.split(".")[0]);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Last week's downloads per version, summed over the technology's components, cached for a week; undefined when no
 * component's ecosystem reports them or none could be read. */
async function downloads(t: Pick<Technology, "id" | "components">, offline: boolean): Promise<Map<string, number> | undefined> {
  let out: Map<string, number> | undefined;
  for (const c of t.components) {
    const hook = ecosystemOf(c).versionDownloads;
    if (!hook) continue;
    const key = `downloads/${sha(c).slice(0, 32)}`;
    const kept = registryCache().get(key);
    let cached = kept && (JSON.parse(kept.toString("utf8")) as { checked: string; counts: Record<string, number> | null });
    if (!offline && (!cached || Date.now() - Date.parse(cached.checked) >= DOWNLOADS_FRESH_MS)) {
      try {
        cached = { checked: new Date().toISOString().replace(/\.\d+Z$/, "Z"), counts: (await hook(c)) ?? null };
        registryCache().put(key, JSON.stringify(cached) + "\n");
      } catch (e) {
        console.error(`majors: ${t.id}: downloads of ${c} unreadable (${e instanceof Error ? e.message : e})`);
      }
    }
    if (!cached?.counts) continue;
    out ??= new Map();
    for (const [v, n] of Object.entries(cached.counts)) out.set(v, (out.get(v) ?? 0) + n);
  }
  return out;
}

/**
 * The majors (≥ 1) whose upgrade material is wanted: those with a stable x.0.0 published and at least BEHIND_SHARE of
 * last week's stable downloads below them; without downloads, the current and previous major.
 */
export function wantedMajors(versions: readonly string[], counts: ReadonlyMap<string, number> | undefined): Wanted {
  const starts = [...new Set(versions.filter((v) => isStable(v) && /^\d+\.0\.0$/.test(v)).map(majorOf))].filter((n) => n >= 1).sort((a, b) => a - b);
  if (!starts.length) return { majors: [], basis: counts ? "adoption" : "window" };
  if (!counts) return { majors: starts.slice(-2), basis: "window" };
  const stable = [...counts].filter(([v]) => isStable(v));
  const total = stable.reduce((s, [, n]) => s + n, 0);
  if (!total) return { majors: [], basis: "adoption" };
  return { majors: starts.filter((m) => stable.filter(([v]) => majorOf(v) < m).reduce((s, [, n]) => s + n, 0) / total >= BEHIND_SHARE), basis: "adoption" };
}

export async function wanted(t: Pick<Technology, "id" | "components">, versions: readonly string[], offline = false): Promise<Wanted> {
  return wantedMajors(versions, await downloads(t, offline));
}

/** The links of a text, Markdown and bare, `http:` read as `https:`, in order, without fragments, once each. */
export function links(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/g)) {
    const u = m[0].replace(/[.,;:!?*_]+$/, "").replace(/^http:/, "https:").replace(/#.*$/, "");
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** Hosts that hold code, packages or discussions, not a publisher's pages. */
const NOT_PAGES = /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|npmjs\.com|npmjs\.org|pypi\.org|twitter\.com|x\.com|discord\.gg|discord\.com|bsky\.app|opencollective\.com|stackoverflow\.com|youtube\.com|shields\.io)$/i;

/**
 * How well a linked URL reads as major `n`'s upgrade material: 2, a guide path naming the major (`v8-migration`);
 * 1, a page whose path names the release (`8.0.0`, `langchain-v1`, `react-19`); 0, neither. Pure numbers (dates in a
 * blog path) never count.
 */
export function linkRank(url: string, n: number): number {
  let segs: string[];
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || NOT_PAGES.test(u.hostname)) return 0;
    segs = u.pathname.toLowerCase().split("/").filter(Boolean);
  } catch {
    return 0;
  }
  if (guideMajor(url) === String(n)) return 2;
  const names = new RegExp(`^(?:v?${n}\\.0(?:\\.0)?|(?:[a-z][a-z0-9]*-)+v?${n}|v${n}|v?${n}(?:-[a-z][a-z0-9]*)+)$`);
  return segs.some((s) => names.test(s.replace(/\.(md|mdx|html?)$/, ""))) ? 1 : 0;
}

/** A page as text: its Markdown copy (`<url>.md`) when the host serves one, else its article. */
async function readPage(f: Fetcher, url: string): Promise<{ url: string; text: string } | undefined> {
  const base = url.replace(/\/+$/, "");
  if (!/\.(md|mdx)$/i.test(base)) {
    const md = await f.get(`${base}.md`, "text/markdown, text/plain;q=0.9, */*;q=0.1");
    if (md.status === 200 && !/^\s*</.test(md.text) && md.text.trim().length >= MIN_PAGE) return { url, text: capped(md.text.trim()) + "\n" };
  }
  const r = await f.get(url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1");
  if (r.status !== 200) return undefined;
  let text: string;
  try {
    text = /^\s*</.test(r.text) ? pageText(r.text) : r.text;
  } catch {
    return undefined;
  }
  return text.trim().length >= MIN_PAGE ? { url, text: capped(text.trim()) + "\n" } : undefined;
}

export interface MajorSource {
  /** The x.0.0 notes: the release body, or the changelog section; with its URL and whether it is older than the window. */
  notes(n: number): Promise<{ url: string; text: string; old: boolean } | undefined>;
  /** The repository's upgrade files as `[path, raw URL]`. */
  upgradeFiles(): Promise<Array<[string, string]>>;
  fetcher: Fetcher;
  repo: string;
}

/** Major `n`'s upgrade material (see the header), excluding documents at URLs already ingested. */
export async function majorDocs(n: number, src: MajorSource, seen: ReadonlySet<string>): Promise<MajorDoc[]> {
  const major = String(n);
  const out: MajorDoc[] = [];
  // The same page under another host of the site (`19.react.dev` for `react.dev`) or with a trailing slash is one page.
  const same = (u: string) => {
    try {
      const x = new URL(u);
      return `${siteOf(x.hostname)}${x.pathname.replace(/\/+$/, "").replace(/\.(md|html?)$/, "")}`;
    } catch {
      return u;
    }
  };
  const known = (u: string) => seen.has(u) || [...seen].some((x) => same(x) === same(u)) || out.some((d) => same(d.url) === same(u));
  const notes = await src.notes(n);
  if (notes) {
    // A Markdown file of the same repository (a pointer body's `CHANGELOG.md`) counts for its section of this release.
    const ownFile = (u: string) => {
      const f = repoFileLink(u);
      return f && f.repo.toLowerCase() === src.repo.toLowerCase() ? f : undefined;
    };
    const ranked = links(notes.text)
      .map((u) => ({ u, rank: ownFile(u) ? 1 : linkRank(u, n) }))
      .filter((x) => x.rank > 0 && !known(x.u))
      .sort((a, b) => b.rank - a.rank);
    for (const { u } of ranked) {
      if (out.length >= LINKS_PER_MAJOR) break;
      const file = ownFile(u);
      if (file) {
        const r = await src.fetcher.get(file.raw, "text/plain, text/markdown;q=0.9, */*;q=0.1");
        const section = r.status === 200 ? sectionFor(r.text, `${n}.0.0`) : undefined;
        if (section && section.text.trim().length >= MIN_NOTES) out.push({ major, url: u, text: section.text.trim() + "\n", via: "linked" });
        continue;
      }
      const page = await readPage(src.fetcher, u);
      if (page && !known(page.url)) out.push({ major, url: page.url, text: page.text, via: "linked" });
    }
    // A pointer body (a line and a link) is no notes of its own.
    if (notes.old && !pointerLinks(notes.text).length && notes.text.trim().length >= MIN_NOTES && !known(notes.url)) out.push({ major, url: notes.url, text: notes.text.trim() + "\n", via: "release" });
  }
  if (out.length) return out;
  for (const [path, raw] of await src.upgradeFiles()) {
    const url = `https://github.com/${src.repo}/blob/HEAD/${path}`;
    if (known(url)) continue;
    const r = await src.fetcher.get(raw, "text/plain, text/markdown;q=0.9, */*;q=0.1");
    if (r.status !== 200) continue;
    const section = sectionFor(r.text, `${n}.0.0`) ?? versionSections(r.text).find((s) => s.version === `${n}.0` || s.version === major);
    const named = new RegExp(`(^|[^0-9.])v?${n}([^0-9.]|$)`).test(path.split("/").at(-1)!) || guideMajor(`https://x.invalid/${path.split("/").at(-1)!.replace(/\.(md|mdx|markdown)$/i, "").toLowerCase()}`, r.text) === major;
    const text = section ? section.text : named ? capped(r.text) : "";
    if (text.trim().length >= MIN_NOTES) out.push({ major, url, text: text.trim() + "\n", via: "repo-file" });
  }
  return out;
}

/** Repository files that are upgrade guides by name: at the root, or in a `docs/` directory. */
export function upgradeFileNames(entries: ReadonlyArray<{ path: string; type: string }>): string[] {
  return entries
    .filter((e) => e.type === "file" && /\.(md|mdx|markdown)$/i.test(e.path))
    .filter((e) => (/^[^/]+$/.test(e.path) && /^(upgrad|migrat)/i.test(e.path)) || (/^docs?\/[^/]+$/i.test(e.path) && /(upgrad|migrat)/i.test(e.path)))
    .map((e) => e.path);
}

/** The repository directory a homepage in the repository's tree names (`https://github.com/o/r/tree/main/libs/x/`). */
export function treeDirectory(repo: string, homepage: string | undefined): string | undefined {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/tree\/[^/]+\/([^?#]+?)\/?(?:[?#].*)?$/i.exec(homepage ?? "");
  return m && m[1]!.toLowerCase() === repo.toLowerCase() ? decodeURIComponent(m[2]!) : undefined;
}

/** The changelog section of `version` in the package's directory or the nearest directory above it that has one. */
export async function changelogSection(f: Fetcher, repo: string, directory: string | undefined, version: string, files: Map<string, string | null>): Promise<{ url: string; text: string } | undefined> {
  const parts = (directory ?? "").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const dir = parts.slice(0, i).join("/");
    let raw = files.get(dir);
    if (raw === undefined) {
      raw = null;
      const r = await f.get(`https://api.github.com/repos/${repo}/contents/${dir.split("/").map(encodeURIComponent).join("/")}`, "application/vnd.github+json", true);
      const list = r.status === 200 ? (JSON.parse(r.text) as Array<{ name: string; type: string }>) : [];
      const name = Array.isArray(list) ? pickChangelog(list.filter((e) => e.type === "file").map((e) => e.name)) : undefined;
      if (name) {
        const path = dir ? `${dir}/${name}` : name;
        const body = await f.get(`https://raw.githubusercontent.com/${repo}/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`, "text/plain, */*;q=0.1");
        if (body.status === 200) raw = `${path}\n${body.text}`;
      }
      files.set(dir, raw);
    }
    if (!raw) continue;
    const nl = raw.indexOf("\n");
    const section = sectionFor(raw.slice(nl + 1), version);
    if (section && section.text.length > section.heading.length + 20) return { url: `https://github.com/${repo}/blob/HEAD/${raw.slice(0, nl)}`, text: section.text };
  }
  return undefined;
}
