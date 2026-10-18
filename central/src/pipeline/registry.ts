// Prerequisite names checked against the ecosystem's registry ("a
// package name is checked once against the ecosystem's registry (cached); platform names come from each ecosystem's
// spec ... No alias table ... A name that cannot be checked stays as prose and never blocks the record (fails open)").
//
// npm only (the catalog's one ecosystem). Platform names from package.json's `engines` spec (`node`, `npm`) are not
// registry packages and are kept as they are. Every other name gets one GET of registry.npmjs.org/<name> (read only,
// no auth), cached forever per name. A name the registry does not know is not corrected (no alias table): it moves
// from `prerequisites` to `conditions` as prose ("<name> >= <min>"), where it is shown and never blocks.
/** A prerequisite as extracted or as stored (the stored shape allows null bounds). */
type Prereq = { ecosystem: string; name: string; min?: string | null | undefined; max?: string | null | undefined };
import { PACKED_CACHES } from "./packs.ts";
import { centralDir } from "./paths.ts";
import { logUsage, pool, sha256, sleep } from "./util.ts";

/** package.json `engines` names (npm docs, "engines"): platforms, not registry packages. */
export const NPM_PLATFORM_NAMES = new Set(["node", "npm"]);

export type NameStatus = "exists" | "missing" | "platform" | "unchecked";

export interface RegistryCheck {
  name: string;
  status: NameStatus;
  /** HTTP status of the one request (absent for platform names and unchecked ecosystems). */
  http?: number;
  checked?: string;
}

/** The registry cache (packs.ts): `npm/<hash>` here, `<type>/times/<hash>` in fetch.ts. */
export const registryCache = () => PACKED_CACHES.find((c) => c.dir === "cache/registry")!.open(centralDir());
const cacheName = (name: string) => `npm/${sha256(name).slice(0, 32)}`;

export const registryStats = { requests: 0, cached: 0 };

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** One cached GET per distinct npm name: 200 = exists, 404 = missing; anything else retries, then stays unchecked. */
export async function checkNpmName(name: string, fetcher: Fetcher = fetch): Promise<RegistryCheck> {
  if (NPM_PLATFORM_NAMES.has(name)) return { name, status: "platform" };
  // A name with whitespace or over npm's 214-character limit cannot exist; no request needed. (Capitals are asked:
  // legacy packages such as JSONStream have them.)
  if (!/^\S+$/.test(name) || name.length > 214) {
    return { name, status: "missing" };
  }
  const cached = registryCache().get(cacheName(name));
  const hit = cached && (JSON.parse(cached.toString("utf8")) as RegistryCheck);
  if (hit) {
    registryStats.cached++;
    return hit;
  }
  const url = `https://registry.npmjs.org/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let status = 0;
    try {
      // Abbreviated metadata is enough to know the name exists.
      const res = await fetcher(url, { method: "GET", headers: { Accept: "application/vnd.npm.install-v1+json", "User-Agent": "unstale-central" } });
      status = res.status;
      await res.body?.cancel();
    } catch {
      status = 0;
    }
    registryStats.requests++;
    logUsage({ api: "npm-registry", name, status });
    if (status === 200 || status === 404) {
      const r: RegistryCheck = { name, status: status === 200 ? "exists" : "missing", http: status, checked: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
      registryCache().put(cacheName(name), JSON.stringify(r) + "\n");
      return r;
    }
    await sleep(1000 * 2 ** attempt);
  }
  return { name, status: "unchecked" };
}

/** Checks every distinct npm name, at most 4 requests in flight. */
export async function checkNames(names: Iterable<string>, fetcher: Fetcher = fetch): Promise<Map<string, RegistryCheck>> {
  const uniq = [...new Set(names)].sort();
  const res = await pool(uniq, 4, (n) => checkNpmName(n, fetcher));
  return new Map(res.map((r) => [r.name, r]));
}

/** The prose a missing name becomes in `conditions`. */
export const asProse = (p: Prereq): string =>
  [p.name, p.min ? `>= ${p.min}` : "", p.max ? `<= ${p.max}` : ""].filter(Boolean).join(" ");

/**
 * Splits prerequisites by the registry: names that exist, platform names, other ecosystems and names that could not
 * be checked stay; missing names leave `prerequisites` and are returned as prose for `conditions`.
 */
export function applyChecks<P extends Prereq>(prereqs: P[], checks: Map<string, RegistryCheck>): { keep: P[]; prose: string[]; missing: string[] } {
  const keep: P[] = [];
  const prose: string[] = [];
  const missing: string[] = [];
  for (const p of prereqs) {
    if (p.ecosystem === "npm" && checks.get(p.name)?.status === "missing") {
      prose.push(asProse(p));
      missing.push(p.name);
    } else keep.push(p);
  }
  return { keep, prose, missing };
}
