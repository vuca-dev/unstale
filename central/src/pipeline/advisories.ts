// Security advisories from OSV (osv.dev: GHSA, PyPA, RustSec, Go vulndb, ...), attached to the records that describe
// their fix (vault: Data Model Contract, evidence kinds; Relevance Engine, "Bump digest"). Release notes name some
// advisories and omit others, and date backports inconsistently; the advisory database states, per package, which
// versions are affected and which version first has the fix. That is what the edge needs to say which advisories a
// bump fixes, so each security record carries its advisories' ids and affected versions.
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
//      the advisory (the release notes omitted it);
//   7. every linked record gets the advisory (id, aliases, ranges, resolved versions) and a release on each line the
//      fix shipped on in the window (a backport the notes left out).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Classification, Questions } from "./classify/adapter.ts";
import type { Labels } from "./classify/labels.ts";
import { ecosystemOf, npmName as npmNameOf, npmPurl, semverOrder } from "./ecosystems.ts";
import type { Incoming } from "./extract.ts";
import { buildIndex, lineFn, recomputeReleases } from "./lines.ts";
import { advisoryIds, create, evidenceOf, K, kindOf, matchRequest, nearIdenticalQuote, pick, retrieve } from "./match.ts";
import { centralDir } from "./paths.ts";
import { applyChange, combineReleases, mergeInto, union, type StoredRecord, type TechStore } from "./store.ts";
import type { Technology } from "./technologies.ts";
import { canonical, oneLine, readJson, releaseLine, sha256, writeAtomic } from "./util.ts";

const FRESH_MS = 12 * 3600 * 1000;
const OSV = "https://api.osv.dev/v1/query";

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

const dir = (t: Technology) => join(centralDir(), "advisories", t.id);
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const safe = (purl: string) => purl.replace(/^pkg:/, "").replace(/%40/g, "").replace(/[^A-Za-z0-9._-]+/g, "__");

/**
 * The technology's packages (package URLs): its components plus its ecosystem's siblings from the same repository.
 * Cached; offline uses the cache; a failed sibling lookup falls back to the components.
 */
export async function techPackages(t: Technology, opts: { refresh?: boolean; offline?: boolean } = {}): Promise<string[]> {
  const p = join(dir(t), "packages.json");
  const cached = readJson<{ checked: string; purls?: string[] }>(p);
  const fresh = cached?.purls && Date.now() - Date.parse(cached.checked) < FRESH_MS;
  if (cached?.purls && (opts.offline || (fresh && !opts.refresh))) return cached.purls;
  const out = new Set(t.components);
  if (opts.offline) return [...out].sort();
  for (const eco of new Set(t.components.map(ecosystemOf))) {
    if (!eco.siblings) continue;
    try {
      advisoryStats.registryLists++;
      for (const x of await eco.siblings(t)) out.add(x);
    } catch (e) {
      console.error(`advisories: ${t.id}: sibling packages unavailable (${e instanceof Error ? e.message : e}); components only`);
      return [...out].sort();
    }
  }
  const purls = [...out].sort();
  writeAtomic(p, JSON.stringify({ checked: stamp(), purls }, null, 1) + "\n");
  return purls;
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
  const p = a.package?.purl ?? (a.package?.ecosystem === "npm" && a.package.name ? npmPurl(a.package.name) : undefined);
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
 * Advisory ids on the list item of a release body that a quote was taken from (a Markdown list item names its
 * advisory in its link). The quote is located at the best-matching item, not at every item containing it: each window
 * of up to 4 lines that contains the quote is scored by coverage (quote length / the window's text length, links and
 * ids stripped); the best gives its ids. No window, or a tie for best between windows naming different ids, gives
 * none (the advisory is then judged).
 * Release notes that re-list an earlier advisory next to its follow-up ("... - Incomplete Fix Follow-Up") thus give
 * the earlier one's quote the earlier one's id only.
 */
export function idsAtQuote(body: string, quote: string): Set<string> {
  const lines = body.split("\n");
  const q = flat(quote);
  if (q.length < 8) return new Set();
  let best: { cov: number; ids: Set<string> } | undefined;
  let tie = false;
  for (let len = 1; len <= 4; len++) {
    for (let i = 0; i + len <= lines.length; i++) {
      const raw = lines.slice(i, i + len).join(" ");
      const text = flat(raw);
      if (!text.includes(q)) continue;
      const cov = q.length / text.length;
      if (!best || cov > best.cov + 1e-9) {
        best = { cov, ids: advisoryIds(raw) };
        tie = false;
      } else if (Math.abs(cov - best.cov) <= 1e-9) {
        const ids = advisoryIds(raw);
        if (ids.size !== best.ids.size || [...ids].some((x) => !best!.ids.has(x))) tie = true;
      }
    }
  }
  return best && !tie ? best.ids : new Set();
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

/** How a record came to hold an advisory, from its history: the first `advisory` entry naming it decides. */
export type Basis = "id" | "judged" | "created" | "unknown";
export function basisOf(r: StoredRecord, id: string): Basis {
  for (const h of r.history) {
    if (h.action === "advisory-match" && h.detail?.toUpperCase().includes(`+ADVISORY.${id}`)) return "judged";
    if (h.action !== "advisory" || !h.detail?.startsWith(`${id} (`)) continue;
    const how = h.detail.slice(id.length + 2, -1);
    if (how === "named in the release notes") return "id";
    if (how === "judged") return "judged";
    if (how === "from the advisory") return "created";
  }
  return "unknown";
}

export interface AttachReport {
  advisories: number;
  inWindow: number;
  byId: number;
  judged: number;
  created: number;
  releasesAdded: number;
  recordsChanged: number;
  /** Id-based attachments whose basis no longer holds (the id is not at the record's quote any more): removed. */
  removed: Array<{ advisory: string; record: string }>;
  /** Twins merged (one advisory on several records with near-identical quotes, each released only in its fixes). */
  twinsMerged: Array<{ advisory: string; from: string; into: string }>;
  /** Advisories still on more than one record after the twin merge, reported (not guessed). */
  multiHolder: Array<{ advisory: string; records: string[] }>;
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
): Promise<AttachReport> {
  const report: AttachReport = { advisories: advisories.length, inWindow: 0, byId: 0, judged: 0, created: 0, releasesAdded: 0, recordsChanged: 0, removed: [], twinsMerged: [], multiHolder: [] };
  const changed = new Set<string>();
  const lineOf = lineFn(s);
  // One release index: the store's (lines.ts, published in the tech index) when it has one. Each advisory carries a
  // copy as `index` for edges that do not read the tech index's `releases` yet.
  const indexVersions = s.releaseIndex ? s.releaseIndex.releases.map((x) => x.version) : releases.map((x) => x.version);
  const byUrl = new Map(releases.map((r) => [r.url, r]));
  const body = (version: string): string | undefined => {
    const p = join(centralDir(), "releases", t.id, `${version}.md`);
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

  for (const a of advisories) {
    const fixes = fixesInWindow(a, releases, lineOf);
    if (!fixes.length) continue;
    report.inWindow++;
    const aliases = new Set([a.id, ...a.aliases.map((x) => x.toUpperCase())]);
    const active = () => Object.values(s.records).filter((r) => r.status === "active");
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
    if (direct.length) {
      if (direct.some((r) => !holders.includes(r))) report.byId++;
      for (const r of direct) link(r, a, fixes, holders.includes(r) ? "attached" : "named in the release notes");
      for (const r of sticky) link(r, a, fixes, "attached");
      continue;
    }
    // Judged or made from the advisory before: kept (refreshed), nothing to judge.
    if (sticky.length) {
      for (const r of sticky) link(r, a, fixes, "attached");
      continue;
    }
    // Step 5: judged against the records released in a patched version, one request per fixed line.
    let matched: StoredRecord | undefined;
    for (const fix of fixes) {
      const inc = advisoryIncoming(t, a, fix);
      const pool = active().filter((r) => r.releases.some((x) => x.version === fix.version));
      const scored = retrieve(inc, pool).map((c) => s.records[c.id]!);
      const rest = pool.filter((r) => !scored.includes(r)).sort((x, y) => Number(isSecurity(y)) - Number(isSecurity(x)) || x.id.localeCompare(y.id));
      const cands = [...scored, ...rest].slice(0, K);
      if (!cands.length) continue;
      report.judged++;
      const req = matchRequest(t.name, inc, false, cands);
      const verdict = await judge(req.state, req.questions);
      const chosen = pick(cands, verdict.answers, { breaking: false, quote: inc.quote, summary: inc.summary, kind: kindOf(inc) }, verdict.calibrated !== false);
      if (chosen.id) {
        matched = s.records[chosen.id]!;
        matched.history.push({ action: "advisory-match", detail: `${inc.key} p=${chosen.p}`, revision: matched.revision, label_version: matched.label_version, judged: chosen.judged });
        break;
      }
    }
    if (matched) {
      link(matched, a, fixes, "judged");
      continue;
    }
    // Step 5, no match: the release notes omitted the advisory; a record of its own.
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
    link(r, a, fixes, "from the advisory");
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

/**
 * The advisories stage for one technology: fetch (OSV, cached), resolve, attach. The caller holds the technology's
 * lock and saves and publishes the store. A source that cannot be read fails open: the store is left as it is and
 * the reason is logged (the records already published stay; the edge says nothing new).
 */
export async function advisoryStage(
  t: Technology,
  s: TechStore,
  releases: ReadonlyArray<{ version: string; date: string; url: string }>,
  judge: (state: Record<string, unknown>, questions: Questions) => Promise<Classification>,
  opts: { refresh?: boolean; offline?: boolean } = {},
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
  return attachAdvisories(t, s, advisories, releases, judge);
}
