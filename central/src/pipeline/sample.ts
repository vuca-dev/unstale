// The term-rarity sample. When a technology is added, a fixed rule (SampleRule: candidate pool, major, n) picks public
// repositories that declare its package, no hand-picking. They are shallow-cloned into the central store once, and
// every term is counted against the same commits by the edge's own matching rule (`unstale count-terms`), so new terms
// are counted later without redrawing. Everything the selection read from GitHub is cached under `sample/<tech>/gh/`.
// Rules compared in eval/rarity-sample-2/RESULTS.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { centralDir, REPO_ROOT } from "./paths.ts";
import type { TechStore } from "./store.ts";
import type { Technology } from "./technologies.ts";
import { compareVersions, readJson, sha256, sleep, writeAtomic } from "./util.ts";
import { githubToken } from "../docs/fetcher.ts";

export const SAMPLE_SIZE = 5;
/** Search returns at most 1,000 results (10 pages of 100). */
const MAX_PAGES = 10;
/** Shallow-clone cost bound: repositories above this GitHub `size` (KB) are not cloned. */
export const MAX_SIZE_KB = 200_000;
/** Adoption pool: a repository needs at least this many stars and a push within PUSHED_WITHIN_DAYS of the draw. */
export const MIN_STARS = 50;
export const PUSHED_WITHIN_DAYS = 365;
/** Adoption pool: package.json files read per repository (shallowest first). */
const MAX_MANIFESTS = 6;

/**
 * Repositories used in evaluation never enter a sample: the end-to-end repositories of ~/ati-slice0 (e2e/repos.json
 * and the remotes of replay/full/*) and the expanded replay's events (eval/replay/events/EVENTS.md). Their forks and
 * the repositories they were forked from are excluded by the parent/source check below.
 */
export const EVALUATION_REPOS = [
  "Snouzy/workout-cool",
  "invoicerr-app/invoicerr",
  "krayin/laravel-crm",
  "7nohe/openapi-react-query-codegen",
  "JakubPluta/gymhero",
  "thechangelog/changelog.com",
  "chmonitor/chmonitor",
  "navikt/aksel",
  "jhb-software/payload-plugins",
  "cohstats/coh2stats",
  "sigle/sigle",
  "cedarjs/cedar",
  "arthurfiorette/prisma-json-types-generator",
  "omar-dulaimi/prisma-zod-generator",
  "hmake98/nestjs-temporal-core",
  "xballoy/coros-api",
  "satisfactory-factories/application",
  "EUDIPLO/eudiplo",
];

/** Name, description or topic words that mark teaching or scaffolding repositories rather than projects. */
export const NOT_A_PROJECT =
  /\b(tutorials?|courses?|examples?|demos?|boilerplates?|starters?|templates?|learn|learning|workshops?|samples?|playgrounds?|clones?|practice|exercises?|homework|bootcamp|scaffold)\b/i;
/** Directories whose package.json is not a project's own manifest (adoption pool). */
export const NOT_A_MANIFEST_DIR = /(^|\/)(node_modules|fixtures?|__fixtures__|__tests__|tests?|e2e|vendor|dist|build|\.next)(\/|$)/i;

/**
 * Where candidates come from, which majors they declare, and how many are taken.
 * - pool `code-search`: GitHub code search for the first package name in package.json files, ranked by stars.
 * - pool `adoption`: GitHub repository search on the technology's own topic (ecosystem vocabulary), at least
 *   MIN_STARS stars and pushed within PUSHED_WITHIN_DAYS, ranked by stars.
 * - major `current` (the catalog's highest line), `previous` (current − 1: projects that have not upgraded, the
 *   population the upgrade review serves), `mix` (⌈n/2⌉ previous, the rest current).
 */
export type SamplePool = "code-search" | "adoption";
export type SampleMajor = "current" | "previous" | "mix";
export interface SampleRule {
  pool: SamplePool;
  major: SampleMajor;
  n: number;
}
export const DEFAULT_RULE: SampleRule = { pool: "code-search", major: "current", n: SAMPLE_SIZE };

export interface SampleRepo {
  repo: string;
  commit: string;
  stars: number;
  /** The package.json that qualified it and the range it declares. */
  manifest: string;
  declares: string;
}

export interface SampleFile {
  technology: string;
  rule: string;
  /** The rule's parameters (absent in samples drawn before rules were parameterised: code-search, current, 5). */
  selection?: SampleRule;
  query: string;
  /** The catalog's current major when drawn. */
  major: string;
  /** The majors the sample was drawn at. */
  majors?: string[];
  drawn: string;
  candidates: number;
  /** Why each higher-ranked candidate was passed over, in rank order (for audit). */
  passed_over: Array<{ repo: string; stars: number; why: string }>;
  repos: SampleRepo[];
  /** Raw term → number of sample repositories containing it. */
  counts: Record<string, number>;
}

const COMMON =
  "drop forks, archived and template repositories, repositories whose name, description or topics mark a tutorial, " +
  "course, example, demo, starter, boilerplate or clone, the technology's own organisation, evaluation repositories " +
  `and their forks or upstreams, and repositories over ${MAX_SIZE_KB / 1000} MB; one repository per owner; rank by stars ` +
  "(then name)";

/** The rule in words, as recorded in the sample file. */
export function ruleText(r: SampleRule): string {
  const pool =
    r.pool === "code-search"
      ? `GitHub code search for the technology's first package name quoted in package.json files (pages 1-${MAX_PAGES}); keep ` +
        "files named exactly package.json that declare one of the technology's packages in dependencies or devDependencies"
      : `GitHub repository search for the technology's own topic (its repository's GitHub topic equal to its repository or ` +
        `package name; the most used if several) with at least ${MIN_STARS} stars, pushed within ${PUSHED_WITHIN_DAYS} days ` +
        `of the draw (pages 1-${MAX_PAGES}); keep repositories with a package.json (shallowest ${MAX_MANIFESTS}, none under ` +
        "node_modules, fixtures, tests, vendor or build output) declaring one of the technology's packages in dependencies or devDependencies";
  const major =
    r.major === "current"
      ? "at the catalog's current major"
      : r.major === "previous"
        ? "at the major before the catalog's current one"
        : `at the previous major for the first ${Math.ceil(r.n / 2)} and the current major for the rest`;
  return `${pool} ${major}; ${COMMON}; take the first ${r.n}.`;
}
/** The first sample's rule (code-search, current major, 5), kept for reference. */
export const RULE = ruleText(DEFAULT_RULE);

const dir = (tech: string) => join(centralDir(), "sample", tech);
const filePath = (tech: string) => join(dir(tech), "sample.json");
export const cloneDir = (tech: string, repo: string) => join(dir(tech), "repos", repo.replace("/", "__"));

export const loadSample = (tech: string): SampleFile | undefined => readJson<SampleFile>(filePath(tech));
export const saveSample = (s: SampleFile): void => writeAtomic(filePath(s.technology), JSON.stringify(s, null, 1) + "\n");

export const npmName = (purl: string): string => decodeURIComponent(purl.replace(/^pkg:npm\//, ""));

/** The major a range or version declares (`^16.1.0`, `~7.0`, `16`, `>=12.0.0 <13`), or undefined (`latest`, `*`, workspace). */
export function declaredMajor(range: unknown): string | undefined {
  if (typeof range !== "string") return undefined;
  const m = /^\s*(?:npm:[^@]+@)?[\^~>=v ]*(\d+)(?:\.|\s|$|x)/.exec(range);
  return m ? m[1] : undefined;
}

/** The current major: the highest release line the technology's records list for its first component. */
export function currentMajor(store: TechStore, t: Technology): string | undefined {
  const lines = Object.values(store.records).flatMap((r) => r.releases.filter((x) => x.component === t.components[0]).map((x) => x.line));
  return lines.sort(compareVersions).at(-1);
}

/** The majors a rule samples, given the current one, in draw order with how many each takes. */
export function majorsFor(rule: SampleRule, current: string): Array<{ major: string; take: number }> {
  const previous = String(Number(current) - 1);
  if (rule.major === "current" || Number(current) < 1) return [{ major: current, take: rule.n }];
  if (rule.major === "previous") return [{ major: previous, take: rule.n }];
  const first = Math.ceil(rule.n / 2);
  return [
    { major: previous, take: first },
    { major: current, take: rule.n - first },
  ];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Topics of the technology's repository that name it: equal to its repository name or a package name without scope. */
export function namingTopics(topics: string[], t: Technology): string[] {
  const names = new Set([norm(t.repo.split("/")[1]!), ...t.components.map((c) => norm(npmName(c).replace(/^@[^/]+\//, "")))]);
  return topics.filter((x) => names.has(norm(x))).sort();
}

/** A repository's own package.json files from its tree, shallowest first (adoption pool). */
export function manifestPaths(tree: Array<{ path: string; type: string }>): string[] {
  return tree
    .filter((e) => e.type === "blob" && /(^|\/)package\.json$/.test(e.path))
    .map((e) => e.path)
    .filter((p) => !NOT_A_MANIFEST_DIR.test(p) && !NOT_A_PROJECT.test(words(p)))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, MAX_MANIFESTS);
}

// ---- GitHub reads, cached ----

// Code search allows 10 requests a minute: one search at a time, 7 s apart, across technologies.
let sampleToken: string | undefined;
let searchChain: Promise<unknown> = Promise.resolve();
let lastSearch = 0;
function ghCached<T>(tech: string, path: string, opts: { search?: boolean } = {}): Promise<T | undefined> {
  const p = join(dir(tech), "gh", sha256(path).slice(0, 2), `${sha256(path)}.json`);
  const hit = readJson<{ path: string; body: T | null }>(p);
  if (hit) return Promise.resolve(hit.body ?? undefined);
  // GITHUB_TOKEN, else `gh auth token`; status 0 is a network error or timeout.
  const gh = async (): Promise<{ status: number; text: string }> => {
    const token = (sampleToken ??= githubToken() ?? "");
    try {
      const res = await fetch(`https://api.github.com/${path}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "unstale-central", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(60_000),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { status: 0, text: String(e) };
    }
  };
  const run = async (): Promise<T | undefined> => {
    let r = await gh();
    for (let attempt = 0; attempt < 4 && (r.status === 0 || r.status === 403 || r.status === 429 || r.status >= 500); attempt++) {
      await sleep(65_000);
      r = await gh();
    }
    if (r.status !== 200) {
      // 404/409/451 (gone, empty, blocked) are cached as absent; anything else fails the run.
      if ([404, 409, 451].includes(r.status)) {
        writeAtomic(p, JSON.stringify({ path, body: null }) + "\n");
        return undefined;
      }
      throw new Error(`GitHub ${path}: ${r.status} ${r.text.trim().slice(0, 200)}`);
    }
    const body = JSON.parse(r.text) as T;
    writeAtomic(p, JSON.stringify({ path, body }) + "\n");
    return body;
  };
  if (!opts.search) return run();
  const next = searchChain.then(async () => {
    const wait = lastSearch + 7000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastSearch = Date.now();
    return run();
  });
  searchChain = next.catch(() => undefined);
  return next;
}

interface SearchItem {
  path: string;
  url: string;
  repository: { full_name: string; fork: boolean; description: string | null; owner: { login: string } };
}
interface RepoMeta {
  full_name: string;
  fork: boolean;
  archived: boolean;
  is_template?: boolean;
  stargazers_count: number;
  size: number;
  description: string | null;
  topics?: string[];
  default_branch: string;
  parent?: { full_name: string };
  source?: { full_name: string };
}

const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ");

/** Why a repository is passed over, from its metadata alone, or undefined. */
export function excluded(m: RepoMeta, t: Technology): string | undefined {
  const evalSet = new Set(EVALUATION_REPOS.map((x) => x.toLowerCase()));
  const name = m.full_name.toLowerCase();
  if (evalSet.has(name)) return "evaluation repository";
  for (const up of [m.parent?.full_name, m.source?.full_name]) if (up && evalSet.has(up.toLowerCase())) return "fork of an evaluation repository";
  if (m.fork) return "fork";
  if (m.archived) return "archived";
  if (m.is_template) return "template repository";
  if (name.split("/")[0] === t.repo.split("/")[0]!.toLowerCase()) return "the technology's own organisation";
  const text = [words(m.full_name.split("/")[1]!), m.description ?? "", ...(m.topics ?? []).map(words)].join(" ");
  const w = NOT_A_PROJECT.exec(text);
  if (w) return `not a project ("${w[0]}")`;
  if (m.size > MAX_SIZE_KB) return `over ${MAX_SIZE_KB / 1000} MB`;
  return undefined;
}

/** Which of the technology's packages a package.json declares at `major`, as `name@range`, or undefined. */
export function declaresAtMajor(pkg: unknown, names: string[], major: string): string | undefined {
  if (!pkg || typeof pkg !== "object") return undefined;
  const p = pkg as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = p[field];
    if (!deps || typeof deps !== "object") continue;
    for (const n of names) {
      const range = (deps as Record<string, unknown>)[n];
      if (declaredMajor(range) === major) return `${n}@${String(range)}`;
    }
  }
  return undefined;
}

/** A candidate repository: its metadata and the package.json paths to read (resolved from its tree when undefined). */
interface Candidate {
  meta: RepoMeta;
  manifests?: string[];
}
interface Pool {
  query: string;
  candidates: Candidate[];
}
const byStars = (a: Candidate, b: Candidate) => b.meta.stargazers_count - a.meta.stargazers_count || a.meta.full_name.localeCompare(b.meta.full_name);

async function codeSearchPool(t: Technology, names: string[], log: (s: string) => void): Promise<Pool> {
  const query = `"${names[0]}" filename:package.json extension:json`;
  const items: SearchItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ghCached<{ items: SearchItem[] }>(t.id, `search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`, { search: true });
    const got = res?.items ?? [];
    items.push(...got);
    if (got.length < 100) break;
  }
  // Files named exactly package.json; one entry per repository and path, in search order.
  const seen = new Set<string>();
  const files = items.filter((i) => /(^|\/)package\.json$/.test(i.path) && !seen.has(`${i.repository.full_name}\0${i.path}`) && seen.add(`${i.repository.full_name}\0${i.path}`));
  const byRepo = new Map<string, string[]>();
  for (const f of files) byRepo.set(f.repository.full_name, [...(byRepo.get(f.repository.full_name) ?? []), f.path]);
  log(`${t.id}: sample: ${items.length} search results, ${files.length} package.json files in ${byRepo.size} repositories`);
  // Metadata of every candidate repository (stars, fork, archived, template, topics, size, upstream).
  const candidates: Candidate[] = [];
  const repos = [...byRepo.keys()];
  for (let i = 0; i < repos.length; i += 6) {
    const got = await Promise.all(repos.slice(i, i + 6).map((r) => ghCached<RepoMeta>(t.id, `repos/${r}`)));
    for (const m of got) if (m) candidates.push({ meta: m, manifests: byRepo.get(m.full_name) ?? [] });
  }
  return { query, candidates: candidates.sort(byStars) };
}

/** The technology's own topic: of its repository's topics that name it, the one on most repositories. */
async function adoptionTopic(t: Technology): Promise<string | undefined> {
  const own = await ghCached<RepoMeta>(t.id, `repos/${t.repo}`);
  let best: { topic: string; total: number } | undefined;
  for (const topic of namingTopics(own?.topics ?? [], t)) {
    const r = await ghCached<{ total_count: number }>(t.id, `search/repositories?q=${encodeURIComponent(`topic:${topic}`)}&per_page=1`, { search: true });
    const total = r?.total_count ?? 0;
    if (!best || total > best.total) best = { topic, total };
  }
  return best?.topic;
}

async function adoptionPool(t: Technology, drawn: Date, log: (s: string) => void): Promise<Pool> {
  const topic = await adoptionTopic(t);
  if (!topic) return { query: "", candidates: [] };
  const since = new Date(drawn.getTime() - PUSHED_WITHIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const query = `topic:${topic} stars:>=${MIN_STARS} pushed:>=${since} archived:false`;
  const candidates: Candidate[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ghCached<{ items: RepoMeta[] }>(t.id, `search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100&page=${page}`, { search: true });
    const got = res?.items ?? [];
    candidates.push(...got.map((meta) => ({ meta })));
    if (got.length < 100) break;
  }
  log(`${t.id}: sample: ${candidates.length} repositories for ${query}`);
  return { query, candidates: candidates.sort(byStars) };
}

/** The ranked repositories of a pool that declare the technology at `major`, up to `take`, cloned. */
async function rankAt(
  t: Technology,
  pool: Pool,
  names: string[],
  major: string,
  take: number,
  owners: Set<string>,
  log: (s: string) => void,
): Promise<{ chosen: SampleRepo[]; passed_over: SampleFile["passed_over"] }> {
  const chosen: SampleRepo[] = [];
  const passed_over: SampleFile["passed_over"] = [];
  for (const { meta: m, manifests } of pool.candidates) {
    if (chosen.length >= take) break;
    const owner = m.full_name.split("/")[0]!.toLowerCase();
    let why = excluded(m, t) ?? (owners.has(owner) ? "a second repository of one owner" : undefined);
    let manifest: string | undefined;
    let declares: string | undefined;
    if (!why) {
      let paths = manifests;
      if (!paths) {
        const tree = await ghCached<{ tree: Array<{ path: string; type: string }> }>(t.id, `repos/${m.full_name}/git/trees/${encodeURIComponent(m.default_branch)}?recursive=1`);
        paths = manifestPaths(tree?.tree ?? []);
      }
      for (const path of paths) {
        const c = await ghCached<{ content?: string; encoding?: string }>(t.id, `repos/${m.full_name}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(m.default_branch)}`);
        let pkg: unknown;
        try {
          pkg = c?.content ? JSON.parse(Buffer.from(c.content, "base64").toString("utf8")) : undefined;
        } catch {
          pkg = undefined;
        }
        declares = declaresAtMajor(pkg, names, major);
        if (declares) {
          manifest = path;
          break;
        }
      }
      if (!declares) why = `no package.json declaring ${names.join(" or ")} at major ${major}`;
    }
    if (why) {
      passed_over.push({ repo: m.full_name, stars: m.stargazers_count, why });
      continue;
    }
    const commit = cloneAt(t.id, m.full_name);
    owners.add(owner);
    chosen.push({ repo: m.full_name, commit, stars: m.stargazers_count, manifest: manifest!, declares: declares! });
    log(`${t.id}: sample: ${m.full_name} (${m.stargazers_count} stars, ${declares}) at ${commit.slice(0, 12)}`);
  }
  return { chosen, passed_over };
}

/** Draws a sample by a rule without saving it (the evaluation compares rules with this). */
export async function buildSample(t: Technology, store: TechStore, rule: SampleRule = DEFAULT_RULE, log: (s: string) => void = console.log, drawn = new Date()): Promise<SampleFile | undefined> {
  const major = currentMajor(store, t);
  if (!major) return undefined;
  const names = t.components.map(npmName);
  const pool = rule.pool === "adoption" ? await adoptionPool(t, drawn, log) : await codeSearchPool(t, names, log);
  const owners = new Set<string>();
  const repos: SampleRepo[] = [];
  const passed_over: SampleFile["passed_over"] = [];
  const parts = majorsFor(rule, major);
  for (const p of parts) {
    const r = await rankAt(t, pool, names, p.major, p.take, owners, log);
    repos.push(...r.chosen);
    passed_over.push(...r.passed_over.map((x) => (parts.length > 1 ? { ...x, why: `${x.why} (drawing major ${p.major})` } : x)));
  }
  return {
    technology: t.id,
    rule: ruleText(rule),
    selection: rule,
    query: pool.query,
    major,
    majors: parts.map((p) => p.major),
    drawn: drawn.toISOString().replace(/\.\d+Z$/, "Z"),
    candidates: pool.candidates.length,
    passed_over,
    repos,
    counts: {},
  };
}

/** Draws the sample for a technology (once; an existing sample.json is returned as it is). */
export async function drawSample(t: Technology, store: TechStore, log: (s: string) => void = console.log, rule: SampleRule = DEFAULT_RULE): Promise<SampleFile | undefined> {
  const prev = loadSample(t.id);
  if (prev) return prev;
  const s = await buildSample(t, store, rule, log);
  if (s) saveSample(s);
  return s;
}

/** Shallow clone of the default branch (first draw), or of the recorded commit (clone missing later). */
export function cloneAt(tech: string, repo: string, commit?: string): string {
  const d = cloneDir(tech, repo);
  const git = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (existsSync(join(d, ".git"))) {
    const head = git("rev-parse", "HEAD");
    if (!commit || head === commit) return head;
    rmSync(d, { recursive: true, force: true });
  }
  mkdirSync(d, { recursive: true });
  const url = `https://github.com/${repo}.git`;
  if (!commit) {
    execFileSync("git", ["clone", "-q", "--depth", "1", "--single-branch", "--no-tags", url, d], { stdio: ["ignore", "ignore", "pipe"] });
  } else {
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", url, commit);
    git("-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD");
  }
  return git("rev-parse", "HEAD");
}

// ---- Counting ----

/** The edge's binary (`unstale count-terms`): `UNSTALE_BIN`, else the workspace's release build. */
const unstaleBin = (): string => process.env.UNSTALE_BIN ?? join(REPO_ROOT, "local", "target", "release", "unstale");

export type Counter = (repoDirs: string[], terms: string[]) => Record<string, number>;

export const edgeCounter: Counter = (repoDirs, terms) => {
  const out = execFileSync(unstaleBin(), ["count-terms", ...repoDirs.flatMap((d) => ["--repo", d])], {
    input: JSON.stringify(terms),
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return JSON.parse(out) as Record<string, number>;
};

/**
 * Counts for every given term: from the sample file, and terms not yet counted are counted against the sample's
 * recorded commits (re-cloned at that commit if the clone is gone) and saved. Returns undefined without a sample.
 */
export function sampleCounts(tech: string, terms: Iterable<string>, counter: Counter = edgeCounter): { n: number; repos: SampleRepo[]; counts: Record<string, number> } | undefined {
  const s = loadSample(tech);
  if (!s || !s.repos.length) return undefined;
  const missing = [...new Set(terms)].filter((t) => !Object.hasOwn(s.counts, t)).sort();
  if (missing.length) {
    const dirs = s.repos.map((r) => {
      cloneAt(tech, r.repo, r.commit);
      return cloneDir(tech, r.repo);
    });
    const got = counter(dirs, missing);
    for (const t of missing) s.counts[t] = Math.min(Object.hasOwn(got, t) ? got[t]! : 0, s.repos.length);
    s.counts = Object.fromEntries(Object.keys(s.counts).sort().map((k) => [k, s.counts[k]!]));
    saveSample(s);
  }
  return { n: s.repos.length, repos: s.repos, counts: s.counts };
}
