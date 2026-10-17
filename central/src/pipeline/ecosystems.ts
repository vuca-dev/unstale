// What the advisories stage needs from an ecosystem, beyond what any ecosystem port needs anyway (a registry adapter,
// a release index, a lockfile reader at the edge). Both hooks are optional; an ecosystem without them fails open:
//   - compare: the ecosystem's version order, for OSV `ECOSYSTEM` ranges. Without it only the explicit `versions` list
//     OSV gives for such a range is used, and a range with neither is left unresolved (the edge then says nothing);
//   - siblings: other packages published from the technology's repository, from registry metadata only. Without it
//     the technology's components are the only packages queried;
//   - dependencies: the packages a release installs for its users (runtime dependencies, not development or peer
//     ones), from registry metadata. Without it another package's advisory named in the notes is never taken for a
//     dependency update (advisories.ts step 8): the record keeps its labels.
// No hand-written package lists, no per-technology tables (memory rule: ecosystem vocabularies, fail open).
import type { Technology } from "./technologies.ts";
import { pool } from "./util.ts";

export interface Ecosystem {
  /** OSV's name for the ecosystem. */
  osv: string;
  compare?: (a: string, b: string) => number | undefined;
  siblings?: (t: Technology) => Promise<string[]>;
  /** Package URLs a release of `component` installs for its users; undefined when the registry does not list it. */
  dependencies?: (component: string, version: string) => Promise<string[] | undefined>;
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
 * points at the technology's repository. An unscoped technology has none.
 */
async function npmSiblings(t: Technology): Promise<string[]> {
  const repo = t.repo.toLowerCase();
  if (!repo) return [];
  const scopes = new Set(t.components.map(npmName).filter((n) => n.startsWith("@")).map((n) => n.slice(1).split("/")[0]!));
  const out: string[] = [];
  for (const scope of scopes) {
    const listing = (await getJson(`https://registry.npmjs.org/-/org/${encodeURIComponent(scope)}/package`)) as Record<string, string> | undefined;
    const names = Object.keys(listing ?? {}).filter((n) => n.startsWith(`@${scope}/`)).sort();
    await pool(names, 8, async (name) => {
      const meta = (await getJson(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`).catch(() => undefined)) as { repository?: unknown } | undefined;
      if (githubRepo(meta?.repository) === repo) out.push(npmPurl(name));
    });
  }
  return out.sort();
}

/** npm: `dependencies`, `optionalDependencies` and bundled dependencies of the release (`registry.npmjs.org/<name>/<v>`). */
async function npmDependencies(component: string, version: string): Promise<string[] | undefined> {
  const meta = (await getJson(`https://registry.npmjs.org/${npmName(component).replace("/", "%2f")}/${encodeURIComponent(version)}`)) as
    | { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; bundleDependencies?: unknown; bundledDependencies?: unknown }
    | undefined;
  if (!meta) return undefined;
  const bundled = [meta.bundleDependencies, meta.bundledDependencies].flatMap((x) => (Array.isArray(x) ? x.filter((n): n is string => typeof n === "string") : []));
  return [...new Set([...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {}), ...bundled])].map(npmPurl).sort();
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
    if (/;.*\bextra\s*==/.test(req)) continue;
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req);
    if (m) out.add(pypiPurl(m[1]!));
  }
  return [...out].sort();
}

export const ECOSYSTEMS: Record<string, Ecosystem> = {
  // npm versions are SemVer.
  npm: { osv: "npm", compare: semverOrder, siblings: npmSiblings, dependencies: npmDependencies },
  // PyPI versions are PEP 440. No siblings hook: PyPI has no organisation listing to find a repository's packages.
  pypi: { osv: "PyPI", compare: pep440Order, dependencies: pypiDependencies },
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
