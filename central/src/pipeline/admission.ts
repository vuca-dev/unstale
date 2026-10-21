// Admission signals and thresholds. Crawling and model extraction cost scale with the number of admitted packages, so a
// package is monitored only when it is maintained and used. The thresholds are per ecosystem, set once by the
// maintainer of the deployment in THRESHOLDS, never per technology. The rules, in order (eval/scope/RESULTS.md):
// - Type stubs (`@types/*` on npm, `types-*` on PyPI) are parked and name the package they type; they publish no notes.
// - A deprecated package (npm `deprecated` on the latest version, PyPI's "7 - Inactive" classifier, every release
//   yanked) is not monitored, but its verdict carries a `notice` so one "package deprecated" record can be published.
// - An archived repository is no longer a signal: its stars and pushes stop counting, and the package must qualify on
//   its registry (release and downloads). Projects that moved off GitHub archive the old repository and keep releasing
//   (prosemirror-view, released 20 days before the sample with 104M downloads a month), so archived alone never parks.
// - Maintained means a registry release (prereleases included) within the freshness window. A repository push counts
//   only when no release date can be read: `pushed_at` counts pushes to any branch, bot branches included.
// - Used means downloads at or above the floor, or stars at or above the floor for the repository's main package only:
//   a package with under 1% of the downloads of the top package declaring the same repository borrows its stars.
// A signal that cannot be read fails open: an unknown value does not reject a package that passes on another signal, and
// a package with no readable signal at all is admitted. A parked package is checked again later (onboarding/service.ts).
import { githubToken } from "../docs/fetcher.ts";
import { isRepoSlug } from "./util.ts";

export interface Signals {
  purl: string;
  /** Downloads in the registry's own window (npm: last week; PyPI: last week, from pypistats; crates.io: 90 days). */
  downloads?: number | undefined;
  downloadsWindow?: "week" | "90d" | undefined;
  stars?: number | undefined;
  /** The newest registry release, prereleases included (never a metadata or deprecation edit). */
  lastRelease?: string | undefined;
  /** The repository's last push (any branch); used for freshness only when `lastRelease` is unreadable. */
  lastCommit?: string | undefined;
  repo?: string | undefined;
  archived?: boolean | undefined;
  /** GitHub repositories (`owner/name`, lowercase, as the registry names them) that versions of the package other
   * than its current one name and that GitHub reports archived: a release line kept in a repository of its own ends
   * there while the package goes on elsewhere (`lineRepos`). */
  archivedLines?: string[] | undefined;
  /** The registry's deprecation: npm's message on the latest version, or why PyPI or crates.io marks it inactive. */
  deprecated?: string | undefined;
  /** This package's downloads as a share of the most-downloaded package of its registry that declares the same
   * repository (ecosyste.ms lookup), with that package's name. Read only when stars are the package's only path in. */
  repoShare?: number | undefined;
  repoTop?: string | undefined;
}

export interface Thresholds {
  /** A release at most this many days old. */
  freshDays: number;
  /** At least this many downloads in the registry's window... */
  minDownloads: number;
  /** ...or at least this many GitHub stars, for the repository's main package. */
  minStars: number;
}

/** Per-ecosystem floors. Starting values from the D1 sample (eval/docs-sources/admission.mts); revisit with demand data. */
export const THRESHOLDS: Record<string, Thresholds> = {
  npm: { freshDays: 365, minDownloads: 1_000, minStars: 100 },
  pypi: { freshDays: 365, minDownloads: 1_000, minStars: 100 },
  cargo: { freshDays: 365, minDownloads: 10_000, minStars: 100 }, // crates.io counts 90 days, not a week
};

/** Below this share of the repository's top package's downloads, a package's stars are borrowed. */
export const MAIN_PACKAGE_SHARE = 0.01;

/** Why a package was or was not admitted, for code (the `why` text is for people). */
export type Rule = "used" | "fails-open" | "no-thresholds" | "types" | "deprecated" | "archived" | "stale" | "unused";

export type Verdict = (
  | { admit: true; why: string; rule?: Rule }
  | {
      admit: false;
      why: string;
      rule?: Rule;
      /** Set on `deprecated`: the deprecation is itself a change users need, published once as a record. */
      notice?: { kind: "deprecated"; message?: string };
      /** Set on `types`: the package these type stubs belong to. */
      typesFor?: string;
    }
) & {
  /** Archived repositories that end a line of this package (`owner/name`, lowercase): its own repository when the
   * package does not qualify on its registry either (a project that moved off GitHub and keeps releasing is not
   * ended), and any other repository an older line named (`Signals.archivedLines`). A lifecycle fact, published on
   * the job status for clients to match against the repository their installed version names. */
  archived?: string[];
};

const ecosystemOf = (purl: string): string => /^pkg:(\w+)\//.exec(purl)?.[1] ?? "";
const nameOf = (purl: string): string => decodeURIComponent(/^pkg:\w+\/(.+)$/.exec(purl)?.[1] ?? "").replace(/(?<=.)@[^/@]+$/, "");

/** The package a type-stub package types (`@types/node` → node, `@types/babel__core` → @babel/core,
 * `types-requests` → requests), or undefined for any other package. */
export function typedPackage(purl: string): string | undefined {
  const name = nameOf(purl);
  const eco = ecosystemOf(purl);
  if (eco === "npm" && name.startsWith("@types/")) {
    const t = name.slice("@types/".length);
    return t.includes("__") ? `@${t.replace("__", "/")}` : t;
  }
  if (eco === "pypi" && /^types[-_]/i.test(name)) return name.slice(6);
  return undefined;
}

export function admit(s: Signals, t: Thresholds | undefined, now = Date.now()): Verdict {
  const v = verdictOf(s, t, now);
  const ended = [...(s.archived && !v.admit && s.repo ? [s.repo.toLowerCase()] : []), ...(s.archivedLines ?? [])];
  return ended.length ? { ...v, archived: [...new Set(ended)] } : v;
}

function verdictOf(s: Signals, t: Thresholds | undefined, now: number): Verdict {
  if (s.archived) {
    const v = judge({ ...s, stars: undefined, lastCommit: undefined }, t, now);
    if (v.admit) return v;
    // Parked either way, the archive is said: it is the maintainers' own statement that the package is over, which a
    // release gap alone is not.
    if (judge({ ...s, archived: false }, t, now).admit === false) return { ...v, why: `repository ${s.repo ?? ""} is archived; ${v.why}`.replace("  ", " ") };
    return { ...v, why: `repository ${s.repo ?? ""} is archived and the package does not qualify on its registry: ${v.why}`.replace("  ", " "), rule: "archived" };
  }
  return judge(s, t, now);
}

function judge(s: Signals, t: Thresholds | undefined, now: number): Verdict {
  if (!t) return { admit: true, why: "no thresholds for this ecosystem", rule: "no-thresholds" };
  const typed = typedPackage(s.purl);
  if (typed) return { admit: false, why: `type stubs for ${typed}; parked with the package they type`, rule: "types", typesFor: typed };
  if (s.deprecated !== undefined)
    return { admit: false, why: `deprecated by its registry${s.deprecated ? `: ${s.deprecated}` : ""}`, rule: "deprecated", notice: { kind: "deprecated", ...(s.deprecated ? { message: s.deprecated } : {}) } };
  const fresh = s.lastRelease ?? s.lastCommit;
  const age = fresh ? (now - Date.parse(fresh)) / 86_400_000 : undefined;
  const main = s.repoShare === undefined || s.repoShare >= MAIN_PACKAGE_SHARE;
  const used = [s.downloads === undefined ? undefined : s.downloads >= t.minDownloads, s.stars === undefined ? undefined : s.stars >= t.minStars && main];
  if (age === undefined && used.every((u) => u === undefined)) return { admit: true, why: "no readable signal (fails open)", rule: "fails-open" };
  if (age !== undefined && age > t.freshDays)
    return { admit: false, why: s.lastRelease ? `no release in ${t.freshDays} days` : `no release date readable and no push in ${t.freshDays} days`, rule: "stale" };
  if (used.some((u) => u === true)) return { admit: true, why: "maintained and used", rule: "used" };
  if (used.every((u) => u === undefined)) return { admit: true, why: "maintained; usage unreadable (fails open)", rule: "fails-open" };
  const borrowed = s.stars !== undefined && s.stars >= t.minStars && !main;
  return {
    admit: false,
    why: borrowed
      ? `under ${t.minDownloads} downloads; its ${s.stars} stars belong to ${s.repoTop ?? "the repository's main package"}`
      : `under ${t.minDownloads} downloads and ${t.minStars} stars`,
    rule: "unused",
  };
}

async function json(url: string, headers: Record<string, string> = {}): Promise<any> {
  try {
    const r = await fetch(url, { headers: { "user-agent": "unstale-central", accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
    return r.ok ? await r.json() : undefined;
  } catch {
    return undefined;
  }
}

/** npm weekly downloads for many packages: bulk requests for unscoped names (128 at a time), one each for scoped, eight
 * at a time (the API rate-limits bursts). */
export async function npmDownloads(names: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const plain = names.filter((n) => !n.startsWith("@"));
  for (let i = 0; i < plain.length; i += 128) {
    const batch = plain.slice(i, i + 128);
    const j = await json(`https://api.npmjs.org/downloads/point/last-week/${batch.join(",")}`);
    if (batch.length === 1 && typeof j?.downloads === "number") out.set(batch[0]!, j.downloads);
    else for (const n of batch) if (typeof j?.[n]?.downloads === "number") out.set(n, j[n].downloads);
  }
  const scoped = names.filter((x) => x.startsWith("@"));
  for (let i = 0; i < scoped.length; i += 8)
    await Promise.all(scoped.slice(i, i + 8).map(async (n) => {
      const j = await json(`https://api.npmjs.org/downloads/point/last-week/${n}`);
      if (typeof j?.downloads === "number") out.set(n, j.downloads);
    }));
  return out;
}

/** PyPI weekly downloads from pypistats, or undefined when unreadable. */
const pypiDownloads = async (name: string): Promise<number | undefined> => {
  const j = await json(`https://pypistats.org/api/packages/${name.toLowerCase()}/recent`);
  return typeof j?.data?.last_week === "number" ? j.data.last_week : undefined;
};

/** Weekly downloads by purl (npm in bulk, PyPI from pypistats four at a time); an unreadable count is left out. */
export async function weeklyDownloads(purls: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const npm = purls.filter((p) => ecosystemOf(p) === "npm");
  const counts = await npmDownloads(npm.map(nameOf));
  for (const p of npm) if (counts.has(nameOf(p))) out.set(p, counts.get(nameOf(p))!);
  const pypi = purls.filter((p) => ecosystemOf(p) === "pypi");
  for (let i = 0; i < pypi.length; i += 4)
    await Promise.all(pypi.slice(i, i + 4).map(async (p) => {
      const n = await pypiDownloads(nameOf(p));
      if (n !== undefined) out.set(p, n);
    }));
  return out;
}

const newest = (dates: Iterable<string | undefined>): string | undefined => {
  let best: string | undefined;
  for (const d of dates) if (d && !Number.isNaN(Date.parse(d)) && (!best || Date.parse(d) > Date.parse(best))) best = d;
  return best;
};

/** Release and deprecation signals from npm's full package document (`time` per version, `deprecated` on latest). */
export function fromNpm(doc: any): Pick<Signals, "lastRelease" | "deprecated"> {
  const versions = doc?.versions ?? {};
  const latest = versions[doc?.["dist-tags"]?.latest ?? ""];
  const dep = latest?.deprecated;
  return {
    lastRelease: newest(Object.entries(doc?.time ?? {}).filter(([v]) => v in versions).map(([, d]) => d as string)),
    ...(dep !== undefined && dep !== false ? { deprecated: typeof dep === "string" ? dep : "" } : {}),
  };
}

/** At most this many other repositories of one package are asked about (newest line first). */
export const MAX_LINE_REPOS = 3;

/** The GitHub repositories (`owner/name`, lowercase) that npm versions of a package name other than `current`, the
 * newest release's first: where older release lines were kept (codemirror 5 in its own repository, 6 in another). */
export function lineRepos(doc: any, current: string | undefined): string[] {
  const versions = doc?.versions ?? {};
  const time = doc?.time ?? {};
  const slug = (r: any): string | undefined => {
    const url = typeof r === "string" ? r : r?.url;
    const m = typeof url === "string" ? /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[#/?].*)?$/.exec(url) : null;
    return m && isRepoSlug(m[1]!) ? m[1]!.toLowerCase() : undefined;
  };
  const seen = new Set([current?.toLowerCase()]);
  const out: string[] = [];
  const order = Object.keys(versions).sort((a, b) => (Date.parse(time[b] ?? "") || 0) - (Date.parse(time[a] ?? "") || 0));
  for (const v of order) {
    const r = slug(versions[v]?.repository);
    if (r && !seen.has(r)) {
      seen.add(r);
      out.push(r);
      if (out.length >= MAX_LINE_REPOS) break;
    }
  }
  return out;
}

/** Release and inactivity signals from PyPI's JSON: the newest unyanked upload; inactive or every release yanked. */
export function fromPypi(doc: any): Pick<Signals, "lastRelease" | "deprecated"> {
  if (!doc) return {};
  const releases = Object.values<any[]>(doc.releases ?? {}).filter((files) => files?.length);
  const live = releases.flatMap((files) => files.filter((f) => !f.yanked));
  const inactive = (doc.info?.classifiers ?? []).some((c: string) => c.includes("7 - Inactive"));
  const allYanked = releases.length > 0 && live.length === 0;
  return {
    lastRelease: newest(live.map((f) => f.upload_time_iso_8601)),
    ...(inactive ? { deprecated: "marked Development Status :: 7 - Inactive" } : allYanked ? { deprecated: "every release is yanked" } : {}),
  };
}

/** Release and yank signals from crates.io. */
export function fromCargo(doc: any): Pick<Signals, "lastRelease" | "deprecated" | "downloads"> {
  if (!doc) return {};
  const versions: any[] = doc.versions ?? [];
  const live = versions.filter((v) => !v.yanked);
  return {
    downloads: doc.crate?.recent_downloads,
    lastRelease: newest(live.map((v) => v.created_at)),
    ...(versions.length > 0 && live.length === 0 ? { deprecated: "every version is yanked" } : {}),
  };
}

/** Stars, push and archive state from GitHub's repository document. */
export function fromGithub(doc: any): Pick<Signals, "stars" | "lastCommit" | "archived"> {
  return { stars: doc?.stargazers_count, lastCommit: doc?.pushed_at, archived: typeof doc?.archived === "boolean" ? doc.archived : undefined };
}

/** This package's share of the downloads of the top package of its registry declaring the same repository
 * (ecosyste.ms `packages/lookup?repository_url=`). Undefined when the lookup lacks the package or any downloads. */
export function repoShare(lookup: any, name: string, ecosystem: string): Pick<Signals, "repoShare" | "repoTop"> {
  const registry = { npm: "npmjs.org", pypi: "pypi.org", cargo: "crates.io" }[ecosystem];
  const same = (Array.isArray(lookup) ? lookup : []).filter((p) => (p?.registry?.name ?? registry) === registry && typeof p?.downloads === "number");
  const norm = (n: string) => (ecosystem === "pypi" ? n.toLowerCase().replace(/[-_.]+/g, "-") : n);
  const self = same.find((p) => norm(String(p.name)) === norm(name));
  const top = same.reduce<any>((a, p) => (!a || p.downloads > a.downloads ? p : a), undefined);
  if (!self || !top || top.downloads <= 0) return {};
  return { repoShare: self.downloads / top.downloads, ...(top.name !== self.name ? { repoTop: String(top.name) } : {}) };
}

/** The signals of one package, from its registry and (when known) its GitHub repository. The ecosyste.ms lookup is made
 * only when stars are the package's only way in (downloads below the floor, stars at or above it). */
export async function signals(purl: string, repo?: string, known: { downloads?: number | undefined } = {}, t: Thresholds | undefined = THRESHOLDS[ecosystemOf(purl)]): Promise<Signals> {
  const type = ecosystemOf(purl);
  const name = nameOf(purl);
  const out: Signals = { purl, repo };
  let lines: string[] = [];
  if (type === "npm") {
    // The full document: the abbreviated one's `modified` also moves on deprecations and metadata edits.
    const [doc, dl] = await Promise.all([json(`https://registry.npmjs.org/${name.replace("/", "%2f")}`), known.downloads ?? npmDownloads([name]).then((m) => m.get(name))]);
    Object.assign(out, fromNpm(doc));
    lines = lineRepos(doc, repo);
    out.downloads = dl;
    out.downloadsWindow = "week";
  } else if (type === "pypi") {
    const [doc, downloads] = await Promise.all([json(`https://pypi.org/pypi/${name}/json`), pypiDownloads(name)]);
    Object.assign(out, fromPypi(doc));
    out.downloads = downloads;
    out.downloadsWindow = "week";
  } else if (type === "cargo") {
    Object.assign(out, fromCargo(await json(`https://crates.io/api/v1/crates/${name}`)));
    out.downloadsWindow = "90d";
  }
  if (repo && isRepoSlug(repo)) {
    const token = githubToken();
    Object.assign(out, fromGithub(await json(`https://api.github.com/repos/${repo}`, token ? { authorization: `Bearer ${token}` } : {})));
    const starsOnly = t && out.stars !== undefined && out.stars >= t.minStars && !(out.downloads !== undefined && out.downloads >= t.minDownloads);
    if (starsOnly) Object.assign(out, repoShare(await json(`https://packages.ecosyste.ms/api/v1/packages/lookup?repository_url=${encodeURIComponent(`https://github.com/${repo}`)}`), name, type));
  }
  if (lines.length) {
    const token = githubToken();
    const docs = await Promise.all(lines.map((r) => json(`https://api.github.com/repos/${r}`, token ? { authorization: `Bearer ${token}` } : {})));
    const ended = lines.filter((_, i) => docs[i]?.archived === true);
    if (ended.length) out.archivedLines = ended;
  }
  return out;
}
