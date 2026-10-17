// Official GitHub release notes, cached under the central store. A release already stored is never requested again;
// the release list is requested at most once per freshness window (or with `refresh`).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { centralDir } from "./paths.ts";
import { SINCE, type Technology } from "./technologies.ts";
import { compareVersions, isRepoSlug, readJson, sha256, writeAtomic } from "./util.ts";
import { DEFAULT_HTTP, HttpClient } from "../collector/http.ts";
import { currentGuides } from "../docs/guides.ts";
import { githubToken } from "../docs/fetcher.ts";

export interface ReleaseNote {
  technology: string;
  tag: string;
  version: string;
  date: string;
  url: string;
  /** `sha256:` + digest of the raw body as GitHub returned it. */
  snapshot: string;
  /** The body with non-change parts removed; quotes are taken from this. */
  notes: string;
}

interface ReleaseIndex {
  checked: string;
  tagPattern?: string;
  releases: Array<Omit<ReleaseNote, "notes">>;
}

const FRESH_MS = 12 * 3600 * 1000;
const dir = (t: Technology) => join(centralDir(), "releases", t.id);
const indexPath = (t: Technology) => join(dir(t), "index.json");
const bodyPath = (t: Technology, version: string) => join(dir(t), `${version}.md`);

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

export async function fetchReleases(t: Technology, opts: { refresh?: boolean; offline?: boolean } = {}): Promise<{ notes: ReleaseNote[]; checked: string; stats: FetchStats }> {
  let index = readJson<ReleaseIndex>(indexPath(t));
  const stats: FetchStats = { requests: 0, newReleases: 0 };
  const fresh = index && index.tagPattern === t.tag.source && Date.now() - Date.parse(index.checked) < FRESH_MS;
  // `offline`: the stored release list is used whatever its age (a rebuild that must not pick up new releases).
  if (!index || opts.refresh || (!fresh && !opts.offline)) {
    const known = new Map((index?.releases ?? []).filter(r => t.tag.test(r.tag)).map((r) => [r.tag, r]));
    for (let page = 1; page < 60; page++) {
      const rows = await listPage(t.repo, page);
      stats.requests++;
      for (const r of rows) {
        const m = t.tag.exec(r.tag_name);
        const date = (r.published_at ?? "").slice(0, 10);
        if (!m || r.prerelease || r.draft || date < SINCE || known.has(r.tag_name)) continue;
        const raw = r.body ?? "";
        const version = m[1]!;
        writeAtomic(bodyPath(t, version), raw);
        known.set(r.tag_name, { technology: t.id, tag: r.tag_name, version, date, url: r.html_url, snapshot: `sha256:${sha256(raw)}` });
        stats.newReleases++;
      }
      const oldest = rows.at(-1)?.published_at ?? "";
      if (rows.length < 100 || (oldest && oldest.slice(0, 10) < SINCE)) break;
    }
    index = {
      tagPattern: t.tag.source,
      checked: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      releases: [...known.values()].sort((a, b) => a.date.localeCompare(b.date) || compareVersions(a.version, b.version)),
    };
    writeAtomic(indexPath(t), JSON.stringify(index, null, 1) + "\n");
  }
  const notes = index.releases.map((r) => {
    const p = bodyPath(t, r.version);
    if (!existsSync(p)) throw new Error(`release body missing: ${p}`);
    const raw = readFileSync(p, "utf8");
    if (`sha256:${sha256(raw)}` !== r.snapshot) throw new Error(`release body changed on disk: ${p}`);
    return { ...r, notes: t.clean(raw) };
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

const guideDir = (t: Technology) => join(centralDir(), "guides", t.id);

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
