// Official GitHub release notes, cached under the central store. A release already stored is never requested again;
// the release list is requested at most once per freshness window (or with `refresh`). Each release is dated by the
// registry's publish time of its version where the registry has one (`publishDates`), else by the GitHub release.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { centralDir } from "./paths.ts";
import { SINCE, type Technology } from "./technologies.ts";
import { compareVersions, isRepoSlug, readJson, sha256, writeAtomic } from "./util.ts";
import { DEFAULT_HTTP, HttpClient } from "../collector/http.ts";
import { currentGuides } from "../docs/guides.ts";
import { githubToken } from "../docs/fetcher.ts";
import { ecosystemOf } from "./ecosystems.ts";
import { registryCache } from "./registry.ts";
import { techLocal } from "../state/client.ts";

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
  /** `sha256:` + digest of the raw body as GitHub returned it. */
  snapshot: string;
  /** The body with non-change parts removed; quotes are taken from this. */
  notes: string;
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
}

interface ReleaseIndex {
  checked: string;
  tagPattern?: string;
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

export async function fetchReleases(t: Technology, opts: { refresh?: boolean; offline?: boolean } = {}): Promise<{ notes: ReleaseNote[]; checked: string; stats: FetchStats }> {
  let index = readJson<ReleaseIndex>(indexPath(t));
  const stats: FetchStats = { requests: 0, newReleases: 0 };
  const fresh = index && index.tagPattern === t.tag.source && Date.now() - Date.parse(index.checked) < FRESH_MS;
  // `offline`: the stored release list is used whatever its age (a rebuild that must not pick up new releases).
  const listed = !index || opts.refresh || (!fresh && !opts.offline);
  const known = new Map((index?.releases ?? []).filter((r) => !listed || t.tag.test(r.tag)).map((r) => [r.tag, r]));
  const found = new Map<string, { r: GhRelease; release: StoredRelease }>();
  if (listed) {
    for (let page = 1; page < 60; page++) {
      const rows = await listPage(t.repo, page);
      stats.requests++;
      for (const r of rows) {
        const m = t.tag.exec(r.tag_name);
        const date = (r.published_at ?? "").slice(0, 10);
        if (!m || r.prerelease || r.draft || date < SINCE || known.has(r.tag_name) || found.has(r.tag_name)) continue;
        found.set(r.tag_name, { r, release: { technology: t.id, tag: r.tag_name, version: m[1]!, date, url: r.html_url, snapshot: `sha256:${sha256(r.body ?? "")}` } });
      }
      const oldest = rows.at(-1)?.published_at ?? "";
      if (rows.length < 100 || (oldest && oldest.slice(0, 10) < SINCE)) break;
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
    index = prev && !listed ? { ...prev, releases } : { tagPattern: t.tag.source, checked: new Date().toISOString().replace(/\.\d+Z$/, "Z"), releases };
    writeAtomic(indexPath(t), JSON.stringify(index, null, 1) + "\n");
  }
  if (!index) throw new Error(`release index unreadable: ${indexPath(t)}`);
  const notes = index.releases.map((r) => {
    const p = bodyPath(t, r.version);
    if (!existsSync(p)) throw new Error(`release body missing: ${p}`);
    const raw = readFileSync(p, "utf8");
    if (`sha256:${sha256(raw)}` !== r.snapshot) throw new Error(`release body changed on disk: ${p}`);
    const { published, ...rest } = r;
    return { ...rest, ...(published && published !== r.date ? { date: published, noteDate: r.date } : {}), notes: t.clean(raw) };
  });
  return { notes, checked: index.checked, stats };
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
  guides: Array<Omit<GuideNote, "notes">>;
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
      index.guides.push({ technology: t.id, kind: "upgrade_guide", tag: `guide-${g.major}`, version, date, url: g.url, snapshot: g.snapshot, keyTag: `+guide.${g.snapshot.slice(7, 15)}` });
    }
    index.checked = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    writeAtomic(ip, JSON.stringify(index, null, 1) + "\n");
  }
  // Entries from the old table-driven path (a repository file at a commit) stay in the index as history but are no
  // longer sources: a newer repository snapshot there would re-extract the whole guide.
  return index.guides
    .filter((g) => !("repo" in g))
    .map((g) => {
      const p = join(guideDir(t), `${g.version.split(".")[0]}.${g.snapshot.slice(7, 15)}.md`);
      return { ...g, notes: readFileSync(p, "utf8") };
    });
}
