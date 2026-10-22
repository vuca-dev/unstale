// What the advisories stage needs from an ecosystem, beyond what any ecosystem port needs anyway (a registry adapter,
// a release index, a lockfile reader at the edge). Every hook is optional; an ecosystem without one fails open:
//   - compare: the ecosystem's version order, for OSV `ECOSYSTEM` ranges. Without it only the explicit `versions` list
//     OSV gives for such a range is used, and a range with neither is left unresolved (the edge then says nothing);
//   - siblings: other packages published from the technology's repository, from registry metadata only. Without it
//     the technology's components are the only packages queried;
//   - dependencies: the packages a release installs for its users (runtime dependencies, not development or peer
//     ones), from registry metadata. Without it another package's advisory named in the notes is never taken for a
//     dependency update (advisories.ts step 8): the record keeps its labels;
//   - registryPage: the package a registry page URL is for (npm `npmjs.com/package/<name>`). Without it a record about
//     another package listed in the notes is never recognised as such (advisories.ts step 9): the record keeps its labels;
//   - publishTimes: when each version of a package was published to the registry (npm `time`, PyPI the first file's
//     upload). A release is dated by it (fetch.ts); without it, by its GitHub release, which a bulk import of old tags
//     dates all on one day;
//   - repositoryPackages: packages published from the technology's repository, with their descriptions, from registry
//     metadata (npm: the packages of a maintainer of the components). Without it no heading is read as naming another package
//     (advisories.ts step 11): the record keeps its components.
//   - versionDownloads: last week's downloads of each version (npm's public downloads API): how many installs are on
//     each release line, the public stand-in for "someone is behind this major" (clients send no installed versions).
//     Without it a technology's upgrade material is read for its current and previous major only (fetch.ts, majors.ts);
//   - versionPage: the registry page of one version. With publishTimes, a technology with no GitHub release notes gets
//     the registry's versions as its release index (fetch.ts `registryReleases`), so its advisories resolve; without
//     it such a technology gets no advisories (as before).
// No hand-written package lists, no per-technology tables (memory rule: ecosystem vocabularies, fail open).
import type { Technology } from "./technologies.ts";
import { pool } from "./util.ts";

export interface Ecosystem {
  /** OSV's name for the ecosystem. */
  osv: string;
  compare?: (a: string, b: string) => number | undefined;
  siblings?: (t: Technology) => Promise<string[]>;
  /** Package URLs a release of `component` installs for its users; undefined when the registry does not list it
   * (the package was not published at that version). */
  dependencies?: (component: string, version: string) => Promise<string[] | undefined>;
  /** The package (package URL) a registry page URL is for; undefined when the URL is not one of its package pages. */
  registryPage?: (url: string) => string | undefined;
  /** Version → ISO publish time of `component` on the registry; undefined when the registry does not know it. */
  publishTimes?: (component: string) => Promise<Record<string, string> | undefined>;
  /** Packages published from the technology's repository, with their registry descriptions. */
  repositoryPackages?: (t: Technology) => Promise<RegistryPackage[] | undefined>;
  /** The registry page of one version of `component` (where a release with no notes points, fetch.ts). */
  versionPage?: (component: string, version: string) => string;
  /** Version → last week's downloads of `component`; undefined when the registry does not report them. */
  versionDownloads?: (component: string) => Promise<Record<string, number> | undefined>;
}

/** A package as the registry describes it (`repositoryPackages`). */
export interface RegistryPackage {
  purl: string;
  name: string;
  description: string;
}

// ---- SemVer 2.0 precedence (OSV `SEMVER` ranges are SemVer by definition, whatever the ecosystem) ----

interface V {
  nums: number[];
  pre: string[];
}
function parseV(v: string): V | undefined {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return undefined;
  return { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ? m[4].split(".") : [] };
}

/** SemVer precedence (a prerelease sorts before its release); undefined when either side is not a version. */
export function semverOrder(a: string, b: string): number | undefined {
  const x = parseV(a);
  const y = parseV(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// ---- PEP 440 (PyPI) ----

/** PEP 440 order for the common public forms (`N[.N]*`, `aN`/`bN`/`rcN`, `.postN`, `.devN`, epochs `E!`); local
 * labels (`+x`) are ignored. Undefined when either side is not such a version. */
export function pep440Order(a: string, b: string): number | undefined {
  const parse = (v: string) => {
    const m = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+.*)?$/i.exec(v.trim());
    if (!m) return undefined;
    const pre = m[3]?.toLowerCase();
    const preRank = pre === undefined ? 3 : pre.startsWith("a") ? 0 : pre.startsWith("b") ? 1 : 2;
    return { epoch: Number(m[1] ?? 0), rel: m[2]!.split(".").map(Number), pre: [preRank, Number(m[4] || 0)], post: m[5] === undefined ? -1 : Number(m[5] || 0), dev: m[6] === undefined ? Infinity : Number(m[6] || 0) };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return undefined;
  if (x.epoch !== y.epoch) return x.epoch - y.epoch;
  for (let i = 0; i < Math.max(x.rel.length, y.rel.length); i++) {
    const d = (x.rel[i] ?? 0) - (y.rel[i] ?? 0);
    if (d) return d;
  }
  // A dev release of a final version sorts before its pre-releases.
  const devOnly = (v: typeof x) => v.pre[0] === 3 && v.post < 0 && v.dev !== Infinity;
  if (devOnly(x) !== devOnly(y)) return devOnly(x) ? -1 : 1;
  for (const [p, q] of [[x.pre, y.pre], [[x.post], [y.post]], [[x.dev], [y.dev]]] as const)
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i]! < q[i]! ? -1 : 1;
  return 0;
}

// ---- npm ----

export const npmName = (purl: string): string => decodeURIComponent(purl.replace(/^pkg:npm\//, ""));
export const npmPurl = (name: string): string => `pkg:npm/${name.replace(/^@/, "%40")}`;

/** `owner/name` of a GitHub repository from a registry `repository` field, lower-cased; undefined otherwise. */
export function githubRepo(field: unknown): string | undefined {
  const url = typeof field === "string" ? field : (field as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") return undefined;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[/#].*)?$/i.exec(url) ?? /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "unstale-central" }, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return res.json();
    if (res.status === 404) return undefined;
    if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

/**
 * npm siblings: packages of the components' scopes (the registry's public scope listing) whose registry `repository`
 * points at the technology's repository. An unscoped technology has none. A scope is listed only when a component in
 * it is published from the technology's repository: a merged type stub (`@types/ws`, published from DefinitelyTyped)
 * would otherwise list another repository's scope, 11,427 packages for `@types`, read one by one at every advisories
 * stage. A package that cannot be read fails the lookup (the caller then uses the components only, uncached) instead
 * of counting as not a sibling: a rate-limited registry ends the lookup at its first refusal, and an incomplete list
 * is never cached as complete.
 */
async function npmSiblings(t: Technology): Promise<string[]> {
  const repo = t.repo.toLowerCase();
  if (!repo) return [];
  const latest = async (name: string) => (await getJson(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`)) as { repository?: unknown } | undefined;
  const scopes = new Set<string>();
  for (const name of new Set(t.components.map(npmName).filter((n) => n.startsWith("@"))))
    if (githubRepo((await latest(name))?.repository) === repo) scopes.add(name.slice(1).split("/")[0]!);
  const out: string[] = [];
  for (const scope of scopes) {
    const listing = (await getJson(`https://registry.npmjs.org/-/org/${encodeURIComponent(scope)}/package`)) as Record<string, string> | undefined;
    const names = Object.keys(listing ?? {}).filter((n) => n.startsWith(`@${scope}/`)).sort();
    let failure: unknown;
    await pool(names, 8, async (name) => {
      if (failure) return;
      try {
        if (githubRepo((await latest(name))?.repository) === repo) out.push(npmPurl(name));
      } catch (e) {
        failure ??= e;
      }
    });
    if (failure) throw failure;
  }
  return out.sort();
}

/** Above this many packages a maintainer's list is not read (an organisation account publishing thousands). */
const MAINTAINER_LIST_MAX = 1000;

/**
 * npm: the packages of the components' maintainers (`maintainer:<name>` in the registry search) whose registry
 * `repository` is the technology's repository. A monorepo's unscoped packages (react, react-dom,
 * react-server-dom-webpack) have no scope listing but share a maintainer and a repository. Every maintainer's list is
 * read (all pages) except one with more than `MAINTAINER_LIST_MAX`; undefined (unknown) when none could be read or a
 * list ended early.
 */
async function npmRepositoryPackages(t: Technology): Promise<RegistryPackage[] | undefined> {
  const repo = t.repo.toLowerCase();
  if (!repo) return undefined;
  const maintainers = new Set<string>();
  for (const c of t.components) {
    const meta = (await getJson(`https://registry.npmjs.org/${npmName(c).replace("/", "%2f")}/latest`)) as { maintainers?: Array<{ name?: unknown }> } | undefined;
    for (const m of meta?.maintainers ?? []) if (typeof m.name === "string") maintainers.add(m.name);
  }
  type Page = { total?: number; objects?: Array<{ package?: { name?: unknown; description?: unknown; links?: { repository?: unknown } } }> };
  const page = async (m: string, from: number) => (await getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`maintainer:${m}`)}&size=250&from=${from}`)) as Page | undefined;
  const objects: NonNullable<Page["objects"]> = [];
  let read = 0;
  for (const m of [...maintainers].sort()) {
    const first = await page(m, 0);
    const total = first?.total ?? 0;
    if (!first || total === 0 || total > MAINTAINER_LIST_MAX) continue;
    const mine = [...(first.objects ?? [])];
    for (let from = mine.length; from < total; from += 250) {
      const more = (await page(m, from))?.objects ?? [];
      // A list that ends early is not the maintainer's whole list: unknown, not empty.
      if (!more.length) return undefined;
      mine.push(...more);
    }
    objects.push(...mine);
    read++;
  }
  if (!read) return undefined;
  const out = new Map<string, RegistryPackage>();
  for (const o of objects) {
    const p = o.package;
    if (typeof p?.name !== "string" || githubRepo(p.links?.repository) !== repo) continue;
    out.set(p.name, { purl: npmPurl(p.name), name: p.name, description: typeof p.description === "string" ? p.description : "" });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** npm: `dependencies`, `optionalDependencies` and bundled dependencies of the release (`registry.npmjs.org/<name>/<v>`). */
async function npmDependencies(component: string, version: string): Promise<string[] | undefined> {
  const meta = (await getJson(`https://registry.npmjs.org/${npmName(component).replace("/", "%2f")}/${encodeURIComponent(version)}`)) as
    | { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; bundleDependencies?: unknown; bundledDependencies?: unknown }
    | undefined;
  if (!meta) return undefined;
  const bundled = [meta.bundleDependencies, meta.bundledDependencies].flatMap((x) => (Array.isArray(x) ? x.filter((n): n is string => typeof n === "string") : []));
  // An alias (`"x": "npm:@scope/y@^1"`) installs its target, the package OSV names.
  const names = (deps: Record<string, string> = {}) =>
    Object.entries(deps).flatMap(([name, spec]) => [name, ...(typeof spec === "string" && spec.startsWith("npm:") ? [spec.slice(4).replace(/(.)@[^/@]*$/, "$1")] : [])]);
  return [...new Set([...names(meta.dependencies), ...names(meta.optionalDependencies), ...bundled])].map(npmPurl).sort();
}

/** npm: the packument's `time` (`registry.npmjs.org/<name>`; the abbreviated form has no times), `created` and
 * `modified` left out. */
async function npmPublishTimes(component: string): Promise<Record<string, string> | undefined> {
  const doc = (await getJson(`https://registry.npmjs.org/${npmName(component).replace("/", "%2f")}`)) as { time?: Record<string, unknown> } | undefined;
  if (!doc) return undefined;
  return Object.fromEntries(Object.entries(doc.time ?? {}).filter((e): e is [string, string] => e[0] !== "created" && e[0] !== "modified" && typeof e[1] === "string"));
}

/** npm: last week's downloads per version (`api.npmjs.org/versions/<name>/last-week`). */
async function npmVersionDownloads(component: string): Promise<Record<string, number> | undefined> {
  const doc = (await getJson(`https://api.npmjs.org/versions/${encodeURIComponent(npmName(component))}/last-week`)) as { downloads?: Record<string, unknown> } | undefined;
  if (!doc?.downloads) return undefined;
  return Object.fromEntries(Object.entries(doc.downloads).filter((e): e is [string, number] => typeof e[1] === "number"));
}

/** PyPI: per version, the earliest upload among its files (`pypi.org/pypi/<name>/json`); a version with no files has
 * no time. */
async function pypiPublishTimes(component: string): Promise<Record<string, string> | undefined> {
  const name = decodeURIComponent(component.replace(/^pkg:pypi\//, ""));
  const doc = (await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)) as { releases?: Record<string, Array<{ upload_time_iso_8601?: string }>> } | undefined;
  if (!doc) return undefined;
  const out: Record<string, string> = {};
  for (const [v, files] of Object.entries(doc.releases ?? {})) {
    const first = (files ?? []).map((f) => f.upload_time_iso_8601).filter((x): x is string => typeof x === "string" && !Number.isNaN(Date.parse(x))).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    if (first) out[v] = first;
  }
  return out;
}

/** `decodeURIComponent`, undefined for malformed percent-encoding (a link the notes got wrong is not recognised). */
function decoded(x: string): string | undefined {
  try {
    return decodeURIComponent(x);
  } catch {
    return undefined;
  }
}

/** npm: `https://www.npmjs.com/package/<name>` (`@scope/name` or `%40scope%2Fname`), any path after the name. */
function npmRegistryPage(url: string): string | undefined {
  const m = /^https?:\/\/(?:www\.)?npmjs\.com\/package\/((?:@|%40)[^/?#\s]+(?:\/|%2f)[^/?#\s]+|[^@%/?#\s][^/?#\s]*)/i.exec(url.trim());
  const name = m && decoded(m[1]!);
  return name ? npmPurl(name) : undefined;
}

/** PyPI: `https://pypi.org/project/<name>/`. */
function pypiRegistryPage(url: string): string | undefined {
  const m = /^https?:\/\/pypi\.org\/project\/([^/?#\s]+)/i.exec(url.trim());
  const name = m && decoded(m[1]!);
  return name ? pypiPurl(name) : undefined;
}

/** PEP 503 name normalisation, as a package URL (`pkg:pypi/<name>`). */
export const pypiPurl = (name: string): string => `pkg:pypi/${name.toLowerCase().replace(/[-_.]+/g, "-")}`;

/** PyPI: `requires_dist` of the release (`pypi.org/pypi/<name>/<v>/json`), requirements only an extra installs left out. */
async function pypiDependencies(component: string, version: string): Promise<string[] | undefined> {
  const name = decodeURIComponent(component.replace(/^pkg:pypi\//, ""));
  const meta = (await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`)) as { info?: { requires_dist?: string[] | null } } | undefined;
  if (!meta?.info) return undefined;
  const out = new Set<string>();
  for (const req of meta.info.requires_dist ?? []) {
    // Only an extra installs it: a marker that is an `extra ==` condition alone (an `or` can install it by default).
    const marker = req.split(";")[1] ?? "";
    if (/\bextra\s*==/.test(marker) && !/\bor\b/.test(marker)) continue;
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req);
    if (m) out.add(pypiPurl(m[1]!));
  }
  return [...out].sort();
}

export const ECOSYSTEMS: Record<string, Ecosystem> = {
  // npm versions are SemVer.
  npm: {
    osv: "npm",
    compare: semverOrder,
    siblings: npmSiblings,
    dependencies: npmDependencies,
    registryPage: npmRegistryPage,
    publishTimes: npmPublishTimes,
    repositoryPackages: npmRepositoryPackages,
    versionPage: (component, version) => `https://www.npmjs.com/package/${npmName(component)}/v/${encodeURIComponent(version)}`,
    versionDownloads: npmVersionDownloads,
  },
  // PyPI versions are PEP 440. No siblings hook: PyPI has no organisation listing to find a repository's packages.
  pypi: {
    osv: "PyPI",
    compare: pep440Order,
    dependencies: pypiDependencies,
    registryPage: pypiRegistryPage,
    publishTimes: pypiPublishTimes,
    versionPage: (component, version) => `https://pypi.org/project/${decodeURIComponent(component.replace(/^pkg:pypi\//, ""))}/${encodeURIComponent(version)}/`,
  },
};

/** A package URL in one comparable form: PyPI names PEP 503-normalised, npm scopes as `%40`, lower-cased otherwise. */
export function canonicalPurl(purl: string): string {
  const p = purl.replace(/@[^/]*$/, "").replace(/[?#].*$/, "");
  if (/^pkg:pypi\//i.test(p)) return pypiPurl(decodeURIComponent(p.replace(/^pkg:pypi\//i, "")));
  if (/^pkg:npm\//i.test(p)) return npmPurl(decodeURIComponent(p.replace(/^pkg:npm\//i, "")));
  return p.toLowerCase();
}

/** The ecosystem of a package URL's type (`pkg:npm/...` → npm); unknown types get no hooks. */
export function ecosystemOf(purl: string): Ecosystem {
  const type = /^pkg:([a-z0-9.+-]+)\//i.exec(purl)?.[1]?.toLowerCase() ?? "";
  return ECOSYSTEMS[type] ?? { osv: type };
}
