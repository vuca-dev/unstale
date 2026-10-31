// Security advisories from OSV (osv.dev: GHSA, PyPA, RustSec, Go vulndb, ...), attached to the records that describe
// their fix. Release notes name some advisories and omit others, and date backports inconsistently; the advisory
// database states, per package, which versions are affected and which version first has the fix. That is what the edge
// needs to say which advisories a bump fixes, so each security record carries its advisories' ids and affected
// versions.
//
// Steps, per technology:
//   1. packages: the technology's components, plus siblings from the same repository through the ecosystem's hook
//      (ecosystems.ts; npm: same scope and the registry `repository` is the technology's repository). No hook: the
//      components only;
//   2. advisories: `POST api.osv.dev/v1/query {package: {purl}}` (all pages, no token), cached under the central
//      store; withdrawn ones are dropped; the GHSA id is the advisory id where there is one, other ids are aliases;
//   3. resolve: each affected range is resolved against the technology's release index (SEMVER ranges by SemVer,
//      ECOSYSTEM ranges by the ecosystem's order when it has one, explicit version lists as given; otherwise
//      unresolved). The record carries the index and, per range, the index versions it affects, so the edge compares
//      version strings and never parses ranges;
//   4. in the window: an advisory whose fixed version, on some release line, is a release the index holds;
//   5. attach by id: a release-notes evidence whose source line names the advisory id, in the release that first
//      has the fix on that line, links the record (deterministic);
//   6. the rest are judged like any other source at ingest (match.ts: Jev same-or-new against the records released
//      in the patched version, cross-kind threshold, advisory and breaking guards); no match makes a new record from
//      the advisory (the release notes omitted it). A fix whose release notes are not read yet (`unread`: the
//      token-free first pass at registration, or history still being read) is not judged: the advisory gets a record
//      of its own at once (basis `early`), judged once every fix's notes are read and merged into the record that
//      describes it (or kept, `advisory-settled`). A record made from the advisory alone whose notes later name the
//      advisory by id merges into that record. One advisory, one record;
//   7. every linked record gets the advisory (id, aliases, ranges, resolved versions) and a release on each line the
//      fix shipped on in the window (a backport the notes left out);
//   8. another package's advisory: a security-labelled record built only from release-notes items that name advisory
//      ids, none of them this technology's, each attributed by OSV (`GET api.osv.dev/v1/vulns/<id>` and its aliases,
//      cached) only to other packages, each item worded as a dependency update (bump, upgrade, chore, deps, ... or the
//      other package's name), where the release does not ship the fix to its users (none of those packages, and no
//      package the item names, is among the runtime dependencies the registry lists for the release: ecosystems.ts
//      `dependencies`; nothing bundled or vendored), is not a security fix a bump brings: `change_type` other,
//      `benefit` none (history `foreign-advisory`, the labels it had kept there). Recomputed every run with no model
//      call: a record that stops qualifying gets its labels back. An id OSV does not know or attributes to no package,
//      and an ecosystem without the dependencies hook, keep the record as it is.
//   9. another package's release: a record whose labels say the bump brings it (security, fix, performance,
//      behaviour or default change, or benefit security; not breaking) built only from release-notes items, whose subject is a package the
//      notes list on a line of its own as a link to its registry page (ecosystems.ts `registryPage`; lodash 4.18.0's
//      "`lodash.*` modular packages": `- [lodash.omit](https://www.npmjs.com/package/lodash.omit)`), not one of the
//      technology's packages (step 1) and not among the runtime dependencies the release installs, describes a change
//      users of that package get, not users of this technology: `change_type` other, `benefit` none (history
//      `other-package`, the labels it had kept there). Recomputed every run with no model call, restored like step 8.
//      Unknown (a body not stored, no dependency data, an ecosystem without the hooks) keeps the record as it is.
//  10. backport twins: records of one upstream change (every item cites a common pull request or commit) with
//      near-identical quotes on different release lines merge into one (backports.ts).
//  11. another package's section: a record whose every item sits under a release-notes heading naming other packages
//      of the repository (not this technology's) has its releases name those packages (section-packages.ts), so the
//      edge applies it only where one of them is used.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Classification, Questions } from "./classify/adapter.ts";
import type { Labels } from "./classify/labels.ts";
import { attachAdvisoryApis, packageNamesOf } from "./advisory-apis.ts";
import { mergeBackports } from "./backports.ts";
import { canonicalPurl, cargoName, cargoPurl, ecosystemOf, npmName as npmNameOf, npmPurl, pypiPurl, semverOrder, type RegistryPackage } from "./ecosystems.ts";
import type { Incoming } from "./extract.ts";
import { buildIndex, lineFn, recomputeReleases } from "./lines.ts";
import { advisoryIds, create, evidenceOf, K, kindOf, matchRequest, nearIdenticalQuote, pick, retrieve } from "./match.ts";
import { centralDir } from "./paths.ts";
import { attributeSections, repositoryPackages } from "./section-packages.ts";
import { applyChange, combineReleases, mergeInto, union, type StoredRecord, type TechStore } from "./store.ts";
import type { Technology } from "./technologies.ts";
import { canonical, oneLine, readJson, releaseLine, sha256, writeAtomic } from "./util.ts";
import { techLocal } from "../state/client.ts";

const FRESH_MS = 12 * 3600 * 1000;
const OSV = "https://api.osv.dev/v1/query";
const OSV_VULN = "https://api.osv.dev/v1/vulns/";

/** Network calls made by this module in this process (OSV pages, registry reads). */
export const advisoryStats = { osvRequests: 0, registryLists: 0 };

/** One affected range of an advisory for one package, as the database states it, plus how to resolve it. */
export interface AffectedRange {
  /** Package URL, canonical `%40scope` form. */
  component: string;
  /** For people and older edges: `>= 16.0.0, < 16.2.5`; empty for a list- or commit-only range. */
  range: string;
  patched?: string;
  /** OSV range type: SEMVER, ECOSYSTEM, GIT, or LIST (an explicit version list with no range). */
  type: string;
  introduced?: string;
  fixed?: string;
  lastAffected?: string;
  /** Versions the database lists as affected for this package entry. */
  listed: string[];
}

export interface Advisory {
  /** `GHSA-xxxx-xxxx-xxxx` where there is one, else the database's id. */
  id: string;
  /** CVE ids and other databases' ids. */
  aliases: string[];
  severity?: string;
  url: string;
  summary: string;
  /** The database's details text (the reference's descriptions). */
  details?: string;
  published: string;
  affected: AffectedRange[];
}

export const purl = npmPurl;
export const npmName = npmNameOf;

const dir = (t: Technology) => join(centralDir(), "advisories", techLocal(t.id));
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const safe = (purl: string) => purl.replace(/^pkg:/, "").replace(/%40/g, "").replace(/[^A-Za-z0-9._-]+/g, "__");

/**
 * The technology's packages (package URLs): its components plus its ecosystem's siblings from the same repository.
 * Cached; offline uses the cache; a failed sibling lookup falls back to the components.
 */
export async function techPackages(t: Technology, opts: { refresh?: boolean; offline?: boolean } = {}): Promise<string[]> {
  return (await packageList(t, opts)).purls;
}

/** `techPackages`, and whether the list is complete (false: siblings unread, offline with no cache or a failed lookup). */
async function packageList(t: Technology, opts: { refresh?: boolean; offline?: boolean }): Promise<{ purls: string[]; complete: boolean }> {
  const p = join(dir(t), "packages.json");
  const cached = readJson<{ checked: string; purls?: string[] }>(p);
  const fresh = cached?.purls && Date.now() - Date.parse(cached.checked) < FRESH_MS;
  if (cached?.purls && (opts.offline || (fresh && !opts.refresh))) return { purls: cached.purls, complete: true };
  const out = new Set(t.components);
  const hooked = t.components.some((c) => ecosystemOf(c).siblings);
  if (opts.offline) return { purls: [...out].sort(), complete: !hooked };
  for (const eco of new Set(t.components.map(ecosystemOf))) {
    if (!eco.siblings) continue;
    try {
      advisoryStats.registryLists++;
      for (const x of await eco.siblings(t)) out.add(x);
    } catch (e) {
      console.error(`advisories: ${t.id}: sibling packages unavailable (${e instanceof Error ? e.message : e}); components only`);
      return { purls: [...out].sort(), complete: false };
    }
  }
  const purls = [...out].sort();
  writeAtomic(p, JSON.stringify({ checked: stamp(), purls }, null, 1) + "\n");
  return { purls, complete: true };
}

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}
export interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  published?: string;
  withdrawn?: string;
  database_specific?: { severity?: string; github_reviewed?: boolean };
  affected?: Array<{
    package?: { ecosystem?: string; name?: string; purl?: string };
    ranges?: Array<{ type: string; events: OsvEvent[] }>;
    versions?: string[];
  }>;
}

async function osvQuery(purl: string): Promise<OsvVuln[]> {
  const out: OsvVuln[] = [];
  let token: string | undefined;
  do {
    let body: { vulns?: OsvVuln[]; next_page_token?: string } | undefined;
    for (let attempt = 0; ; attempt++) {
      advisoryStats.osvRequests++;
      const res = await fetch(OSV, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "unstale-central" },
        body: JSON.stringify({ package: { purl }, ...(token ? { page_token: token } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        body = (await res.json()) as typeof body;
        break;
      }
      if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`OSV ${purl}: ${res.status}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
    out.push(...(body?.vulns ?? []));
    token = body?.next_page_token || undefined;
  } while (token);
  return out;
}

/** The package URL of an OSV `affected` entry, canonical (`%40scope`), without version or qualifiers. */
function entryPurl(a: NonNullable<OsvVuln["affected"]>[number]): string | undefined {
  const pkg = a.package;
  const name = pkg?.name;
  if (pkg?.purl !== undefined) {
    if (pkg.ecosystem === "crates.io" || /^pkg:cargo\//i.test(pkg.purl)) {
      try {
        const crate = cargoName(pkg.purl);
        return crate ? cargoPurl(crate) : undefined;
      } catch {
        return undefined;
      }
    }
    return pkg.purl.replace(/@[^/]*$/, "").replace(/[?#].*$/, "").replace(/^pkg:npm\/@/, "pkg:npm/%40");
  }
  if (pkg?.ecosystem === "crates.io") {
    if (typeof name !== "string") return undefined;
    try {
      return cargoPurl(name);
    } catch {
      return undefined;
    }
  }
  const p = name && pkg?.ecosystem === "npm" ? npmPurl(name) : name && pkg?.ecosystem === "PyPI" ? pypiPurl(name) : undefined;
  return p?.replace(/@[^/]*$/, "").replace(/[?#].*$/, "").replace(/^pkg:npm\/@/, "pkg:npm/%40");
}

const SEVERITY: Record<string, string> = { LOW: "low", MODERATE: "medium", MEDIUM: "medium", HIGH: "high", CRITICAL: "critical" };

/** One OSV vulnerability as an Advisory, keeping only our packages' entries. */
export function fromOsv(v: OsvVuln, ours: ReadonlySet<string>): Advisory | undefined {
  if (v.withdrawn || v.database_specific?.github_reviewed === false) return undefined;
  const ids = [v.id, ...(v.aliases ?? [])].map((x) => x.toUpperCase());
  const id = ids.find((x) => x.startsWith("GHSA-")) ?? v.id.toUpperCase();
  const affected: AffectedRange[] = [];
  for (const a of v.affected ?? []) {
    const component = entryPurl(a);
    if (!component || !ours.has(component)) continue;
    const listed = a.versions ?? [];
    const ranges = a.ranges ?? [];
    for (const r of ranges) {
      // Events in order: each `introduced` opens an interval that the next fixed / last_affected closes.
      let open: string | undefined;
      const close = (end: { fixed?: string; lastAffected?: string }) => {
        if (open === undefined) return;
        const semverish = r.type === "SEMVER" || r.type === "ECOSYSTEM";
        const parts = semverish
          ? [open !== "0" ? `>= ${open}` : "", end.fixed ? `< ${end.fixed}` : "", end.lastAffected ? `<= ${end.lastAffected}` : ""].filter(Boolean)
          : [];
        affected.push({
          component,
          range: semverish ? (parts.join(", ") || ">= 0.0.0") : "",
          ...(semverish && end.fixed ? { patched: end.fixed } : {}),
          type: r.type,
          introduced: open,
          ...(end.fixed ? { fixed: end.fixed } : {}),
          ...(end.lastAffected ? { lastAffected: end.lastAffected } : {}),
          listed,
        });
        open = undefined;
      };
      for (const e of r.events) {
        if (e.introduced !== undefined) {
          close({});
          open = e.introduced;
        } else if (e.fixed !== undefined) close({ fixed: e.fixed });
        else if (e.last_affected !== undefined) close({ lastAffected: e.last_affected });
      }
      close({});
    }
    if (!ranges.length && listed.length) affected.push({ component, range: "", type: "LIST", listed });
  }
  if (!affected.length) return undefined;
  const sev = v.database_specific?.severity?.toUpperCase();
  return {
    id,
    aliases: [...new Set(ids.filter((x) => x !== id))].sort(),
    ...(sev && SEVERITY[sev] ? { severity: SEVERITY[sev] } : {}),
    url: id.startsWith("GHSA-") ? `https://github.com/advisories/${id}` : `https://osv.dev/vulnerability/${v.id}`,
    summary: oneLine(v.summary ?? v.details?.split("\n")[0] ?? "", 400),
    ...(v.details ? { details: v.details } : {}),
    published: (v.published ?? "").slice(0, 10),
    affected,
  };
}

/** Advisories affecting any of the technology's packages (OSV), withdrawn ones dropped, sorted by id. */
export async function fetchAdvisories(t: Technology, opts: { refresh?: boolean; offline?: boolean } = {}): Promise<Advisory[]> {
  const packages = await techPackages(t, opts);
  const raw = new Map<string, OsvVuln>();
  for (const p of packages) {
    const file = join(dir(t), "osv", `${safe(p)}.json`);
    let cached = readJson<{ checked: string; vulns: OsvVuln[] }>(file);
    const fresh = cached && Date.now() - Date.parse(cached.checked) < FRESH_MS;
    if (!cached || (!opts.offline && (!fresh || opts.refresh))) {
      if (opts.offline) continue;
      const vulns = (await osvQuery(p)).sort((a, b) => a.id.localeCompare(b.id));
      cached = { checked: stamp(), vulns };
      writeAtomic(file, JSON.stringify(cached, null, 1) + "\n");
    }
    for (const v of cached.vulns) raw.set(v.id, v);
  }
  const ours = new Set(packages);
  const byId = new Map<string, Advisory>();
  for (const v of raw.values()) {
    const a = fromOsv(v, ours);
    if (!a) continue;
    // One advisory under two database ids (a GHSA and its PYSEC alias): the record whose own id is the advisory id
    // states the ranges; the other adds only packages it does not cover (two databases' ranges are never unioned).
    const prev = byId.get(a.id);
    if (!prev) byId.set(a.id, a);
    else {
      const [main, other] = v.id.toUpperCase() === a.id ? [a, prev] : [prev, a];
      const have = new Set(main.affected.map((x) => x.component));
      main.affected.push(...other.affected.filter((x) => !have.has(x.component)));
      byId.set(a.id, main);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The details text of every cached OSV entry of the technology's packages, by the entry's upper-cased id: one advisory
 * under two database ids (a GHSA and the CVE record OSV converted) can describe it in different words, and only one
 * of them may name the affected API (advisory-apis.ts). Reads the cache `fetchAdvisories` wrote; no request.
 */
export async function osvTexts(t: Technology): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const p of await techPackages(t, { offline: true })) {
    for (const v of readJson<{ vulns: OsvVuln[] }>(join(dir(t), "osv", `${safe(p)}.json`))?.vulns ?? []) {
      const id = v.id.toUpperCase();
      const have = out.get(id) ?? [];
      const text = v.details?.trim();
      out.set(id, text && !have.includes(text) ? [...have, text] : have);
    }
  }
  return out;
}

/**
 * The details text of OSV entry `id` (`GET /v1/vulns/<id>`, cached under the technology without expiry: an alias's
 * description seldom changes, and `refresh` reads it again); undefined when OSV does not know it or offline with no
 * cache. advisory-apis.ts reads an advisory's aliases this way when the package query returned only its GHSA entry.
 */
export async function aliasDetails(t: Technology, id: string, opts: { refresh?: boolean; offline?: boolean } = {}): Promise<string | undefined> {
  const file = join(dir(t), "alias-details", `${id.toUpperCase().replace(/[^A-Z0-9._-]+/g, "_")}.json`);
  const cached = readJson<{ checked: string; details: string | null }>(file);
  if (cached && (opts.offline || !opts.refresh)) return cached.details ?? undefined;
  if (opts.offline) return undefined;
  const v = await osvVuln(id).catch((e) => { console.error(`advisory alias ${id}: ${e instanceof Error ? e.message : e}`); return undefined; });
  if (v === undefined) return undefined;
  const details = v?.withdrawn ? null : (v?.details?.trim() || null);
  writeAtomic(file, JSON.stringify({ checked: stamp(), details }, null, 1) + "\n");
  return details ?? undefined;
}

/** One OSV vulnerability by id (`GET /v1/vulns/<id>`, retried like the queries); null when OSV does not know it. */
async function osvVuln(id: string): Promise<OsvVuln | null> {
  for (let attempt = 0; ; attempt++) {
    advisoryStats.osvRequests++;
    const res = await fetch(OSV_VULN + encodeURIComponent(id), { headers: { "User-Agent": "unstale-central" }, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as OsvVuln;
    if (res.status === 404) return null;
    if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`OSV ${id}: ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

/** What the attribution check keeps of a vulnerability: its ids, whether it was withdrawn, its packages. */
const attribution = (v: OsvVuln): OsvVuln => ({
  id: v.id,
  ...(v.aliases?.length ? { aliases: v.aliases } : {}),
  ...(v.withdrawn ? { withdrawn: v.withdrawn } : {}),
  affected: (v.affected ?? []).map((a) => ({ ...(a.package ? { package: a.package } : {}) })),
});

/**
 * The packages (canonical package URLs) OSV attributes an advisory id to: the `affected` packages of the id's own entry
 * and of its aliases' entries (a CVE entry names no package; its GHSA alias does), withdrawn entries left out. Undefined
 * when OSV does not know the id or names no package for it. Each entry is cached under the technology's advisories
 * like the queries (12 h; offline uses the cache). A failed request, or an id not cached when offline, throws.
 */
export async function advisoryPackages(t: Technology, id: string, opts: { refresh?: boolean; offline?: boolean } = {}): Promise<Set<string> | undefined> {
  const entry = async (x: string): Promise<OsvVuln | null | undefined> => {
    const file = join(dir(t), "vulns", `${x.toUpperCase().replace(/[^A-Z0-9._-]+/g, "_")}.json`);
    const cached = readJson<{ checked: string; vuln: OsvVuln | null }>(file);
    const fresh = cached && Date.now() - Date.parse(cached.checked) < FRESH_MS;
    if (cached && (opts.offline || (fresh && !opts.refresh))) return cached.vuln;
    if (opts.offline) throw new Error(`${x} not cached (offline)`);
    const v = await osvVuln(x);
    const vuln = v && attribution(v);
    writeAtomic(file, JSON.stringify({ checked: stamp(), vuln }, null, 1) + "\n");
    return vuln;
  };
  const own = await entry(id);
  if (!own) return undefined;
  const out = new Set<string>();
  const seen = new Set([own.id.toUpperCase(), id.toUpperCase()]);
  for (const v of [own, ...(await Promise.all((own.aliases ?? []).filter((x) => !seen.has(x.toUpperCase())).map(entry)))]) {
    if (!v || v.withdrawn) continue;
    for (const a of v.affected ?? []) {
      const p = entryPurl(a);
      if (p) out.add(p);
    }
  }
  return out.size ? out : undefined;
}

/**
 * The packages (canonical package URLs) a release of a component installs for its users (ecosystems.ts
 * `dependencies`), cached under the technology's advisories with no expiry (a published release does not change).
 * Null when the registry has no such release (the package was not published at that version: it installs nothing);
 * undefined when the ecosystem has no hook (unknown); throws when the registry cannot be read or, offline, when nothing
 * is cached.
 */
export async function releaseDependencies(t: Technology, component: string, version: string, opts: { offline?: boolean } = {}): Promise<string[] | null | undefined> {
  const hook = ecosystemOf(component).dependencies;
  if (!hook) return undefined;
  const file = join(dir(t), "dependencies", `${safe(component)}@${version.replace(/[^A-Za-z0-9._+-]+/g, "_")}.json`);
  const cached = readJson<{ checked: string; dependencies: string[] | null }>(file);
  if (cached) return cached.dependencies;
  if (opts.offline) throw new Error(`${component}@${version} dependencies not cached (offline)`);
  advisoryStats.registryLists++;
  const deps = await hook(component, version);
  const dependencies = deps ? [...new Set(deps.map(canonicalPurl))].sort() : null;
  writeAtomic(file, JSON.stringify({ checked: stamp(), dependencies }, null, 1) + "\n");
  return dependencies;
}

// ---- Resolving ranges against the release index ----

/**
 * The index versions an affected range covers, or undefined when it cannot be resolved: SEMVER ranges by SemVer,
 * ECOSYSTEM ranges by the ecosystem's order when it has one; the database's explicit list always counts; a version
 * the order cannot read leaves the range unresolved (never a guess).
 */
export function resolveRange(r: AffectedRange, index: readonly string[]): string[] | undefined {
  const cmp = r.type === "SEMVER" ? semverOrder : r.type === "ECOSYSTEM" ? ecosystemOf(r.component).compare : undefined;
  const listed = new Set(r.listed);
  if (!cmp) return r.listed.length ? index.filter((v) => listed.has(v)) : undefined;
  const out: string[] = [];
  for (const v of index) {
    if (listed.has(v)) {
      out.push(v);
      continue;
    }
    const lo = r.introduced === undefined || r.introduced === "0" ? 1 : cmp(v, r.introduced);
    const hi = r.fixed !== undefined ? cmp(v, r.fixed) : r.lastAffected !== undefined ? cmp(v, r.lastAffected) : -1;
    if (lo === undefined || hi === undefined) return undefined;
    if (lo >= 0 && (r.fixed !== undefined ? hi < 0 : hi <= 0)) out.push(v);
  }
  return out;
}

/** Whether `version` of `component` is affected, from the ranges resolved against `index` (undefined: unknown). */
export function affectsResolved(a: Pick<Advisory, "affected">, component: string, version: string, index: readonly string[]): boolean | undefined {
  if (!index.includes(version)) return undefined;
  let hit = false;
  for (const r of a.affected.filter((x) => x.component === component)) {
    const vs = resolveRange(r, index);
    if (!vs) return undefined;
    if (vs.includes(version)) hit = true;
  }
  return hit;
}

// ---- Range strings (`>= 1.2.0, < 1.3.0`), for npm's reference checks and older edges ----

/** SemVer precedence; unreadable versions compare as text (callers that must not guess use `semverOrder`). */
export const semverCmp = (a: string, b: string): number => semverOrder(a, b) ?? a.localeCompare(b);

/** Whether `version` satisfies a range string. An unparseable comparator never matches. */
export function inRange(version: string, range: string): boolean {
  const parts = range.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((c) => {
    const m = /^(>=|<=|>|<|=)?\s*(\S+)$/.exec(c);
    const d = m ? semverOrder(version, m[2]!) : undefined;
    if (d === undefined) return false;
    switch (m![1] ?? "=") {
      case ">=": return d >= 0;
      case ">": return d > 0;
      case "<=": return d <= 0;
      case "<": return d < 0;
      default: return d === 0;
    }
  });
}

/** Whether `version` of `component` is in one of the advisory's range strings (npm reference). */
export const affects = (a: Pick<Advisory, "affected">, component: string, version: string): boolean =>
  a.affected.some((r) => r.component === component && inRange(version, r.range));

/**
 * The advisory's fixes inside the window: one per release line, at a release the index holds (exact version
 * string), the earliest such release on the line. `lineOf` is the technology's line function (lines.ts: the derived
 * line); the old rule (major, or 0.minor) when not given.
 */
export function fixesInWindow(
  a: Pick<Advisory, "affected">,
  releases: ReadonlyArray<{ version: string; date: string }>,
  lineOf: (version: string) => string = releaseLine,
): Array<{ line: string; version: string; date: string }> {
  const pos = new Map(releases.map((r, i) => [r.version, i]));
  const out = new Map<string, { line: string; version: string; date: string; i: number }>();
  for (const r of a.affected) {
    const i = r.patched !== undefined ? pos.get(r.patched) : undefined;
    if (i === undefined) continue;
    const rel = releases[i]!;
    const line = lineOf(rel.version);
    const prev = out.get(line);
    if (!prev || rel.date < prev.date || (rel.date === prev.date && i < prev.i)) out.set(line, { line, version: rel.version, date: rel.date, i });
  }
  return [...out.values()].sort((x, y) => x.date.localeCompare(y.date) || x.i - y.i).map(({ line, version, date }) => ({ line, version, date }));
}

// ---- Attaching advisories to records ----

/** The published form on a record: id, aliases, severity, URL, the ranges, the index and the versions they affect. */
export type RecordAdvisory = NonNullable<StoredRecord["advisories"]>[number];

/** The record form, resolved against the technology's release index (ascending, as central holds it). */
export function toRecordAdvisory(a: Advisory, index: readonly string[]): RecordAdvisory {
  return {
    id: a.id,
    aliases: a.aliases,
    ...(a.severity ? { severity: a.severity } : {}),
    summary: a.summary,
    url: a.url,
    affected: a.affected.map((r) => {
      const versions = resolveRange(r, index);
      return { component: r.component, range: r.range, ...(r.patched ? { patched: r.patched } : {}), ...(versions ? { versions } : {}) };
    }),
    index: [...index],
  };
}

export const isSecurity = (r: Pick<StoredRecord, "change_type" | "benefit">): boolean => r.change_type === "security" || r.benefit.includes("security");

/** Advisory ids a record names: its evidence quotes and summary, and the advisories already attached. */
export function recordAdvisoryIds(r: StoredRecord): Set<string> {
  const ids = advisoryIds(`${r.evidence.map((e) => e.quote).join(" ")} ${r.summary}`);
  for (const a of r.advisories ?? []) {
    ids.add(a.id);
    for (const c of a.aliases) ids.add(c.toUpperCase());
  }
  return ids;
}

/** Normalised text for locating a quote in a release body: link targets, advisory ids and markup removed. */
const flat = (s: string) =>
  s
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\bGHSA(?:-[a-z0-9]{4}){3}\b|\bCVE-\d{4}-\d{4,}\b/gi, " ")
    .replace(/[`*_\\[\]]/g, "")
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, "")
    .replace(/^[\s:;,.-]+/, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

/**
 * The list item of a release body that a quote was taken from, as written (links and ids kept). The quote is located
 * at the best-matching item, not at every item containing it: each window of up to 4 lines that contains the quote is
 * scored by coverage (quote length / the window's text length, links and ids stripped); the best gives the item. No
 * window, or a tie for best between windows naming different advisory ids, gives none.
 */
export function itemAtQuote(body: string, quote: string): string | undefined {
  const lines = body.split("\n");
  const q = flat(quote);
  if (q.length < 8) return undefined;
  let best: { cov: number; raw: string; ids: Set<string> } | undefined;
  let tie = false;
  for (let len = 1; len <= 4; len++) {
    for (let i = 0; i + len <= lines.length; i++) {
      const raw = lines.slice(i, i + len).join(" ");
      const text = flat(raw);
      if (!text.includes(q)) continue;
      const cov = q.length / text.length;
      if (!best || cov > best.cov + 1e-9) {
        best = { cov, raw, ids: advisoryIds(raw) };
        tie = false;
      } else if (Math.abs(cov - best.cov) <= 1e-9) {
        const ids = advisoryIds(raw);
        if (ids.size !== best.ids.size || [...ids].some((x) => !best!.ids.has(x))) tie = true;
      }
    }
  }
  return best && !tie ? best.raw : undefined;
}

/**
 * Advisory ids on the list item of a release body that a quote was taken from (a Markdown list item names its
 * advisory in its link), located by `itemAtQuote`; none when the item cannot be located (the advisory is then judged).
 * Release notes that re-list an earlier advisory next to its follow-up ("... - Incomplete Fix Follow-Up") thus give
 * the earlier one's quote the earlier one's id only.
 */
export function idsAtQuote(body: string, quote: string): Set<string> {
  const item = itemAtQuote(body, quote);
  return item === undefined ? new Set() : advisoryIds(item);
}

// A record made from an advisory: a security fix, not breaking, no classifier (nothing was asked of one).
const ADVISORY_LABELS = {
  change_type: "security",
  surface: "runtime_internal",
  breaking: false,
  benefit: ["security"],
} as const satisfies Omit<Labels, "classifier">;

/** The incoming form of an advisory fixed on one line, for the same-or-new judge and for a new record. */
export function advisoryIncoming(t: Technology, a: Advisory, fix: { line: string; version: string; date: string }): Incoming {
  const summary = a.summary.split(/\s+/).slice(0, 40).join(" ");
  return {
    key: `${t.id}@${fix.version}+advisory.${a.id}`,
    kind: "advisory",
    technology: t.id,
    version: fix.version,
    date: fix.date,
    line: releaseLine(fix.version),
    url: a.url,
    snapshot: `sha256:${sha256(canonical(a))}`,
    subject: a.summary,
    subject_kind: "concept",
    summary,
    introduces: [],
    quote: `${a.id}${a.aliases.length ? ` (${a.aliases.join(", ")})` : ""}: ${a.summary}`,
    grounded: true,
    terms: [],
    replaces: [],
    requires: [],
    prerequisites: [],
    conditions: [],
  } as unknown as Incoming;
}

/** The history wording of a record made from an advisory before the release notes of its fix were read. */
export const EARLY = "from the advisory, before its release notes were read";
/** History action: an early record whose fix's notes were read and none describes it; it stays, as a created one. */
const SETTLED = "advisory-settled";

/**
 * How a record came to hold an advisory, from its history: the first `advisory` entry naming it decides. `early`: made
 * from the advisory while the release notes of its fix were not read yet (the token-free first pass, or history still
 * being read); it is judged against those notes once they are read, and becomes `created` when none describes it.
 */
export type Basis = "id" | "judged" | "created" | "early" | "unknown";
export function basisOf(r: StoredRecord, id: string): Basis {
  let early = false;
  for (const h of r.history) {
    if (early) {
      if (h.action === SETTLED && h.detail?.startsWith(`${id}:`)) return "created";
      continue;
    }
    if (h.action === "advisory-match" && h.detail?.toUpperCase().includes(`+ADVISORY.${id}`)) return "judged";
    if (h.action !== "advisory" || !h.detail?.startsWith(`${id} (`)) continue;
    const how = h.detail.slice(id.length + 2, -1);
    if (how === "named in the release notes") return "id";
    if (how === "judged") return "judged";
    if (how === "from the advisory") return "created";
    if (how === EARLY) early = true;
  }
  return early ? "early" : "unknown";
}

/** A record whose only evidence is advisories: one made from an advisory that no release-notes item joined. */
const advisoryOnly = (r: StoredRecord): boolean => r.evidence.length > 0 && r.evidence.every((e) => e.kind === "advisory");

export interface AttachReport {
  advisories: number;
  /** Advisories whose text names an affected API, and records made from an advisory alone given them as terms
   * (advisory-apis.ts); absent when the stage made no model call. */
  apis?: { named: number; records: number };
  inWindow: number;
  byId: number;
  judged: number;
  created: number;
  /** Of `created`: made before the release notes of the fix were read (judged against them once they are). */
  early: number;
  /** Records made from an advisory merged into the release-notes record that describes it: named there by id, or
   * judged the same once the notes were read. One advisory, one record. */
  standIns: Array<{ advisory: string; from: string; into: string }>;
  /** Early records whose fix's notes were read and none describes them: kept as records of their own. */
  settled: number;
  releasesAdded: number;
  recordsChanged: number;
  /** Id-based attachments whose basis no longer holds (the id is not at the record's quote any more): removed. */
  removed: Array<{ advisory: string; record: string }>;
  /** Twins merged (one advisory on several records with near-identical quotes, each released only in its fixes). */
  twinsMerged: Array<{ advisory: string; from: string; into: string }>;
  /** Advisories still on more than one record after the twin merge, reported (not guessed). */
  multiHolder: Array<{ advisory: string; records: string[] }>;
  /** Records relabelled from security to a dependency update: the ids they name are other packages' (step 8). */
  foreign: Array<{ record: string; ids: string[] }>;
  /** Records given their labels back: they no longer qualify as another package's advisory. */
  foreignRestored: string[];
  /** Records relabelled as another package's release: the subject is a package the notes list, not this one (step 9). */
  otherPackage: Array<{ record: string; package: string }>;
  /** Records given their labels back: they no longer qualify as another package's release. */
  otherPackageRestored: string[];
  /** Backport twins merged (step 10): the same upstream change extracted once per release line. */
  backportsMerged: Array<{ from: string; into: string; refs: string[] }>;
  /** Records whose releases now name the packages their release-notes heading names (step 11). */
  sectionMoved: Array<{ record: string; packages: string[]; heading: string }>;
  /** Records given this technology's components back (step 11). */
  sectionRestored: string[];
}

/**
 * What step 8 needs: the technology's packages, the packages OSV attributes an id to, and the packages a release of a
 * component installs for its users.
 */
export interface ForeignCheck {
  packages: readonly string[];
  /** Package URLs OSV attributes the id to; undefined when OSV does not know it. Throws when OSV cannot be read. */
  lookup: (id: string) => Promise<Set<string> | undefined>;
  /**
   * Package URLs the release installs for its users; null when the package has no such release (it installs nothing);
   * undefined when unknown (no hook). Throws when it cannot be read.
   */
  dependencies: (component: string, version: string) => Promise<string[] | null | undefined>;
}

/**
 * Attaches the technology's in-window advisories to its records (steps 4–6 above), then keeps one advisory on one
 * record (twin merge, below). Id-based attachments are recomputed on every run, deterministically and with no model
 * call: an advisory attached because the release notes named it at the record's quote, whose id is no longer found
 * there, is removed (history `advisory-removed`) and, if no other record holds it, judged like a new one (once: the
 * judge's request is cached by hash). Judged attachments and records made from an advisory are kept as they are
 * (sticky) while their record is active. Idempotent: a rerun changes nothing and asks nothing.
 */
export async function attachAdvisories(
  t: Technology,
  s: TechStore,
  advisories: Advisory[],
  releases: ReadonlyArray<{ version: string; date: string; url: string }>,
  judge: (state: Record<string, unknown>, questions: Questions) => Promise<Classification>,
  foreign?: ForeignCheck,
  sections?: { packages: readonly RegistryPackage[]; dependencies: ForeignCheck["dependencies"] },
  unread: ReadonlySet<string> = new Set(),
): Promise<AttachReport> {
  const report: AttachReport = {
    advisories: advisories.length,
    inWindow: 0,
    byId: 0,
    judged: 0,
    created: 0,
    early: 0,
    standIns: [],
    settled: 0,
    releasesAdded: 0,
    recordsChanged: 0,
    removed: [],
    twinsMerged: [],
    multiHolder: [],
    foreign: [],
    foreignRestored: [],
    otherPackage: [],
    otherPackageRestored: [],
    backportsMerged: [],
    sectionMoved: [],
    sectionRestored: [],
  };
  const changed = new Set<string>();
  const lineOf = lineFn(s);
  // One release index: the store's (lines.ts, published in the tech index) when it has one. Each advisory carries a
  // copy as `index` for edges that do not read the tech index's `releases` yet.
  const indexVersions = s.releaseIndex ? s.releaseIndex.releases.map((x) => x.version) : releases.map((x) => x.version);
  const byUrl = new Map(releases.map((r) => [r.url, r]));
  const body = (version: string): string | undefined => {
    const p = join(centralDir(), "releases", techLocal(t.id), `${version}.md`);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  };
  // Ids named on the source lines of each record's release-notes evidence, with the release they came from.
  const named = new Map<string, Array<{ id: string; version: string }>>();
  for (const r of Object.values(s.records)) {
    if (r.status !== "active") continue;
    for (const e of r.evidence) {
      if ((e.kind ?? "release_notes") !== "release_notes") continue;
      const rel = byUrl.get(e.url);
      const b = rel && body(rel.version);
      if (!rel || !b) continue;
      const ids = union([...advisoryIds(e.quote)], [...idsAtQuote(b, e.quote)]);
      for (const id of ids) named.set(r.id, [...(named.get(r.id) ?? []), { id, version: rel.version }]);
    }
  }
  // Versions a detached advisory added as releases, per record: dropped unless something else supports them.
  const dropped = new Map<string, Set<string>>();
  const link = (r: StoredRecord, a: Advisory, fixes: Array<{ line: string; version: string; date: string }>, how: string) => {
    const adv = (r.advisories ?? []).filter((x) => x.id !== a.id);
    const next = [...adv, toRecordAdvisory(a, indexVersions)].sort((x, y) => x.id.localeCompare(y.id));
    const comps = r.releases.length ? [...new Set(r.releases.map((x) => x.component))] : t.components;
    const rels = combineReleases(r.releases, comps.flatMap((component) => fixes.map((f) => ({ component, version: f.version, date: f.date, line: releaseLine(f.version) }))), lineOf);
    const before = r.releases.length;
    const ev = r.evidence.some((e) => e.kind === "advisory" && e.url === a.url) ? r.evidence : [...r.evidence, evidenceOf(advisoryIncoming(t, a, fixes[0]!))];
    const benefit = r.benefit.includes("security") ? r.benefit : union(r.benefit.filter((b) => b !== "none"), ["security" as const]);
    const res = applyChange(r, { advisories: next, releases: rels, benefit }, "advisory");
    if (res.revision || res.label) r.history.at(-1)!.detail = `${a.id} (${how})`;
    r.evidence = ev;
    if (res.revision || res.label) changed.add(r.id);
    report.releasesAdded += Math.max(0, rels.length - before);
  };
  const unlink = (r: StoredRecord, a: Advisory, fixes: Array<{ version: string }>) => {
    const next = (r.advisories ?? []).filter((x) => x.id !== a.id);
    applyChange(r, { advisories: next }, "advisory-removed", { detail: `${a.id}: no longer named at the record's quote in the release notes` });
    r.evidence = r.evidence.filter((e) => !(e.kind === "advisory" && e.url === a.url));
    const d = dropped.get(r.id) ?? new Set<string>();
    for (const f of fixes) d.add(f.version);
    for (const x of (r.advisories ?? []).flatMap((x) => x.affected)) if (x.patched) d.delete(x.patched);
    dropped.set(r.id, d);
    changed.add(r.id);
    report.removed.push({ advisory: a.id, record: r.id });
  };

  const active = () => Object.values(s.records).filter((r) => r.status === "active");
  // Step 5's judgement: against the records released in a patched version, one request per fixed line, never `except`
  // nor a record made from another advisory.
  // A fixed version whose notes are not read yet has nothing to be judged against: no request (the token-free first
  // pass makes no model call).
  const judgeFix = async (a: Advisory, fixes: Array<{ line: string; version: string; date: string }>, except?: StoredRecord): Promise<StoredRecord | undefined> => {
    for (const fix of fixes) {
      if (unread.has(fix.version)) continue;
      const inc = advisoryIncoming(t, a, fix);
      // A record made from another advisory is never the same change (the advisory guard refuses disjoint ids): not asked.
      const pool = active().filter((r) => r !== except && !advisoryOnly(r) && r.releases.some((x) => x.version === fix.version));
      const scored = retrieve(inc, pool).map((c) => s.records[c.id]!);
      const rest = pool.filter((r) => !scored.includes(r)).sort((x, y) => Number(isSecurity(y)) - Number(isSecurity(x)) || x.id.localeCompare(y.id));
      const cands = [...scored, ...rest].slice(0, K);
      if (!cands.length) continue;
      report.judged++;
      const req = matchRequest(t.name, inc, false, cands);
      const verdict = await judge(req.state, req.questions);
      const chosen = pick(cands, verdict.answers, { breaking: false, quote: inc.quote, summary: inc.summary, kind: kindOf(inc) }, verdict.calibrated !== false);
      if (chosen.id) {
        const m = s.records[chosen.id]!;
        m.history.push({ action: "advisory-match", detail: `${inc.key} p=${chosen.p}`, revision: m.revision, label_version: m.label_version, judged: chosen.judged });
        return m;
      }
    }
    return undefined;
  };

  for (const a of advisories) {
    const fixes = fixesInWindow(a, releases, lineOf);
    if (!fixes.length) continue;
    report.inWindow++;
    const aliases = new Set([a.id, ...a.aliases.map((x) => x.toUpperCase())]);
    // Named by id at the record's quote in a release that first has the fix on its line (recomputed every run:
    // deterministic). A release the database does not list as fixed can mention an advisory without fixing it ("this
    // preserves the fix for CVE-..."), so it counts only for a twin of a holder (findTwins).
    const fixVersions = new Set(fixes.map((f) => f.version));
    const direct = active().filter((r) => (named.get(r.id) ?? []).some((n) => aliases.has(n.id) && fixVersions.has(n.version)));
    const holders = active().filter((r) => (r.advisories ?? []).some((x) => x.id === a.id));
    const sticky: StoredRecord[] = [];
    for (const r of holders) {
      if (direct.includes(r)) continue;
      if (basisOf(r, a.id) === "id") unlink(r, a, fixes);
      else sticky.push(r);
    }
    // A record made from the advisory alone stands in for the notes' own description of the fix: merged into it.
    const standIn = (r: StoredRecord, into: StoredRecord, why: string) => {
      mergeInto(s, r.id, into.id, why);
      report.standIns.push({ advisory: a.id, from: r.id, into: into.id });
      changed.add(r.id);
      changed.add(into.id);
    };
    if (direct.length) {
      if (direct.some((r) => !holders.includes(r))) report.byId++;
      for (const r of direct) link(r, a, fixes, holders.includes(r) ? "attached" : "named in the release notes");
      for (const r of sticky) {
        const basis = basisOf(r, a.id);
        if ((basis === "created" || basis === "early") && advisoryOnly(r)) standIn(r, direct[0]!, `the release notes name ${a.id}`);
        else link(r, a, fixes, "attached");
      }
      continue;
    }
    // Made before the notes of its fix were read: judged against them once every fix's notes are read (the judgement
    // the stage would have made had it run after the history), then merged or kept as a record of its own.
    const allRead = !fixes.some((f) => unread.has(f.version));
    let matched: StoredRecord | undefined;
    for (const r of sticky.filter((x) => basisOf(x, a.id) === "early")) {
      if (!allRead) continue;
      const m = advisoryOnly(r) ? await judgeFix(a, fixes, r) : undefined;
      if (m) {
        link(m, a, fixes, "judged");
        standIn(r, m, `judged the same change as ${a.id} in the release notes`);
        sticky.splice(sticky.indexOf(r), 1);
        matched = m;
      } else {
        r.history.push({ action: SETTLED, detail: `${a.id}: no record of its fix's release notes describes it`, revision: r.revision, label_version: r.label_version });
        report.settled++;
      }
    }
    // Judged or made from the advisory before: kept (refreshed), nothing to judge.
    if (sticky.length || matched) {
      for (const r of sticky) link(r, a, fixes, "attached");
      continue;
    }
    // Step 5: judged against the records released in a patched version, one request per fixed line.
    matched = await judgeFix(a, fixes);
    if (matched) {
      link(matched, a, fixes, "judged");
      continue;
    }
    // Step 5, no match: the release notes omitted the advisory (or are not read yet); a record of its own.
    const inc = advisoryIncoming(t, a, fixes[0]!);
    if (s.ingested[inc.key]) {
      // Made before and merged or retracted since: the record it went into (if active) holds it.
      const into = s.records[s.ingested[inc.key]!];
      if (into?.status === "active") link(into, a, fixes, "attached");
      continue;
    }
    const r = create(s, inc, { ...ADVISORY_LABELS, benefit: ["security"] } as unknown as Labels, t.components);
    delete r.classifier;
    s.ingested[inc.key] = r.id;
    report.created++;
    if (!allRead) report.early++;
    link(r, a, fixes, allRead ? "from the advisory" : EARLY);
    changed.add(r.id);
  }

  // One advisory, one record: twins (the same item of the notes extracted once per release line, before the
  // technology lock existed) merge deterministically; anything else is reported.
  const fixVersionsOf = new Map(advisories.map((a) => [a.id, new Set(fixesInWindow(a, releases, lineOf).map((f) => f.version))]));
  for (;;) {
    const twins = findTwins(s, fixVersionsOf, named);
    if (!twins) break;
    const [into, ...rest] = twins.records;
    for (const from of rest) {
      named.set(into!, [...(named.get(into!) ?? []), ...(named.get(from) ?? [])]);
      mergeInto(s, from, into!, `twin of ${into} (${twins.advisory} on both; near-identical release-notes quotes, released only in its fixes)`);
      report.twinsMerged.push({ advisory: twins.advisory, from, into: into! });
      changed.add(into!);
      changed.add(from);
    }
  }
  report.multiHolder = multiHolders(s).map(([advisory, records]) => ({ advisory, records }));

  // Step 8: another package's advisory named in the notes is a dependency update, not a security fix of this one.
  if (foreign) {
    const r = await relabelForeign(s, advisories, releases, body, foreign);
    report.foreign = r.foreign;
    report.foreignRestored = r.restored;
    for (const x of r.foreign) changed.add(x.record);
    for (const x of r.restored) changed.add(x);
  }

  // Step 9: a record about another package the notes list (its own release, published from this repository or not) is
  // not a change this technology's users get with the bump.
  if (foreign) {
    const r = await relabelOtherPackage(s, releases, body, foreign);
    report.otherPackage = r.relabelled;
    report.otherPackageRestored = r.restored;
    for (const x of r.relabelled) changed.add(x.record);
    for (const x of r.restored) changed.add(x);
  }

  // Step 10: one upstream change on several release lines is one record.
  report.backportsMerged = mergeBackports(s, releases, body);
  for (const m of report.backportsMerged) {
    changed.add(m.into);
    changed.add(m.from);
  }

  // Step 11: an item under a heading naming other packages of the repository is their change.
  if (sections) {
    const dependencies = memo(sections.dependencies);
    const r = await attributeSections(t, s, releases, body, sections.packages, (x) => shippedPackages(s, x, new Set(t.components.map(canonicalPurl)), dependencies));
    report.sectionMoved = r.moved;
    report.sectionRestored = r.restored;
    for (const x of r.moved) changed.add(x.record);
    for (const x of r.restored) changed.add(x);
  }

  // Releases recomputed from sources and attached advisories (lines.ts), dropping what a detached advisory added.
  for (const r of Object.values(s.records)) {
    if (r.status !== "active") continue;
    const rels = recomputeReleases(r, s, t.components, dropped.get(r.id));
    if (JSON.stringify(rels) === JSON.stringify(r.releases)) continue;
    applyChange(r, { releases: rels }, "releases", { detail: "recomputed per release line" });
    changed.add(r.id);
  }
  report.recordsChanged = changed.size;
  return report;
}

/** Advisories held by more than one active record, with the records (sorted). */
export function multiHolders(s: TechStore): Array<[string, string[]]> {
  const by = new Map<string, string[]>();
  for (const r of Object.values(s.records)) {
    if (r.status !== "active") continue;
    for (const a of r.advisories ?? []) by.set(a.id, [...(by.get(a.id) ?? []), r.id]);
  }
  return [...by].filter(([, ids]) => ids.length > 1).map(([a, ids]) => [a, ids.sort(naturalId)] as [string, string[]]).sort((x, y) => x[0].localeCompare(y[0]));
}

const naturalId = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/**
 * The first group of twins: the records holding an advisory, plus records whose notes name it at their quote (any
 * release of the window) with a quote near-identical to a holder's, when there are at least two, their release-notes
 * quotes are pairwise near-identical (`nearIdenticalQuote`, either direction), and their releases are all fix releases
 * of the advisory or releases whose notes name it at the record's quote (`named`). The first id (natural order) is
 * the one kept.
 */
export function findTwins(
  s: TechStore,
  fixVersionsOf: ReadonlyMap<string, ReadonlySet<string>>,
  named: ReadonlyMap<string, ReadonlyArray<{ id: string; version: string }>> = new Map(),
): { advisory: string; records: string[] } | undefined {
  const active = Object.values(s.records).filter((r) => r.status === "active").sort((a, b) => naturalId(a.id, b.id));
  const rnQuotes = (r: StoredRecord) => r.evidence.filter((e) => (e.kind ?? "release_notes") === "release_notes").map((e) => e.quote);
  const near = (a: string[], b: string[]) => a.some((x) => b.some((y) => nearIdenticalQuote(x, y) || nearIdenticalQuote(y, x)));
  for (const [advisory, fixes] of [...fixVersionsOf].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!fixes.size) continue;
    const holders = active.filter((r) => (r.advisories ?? []).some((a) => a.id === advisory));
    if (!holders.length) continue;
    const ids = new Set([advisory, ...holders.flatMap((r) => (r.advisories ?? []).filter((a) => a.id === advisory).flatMap((a) => a.aliases.map((x) => x.toUpperCase())))]);
    const namedAt = (r: StoredRecord) => (named.get(r.id) ?? []).filter((n) => ids.has(n.id)).map((n) => n.version);
    const extra = active.filter((r) => !holders.includes(r) && namedAt(r).length && holders.some((h) => near(rnQuotes(r), rnQuotes(h))));
    const recs = [...holders, ...extra].sort((a, b) => naturalId(a.id, b.id));
    if (recs.length < 2) continue;
    const allowed = (r: StoredRecord) => new Set([...fixes, ...namedAt(r)]);
    if (!recs.every((r) => r.releases.length && r.releases.every((x) => allowed(r).has(x.version)))) continue;
    const quotes = recs.map(rnQuotes);
    if (quotes.some((q) => !q.length)) continue;
    let all = true;
    for (let i = 0; i < quotes.length && all; i++) for (let j = i + 1; j < quotes.length && all; j++) all = near(quotes[i]!, quotes[j]!);
    if (all) return { advisory, records: recs.map((r) => r.id) };
  }
  return undefined;
}

// ---- Another package's advisory (step 8) ----

/** Wording of code shipped inside the package: its users get the fix with the bump whatever the registry lists. */
const SHIPPED_WORDING = /\b(?:bundl(?:e|es|ed|ing)|vendor(?:s|ed|ing)?|compiled|inlined|embedded)\b/i;

/** Dependency-update wording on a release-notes item (conventional-commit types and bot names included). */
const DEPENDENCY_WORDING = /\b(?:bump(?:s|ed|ing)?|upgrad(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|chore|deps?|dependenc(?:y|ies)|devdependencies|lockfile|renovate|dependabot)\b/i;

/** Names a package URL goes by in prose: `@scope/name` and `name` (npm), the name alone elsewhere, lower-cased. */
function packageNames(purl: string): string[] {
  const path = decodeURIComponent(purl.replace(/^pkg:[^/]+\//, "")).toLowerCase();
  const last = path.split("/").at(-1)!;
  return [...new Set([path, last])].filter((x) => x.length >= 3);
}

const namesPackage = (text: string, purl: string): boolean => {
  const t = text.toLowerCase();
  return packageNames(purl).some((n) => new RegExp(`(^|[^a-z0-9@/_.-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_-])`).test(t));
};

/**
 * The release-notes item a quote came from: the best-matching item (`itemAtQuote`), else the one line of the body that
 * contains the quote as written (a quote that is an advisory id alone, `cve-2025-67779`, has no text left to score).
 */
export function sourceItem(body: string, quote: string): string | undefined {
  const item = itemAtQuote(body, quote);
  if (item !== undefined) return item;
  const q = quote.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return undefined;
  const lines = body.split("\n").filter((l) => l.toLowerCase().replace(/\s+/g, " ").includes(q));
  return lines.length === 1 ? lines[0] : undefined;
}

const purlType = (purl: string): string => /^pkg:([^/]+)\//i.exec(purl)?.[1]?.toLowerCase() ?? "";

const FOREIGN = "foreign-advisory";
const FOREIGN_RESTORED = "foreign-advisory-restored";
const WAS = /\(was ([a-z_]+); ([a-z, ]+)\)$/;

/** The labels a record had before a step relabelled it, from the step's last entry still in force (step 8 by default). */
function relabelledFrom(r: StoredRecord, action = FOREIGN, restored = FOREIGN_RESTORED): { change_type: StoredRecord["change_type"]; benefit: StoredRecord["benefit"] } | undefined {
  for (let i = r.history.length - 1; i >= 0; i--) {
    const h = r.history[i]!;
    if (h.action === restored) return undefined;
    if (h.action !== action) continue;
    const m = WAS.exec(h.detail ?? "");
    return m ? { change_type: m[1] as StoredRecord["change_type"], benefit: m[2]!.split(", ") as StoredRecord["benefit"] } : undefined;
  }
  return undefined;
}

/**
 * The packages (canonical package URLs) the technology's packages install for their users at the versions a record
 * lists: the runtime dependencies of every package of the technology (components and siblings: the dependency often
 * sits in a sibling, @nestjs/platform-express). Undefined when unknown: a package whose dependencies cannot be known (no
 * hook), none of the packages published at any of the versions, or a registry that cannot be read (logged).
 */
async function shippedPackages(
  s: TechStore,
  r: StoredRecord,
  packages: ReadonlySet<string>,
  dependencies: (component: string, version: string) => Promise<string[] | null | undefined>,
): Promise<Set<string> | undefined> {
  const shipped = new Set<string>();
  let known = false;
  for (const version of new Set(r.releases.map((x) => x.version))) {
    for (const component of packages) {
      let deps: string[] | null | undefined;
      try {
        deps = await dependencies(component, version);
      } catch (e) {
        console.error(`advisories: ${s.technology}: ${component}@${version} dependencies unavailable (${e instanceof Error ? e.message : e}); ${r.id} unchanged`);
        return undefined;
      }
      // Any package whose dependencies cannot be known (no hook): unknown. Not published at the version: nothing.
      if (deps === undefined) return undefined;
      if (deps === null) continue;
      known = true;
      for (const d of deps) shipped.add(canonicalPurl(d));
    }
  }
  return known ? shipped : undefined;
}

/** One `read` per key for the run (the registry and OSV answers are cached on disk too). */
function memo<T>(read: (component: string, version: string) => Promise<T>): (component: string, version: string) => Promise<T> {
  const seen = new Map<string, Promise<T>>();
  return (component, version) => {
    const k = `${component}@${version}`;
    if (!seen.has(k)) seen.set(k, read(component, version));
    return seen.get(k)!;
  };
}

/**
 * Step 8, deterministic and with no model call. A record is another package's advisory when it is active, carries no
 * advisory of this technology, holds release-notes evidence only, every evidence item (the quote and the notes' item
 * it came from) names advisory ids, none of them one of this technology's advisories (or their aliases), each
 * attributed by OSV only to packages outside the technology's packages, the item is worded as a dependency update or
 * names one of those packages and not as code shipped inside the package (bundled, vendored, compiled), and the
 * release does not install the fix for its users: none of those packages, and no package an item names, is a runtime
 * dependency of any of the technology's packages at the record's versions. So a fix of this package that also names
 * another's advisory keeps its labels (it names this package's advisory, OSV attributes an id to this package, or it
 * is not worded as an update), and so does a bump of a dependency the release installs. Such a record labelled
 * security (change type or benefit) becomes `other` with benefit `none`; a relabelled record that no longer qualifies
 * gets its labels back. Unknown keeps the record as it is: an id OSV does not know or attributes to no package, a
 * package of another ecosystem, no dependencies known for any release. A source that cannot be read leaves the record
 * unchanged this run.
 */
export async function relabelForeign(
  s: TechStore,
  advisories: readonly Advisory[],
  releases: ReadonlyArray<{ version: string; url: string }>,
  body: (version: string) => string | undefined,
  check: ForeignCheck,
): Promise<{ foreign: Array<{ record: string; ids: string[] }>; restored: string[] }> {
  const ours = new Set(advisories.flatMap((a) => [a.id, ...a.aliases].map((x) => x.toUpperCase())));
  const packages = new Set(check.packages.map(canonicalPurl));
  const byUrl = new Map(releases.map((r) => [r.url, r]));
  const looked = new Map<string, Promise<Set<string> | undefined>>();
  const lookup = (id: string) => {
    if (!looked.has(id)) looked.set(id, check.lookup(id));
    return looked.get(id)!;
  };
  const dependencies = memo(check.dependencies);
  const out = { foreign: [] as Array<{ record: string; ids: string[] }>, restored: [] as string[] };
  for (const r of Object.values(s.records).sort((a, b) => a.id.localeCompare(b.id))) {
    if (r.status !== "active") continue;
    const was = relabelledFrom(r);
    if (!isSecurity(r) && !was) continue;
    // Whether the record is another package's advisory: true, false, or undefined (OSV could not be read).
    const verdict = async (): Promise<{ ids: string[]; packages: string[] } | false | undefined> => {
      if (r.advisories?.length || !r.evidence.length) return false;
      const items: Array<{ text: string; ids: Set<string> }> = [];
      for (const e of r.evidence) {
        if ((e.kind ?? "release_notes") !== "release_notes") return false;
        const rel = byUrl.get(e.url);
        const b = rel && body(rel.version);
        const item = b ? sourceItem(b, e.quote) : undefined;
        const text = `${e.quote} ${item ?? ""}`;
        const ids = advisoryIds(text);
        if (!ids.size || [...ids].some((x) => ours.has(x))) return false;
        items.push({ text, ids });
      }
      const ids = [...new Set(items.flatMap((x) => [...x.ids]))].sort();
      const attributed = new Map<string, Set<string>>();
      for (const id of ids) {
        let p: Set<string> | undefined;
        try {
          p = await lookup(id);
        } catch (e) {
          console.error(`advisories: ${s.technology}: ${id} unavailable (${e instanceof Error ? e.message : e}); ${r.id} unchanged`);
          return undefined;
        }
        // Unknown to OSV: the labels stay as they are (a relabelled record is not restored on missing data either).
        if (!p) return undefined;
        if ([...p].some((x) => packages.has(canonicalPurl(x)))) return false;
        attributed.set(id, p);
      }
      for (const it of items) {
        const theirs = [...it.ids].flatMap((x) => [...attributed.get(x)!]);
        if (SHIPPED_WORDING.test(it.text)) return false;
        if (!DEPENDENCY_WORDING.test(it.text) && !theirs.some((p) => namesPackage(it.text, p))) return false;
      }
      // A package of another ecosystem (a Go module named by an npm package's notes: a binary it downloads may be built
      // with it) is beyond what the registry's dependencies can answer: kept.
      const foreignPackages = [...new Set([...attributed.values()].flatMap((x) => [...x]))].sort();
      const ecosystems = new Set([...packages].map(purlType));
      if (foreignPackages.some((p) => !ecosystems.has(purlType(p)))) return undefined;
      // Does the release ship the other package's fix to its users? The runtime dependencies of every package of the
      // technology (components and siblings: the dependency often sits in a sibling, @nestjs/platform-express) at each
      // version the record lists: one of the advisories' packages, or a package an item names (a direct dependency
      // updated for a transitive one's advisory), keeps the record. A package with no hook, or no package published at
      // any of the versions: unknown, as it is.
      const shipped = await shippedPackages(s, r, packages, dependencies);
      if (!shipped) return undefined;
      if (foreignPackages.some((p) => shipped.has(canonicalPurl(p)))) return false;
      if ([...shipped].some((d) => items.some((it) => namesPackage(it.text, d)))) return false;
      return { ids, packages: foreignPackages };
    };
    const v = await verdict();
    if (v === undefined) continue;
    if (v) {
      if (r.change_type === "other" && r.benefit.length === 1 && r.benefit[0] === "none") continue;
      const detail = `${v.ids.join(", ")} attributed by OSV to ${v.packages.join(", ")} only: a dependency update, not a security fix of this technology (was ${r.change_type}; ${r.benefit.join(", ")})`;
      applyChange(r, { change_type: "other", benefit: ["none"] }, FOREIGN, { detail });
      out.foreign.push({ record: r.id, ids: v.ids });
    } else if (was) {
      const benefit = union(was.benefit.filter((b) => b !== "none"), r.benefit.filter((b) => b !== "none"));
      const change_type = r.change_type === "other" ? was.change_type : r.change_type;
      applyChange(r, { change_type, benefit: benefit.length ? benefit : ["none"] }, FOREIGN_RESTORED, { detail: "no longer another package's advisory: labels restored" });
      out.restored.push(r.id);
    }
  }
  return out;
}

// ---- Another package's release (step 9) ----

const OTHER_PACKAGE = "other-package";
const OTHER_PACKAGE_RESTORED = "other-package-restored";

/** Change types a bump brings with no step of the project's (the bump digest's kinds): what step 9 looks at. */
const ARRIVES_WITH_BUMP: ReadonlySet<StoredRecord["change_type"]> = new Set(["security", "fix", "performance", "behavior_change", "default_change"]);

/** A package name as written (`lodash.omit`, `@scope/name`), nothing else: no spaces, call parentheses or paths. */
const PACKAGE_NAME = /^@?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)?$/i;

/**
 * The packages (canonical package URLs) a release body lists: lines that are, list marker aside, only a link to a
 * package's registry page (`- [lodash.omit](https://www.npmjs.com/package/lodash.omit)`, or the bare URL), read by
 * the hooks given. A registry link inside a sentence ("compatible with [x](...)") is a mention, not a listing.
 */
export function listedPackages(body: string, pages: ReadonlyArray<(url: string) => string | undefined>): Set<string> {
  const out = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim().replace(/[.,;]$/, "");
    const url = /^\[[^\]\n]+\]\((\S+?)\)$/.exec(line)?.[1] ?? /^<?(https?:\/\/\S+?)>?$/.exec(line)?.[1];
    if (!url) continue;
    for (const page of pages) {
      const p = page(url);
      if (p) out.add(canonicalPurl(p));
    }
  }
  return out;
}

/**
 * Step 9, deterministic and with no model call. A record is another package's release when it is active, carries no
 * advisory, holds release-notes evidence only, its labels (before this step relabelled it) say a bump brings it
 * (`ARRIVES_WITH_BUMP` or benefit security, not breaking: an obligation or an opt-in change stays as it is), its subject is a literal
 * package name, and in every release its evidence comes from the notes list that package on a line of its own as a
 * registry link (`listedPackages`), the package is not one of the technology's packages (components and siblings),
 * and it is not a runtime dependency of any of them at the record's versions (a bump that installs the package
 * brings its fix). Such a record becomes `other` with benefit `none` (history `other-package`, the old labels kept
 * there); a relabelled record that no longer qualifies gets its labels back. Unknown keeps the record as it is: a
 * release body not stored, an ecosystem without the `registryPage` or `dependencies` hook, no dependencies known.
 */
export async function relabelOtherPackage(
  s: TechStore,
  releases: ReadonlyArray<{ version: string; url: string }>,
  body: (version: string) => string | undefined,
  check: Pick<ForeignCheck, "packages" | "dependencies">,
): Promise<{ relabelled: Array<{ record: string; package: string }>; restored: string[] }> {
  const packages = new Set(check.packages.map(canonicalPurl));
  const types = [...new Set([...packages].map(purlType))];
  // Every ecosystem of the technology must read registry pages; one that cannot leaves every record as it is.
  const pages = types.map((x) => ecosystemOf(`pkg:${x}/x`).registryPage);
  const hooks = pages.every((x) => !!x) ? (pages as Array<(url: string) => string | undefined>) : undefined;
  const byUrl = new Map(releases.map((r) => [r.url, r]));
  const listed = new Map<string, Set<string> | undefined>();
  const listedIn = (version: string, read: Array<(url: string) => string | undefined>) => {
    if (!listed.has(version)) {
      const b = body(version);
      listed.set(version, b === undefined ? undefined : listedPackages(b, read));
    }
    return listed.get(version);
  };
  const dependencies = memo(check.dependencies);
  const out = { relabelled: [] as Array<{ record: string; package: string }>, restored: [] as string[] };
  for (const r of Object.values(s.records).sort((a, b) => a.id.localeCompare(b.id))) {
    if (r.status !== "active") continue;
    const was = relabelledFrom(r, OTHER_PACKAGE, OTHER_PACKAGE_RESTORED);
    const labels = was ?? r;
    if (!(ARRIVES_WITH_BUMP.has(labels.change_type) || isSecurity(labels))) continue;
    // The package the record is about: false (it is this technology's change), the package URL, or undefined (unknown).
    const verdict = async (): Promise<string | false | undefined> => {
      // Breaking: an obligation of this technology's users, whatever package it names (a relabelled record that became
      // breaking gets its labels back).
      if (r.breaking || r.advisories?.length || !r.evidence.length || r.subject_kind !== "literal") return false;
      const name = r.subject.trim();
      if (!PACKAGE_NAME.test(name)) return false;
      if (!hooks) return undefined;
      const candidates = new Set(types.map((x) => canonicalPurl(`pkg:${x}/${name}`)));
      let pkg: string | undefined;
      for (const e of r.evidence) {
        if ((e.kind ?? "release_notes") !== "release_notes") return false;
        const rel = byUrl.get(e.url);
        if (!rel) return undefined;
        const inBody = listedIn(rel.version, hooks);
        if (!inBody) return undefined;
        const hit = [...candidates].find((c) => inBody.has(c));
        if (!hit) return false;
        pkg = hit;
      }
      if (!pkg || packages.has(pkg)) return false;
      const shipped = await shippedPackages(s, r, packages, dependencies);
      if (!shipped) return undefined;
      return shipped.has(pkg) ? false : pkg;
    };
    const v = await verdict();
    if (v === undefined) continue;
    if (v) {
      if (r.change_type === "other" && r.benefit.length === 1 && r.benefit[0] === "none") continue;
      const detail = `${r.subject} is ${v}, listed in the release notes, not one of this technology's packages and not installed by the release: that package's change, not this technology's (was ${r.change_type}; ${r.benefit.join(", ")})`;
      applyChange(r, { change_type: "other", benefit: ["none"] }, OTHER_PACKAGE, { detail });
      out.relabelled.push({ record: r.id, package: v });
    } else if (was) {
      const benefit = union(was.benefit.filter((b) => b !== "none"), r.benefit.filter((b) => b !== "none"));
      const change_type = r.change_type === "other" ? was.change_type : r.change_type;
      applyChange(r, { change_type, benefit: benefit.length ? benefit : ["none"] }, OTHER_PACKAGE_RESTORED, { detail: "no longer another package's release: labels restored" });
      out.restored.push(r.id);
    }
  }
  return out;
}

/**
 * The advisories stage for one technology: fetch (OSV, cached), resolve, attach. The caller holds the technology's
 * lock and saves and publishes the store. `unread`: release versions whose notes are listed but not read yet (history
 * still being extracted, or the token-free first pass before any): an advisory fixed only there is never judged (no
 * model call) and gets a record of its own, which is judged against those notes once they are read (step 6). A source
 * that cannot be read fails open: the store is left as it is and
 * the reason is logged (the records already published stay; the edge says nothing new).
 */
export async function advisoryStage(
  t: Technology,
  s: TechStore,
  releases: ReadonlyArray<{ version: string; date: string; url: string }>,
  judge: (state: Record<string, unknown>, questions: Questions) => Promise<Classification>,
  opts: { refresh?: boolean; offline?: boolean; unread?: ReadonlySet<string>; apis?: boolean } = {},
): Promise<AttachReport | undefined> {
  // The release index and its derived lines first (lines.ts): the attachment and the releases below use them.
  s.releaseIndex = buildIndex(releases);
  let advisories: Advisory[];
  try {
    advisories = await fetchAdvisories(t, opts);
  } catch (e) {
    console.error(`advisories: ${t.id}: source unavailable (${e instanceof Error ? e.message : e}); advisories unchanged`);
    for (const r of Object.values(s.records)) {
      const rels = r.status === "active" ? recomputeReleases(r, s, t.components) : undefined;
      if (rels && JSON.stringify(rels) !== JSON.stringify(r.releases)) applyChange(r, { releases: rels }, "releases", { detail: "recomputed per release line" });
    }
    return undefined;
  }
  // Step 8 needs every package of the technology: with the siblings unread an advisory of one could pass for another
  // package's, so the step is skipped (labels as they are).
  const { purls: packages, complete } = await packageList(t, opts);
  if (!complete) console.error(`advisories: ${t.id}: package list incomplete; another package's advisories not checked this run`);
  const report = await attachAdvisories(
    t,
    s,
    advisories,
    releases,
    judge,
    complete ? { packages, lookup: (id) => advisoryPackages(t, id, opts), dependencies: (component, version) => releaseDependencies(t, component, version, opts) } : undefined,
    await (async () => {
      // Step 11 reads release-notes headings: with no such record (a first pass) the registry is not asked.
      if (!Object.values(s.records).some((r) => r.status === "active" && r.evidence.some((e) => (e.kind ?? "release_notes") === "release_notes"))) return undefined;
      const packages = await repositoryPackages(t, opts);
      return packages && { packages, dependencies: (component: string, version: string) => releaseDependencies(t, component, version, opts) };
    })(),
    opts.unread,
  );
  // Each advisory's affected APIs (one cached extraction-model call per advisory; `apis: false`, the token-free first
  // pass, makes none and leaves the stored ones).
  if (opts.apis !== false) {
    const a = await attachAdvisoryApis(s, advisories, packageNamesOf([...t.components, ...packages]), await osvTexts(t), (id) => aliasDetails(t, id, opts));
    report.apis = { named: a.named, records: a.records };
  }
  return report;
}
