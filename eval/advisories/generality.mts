// Generality check for the advisories stage (eval/advisories/GENERALITY.md): central's OSV source and range resolution
// (central/src/pipeline/advisories.ts, unchanged) run on non-npm packages against their real registries' release
// lists. The release-list fetch here is a minimal stand-in for each ecosystem's registry adapter (the part any port
// needs anyway); nothing is wired into onboarding.
//
//   cd central && UNSTALE_CENTRAL_DIR=<scratch dir> npx tsx ../eval/advisories/generality.mts <out.json>
//
// Per package: release index (all releases since SINCE, oldest first, in the registry's own version vocabulary),
// OSV advisories, each range resolved against the index (resolved / unresolved by range type), and the fixes inside
// the window (fixed version = a release in the index). Release lines (eval/lines/RESULTS.md): the derived depth, the
// interleavings per depth, and the fixes per derived line against the old rule's (major, or 0.minor).
import { advisoryStats, fetchAdvisories, fixesInWindow, resolveRange, toRecordAdvisory } from "../../central/src/pipeline/advisories.ts";
import type { Technology } from "../../central/src/pipeline/technologies.ts";
import { buildIndex, deriveDepth, lineFn, prefix } from "../../central/src/pipeline/lines.ts";
import { writeAtomic } from "../../central/src/pipeline/util.ts";

const SINCE = "2023-01-01";
const UA = { "User-Agent": "unstale-central (generality check)" };
let registryRequests = 0;
async function get(url: string): Promise<unknown> {
  registryRequests++;
  const res = await fetch(url, { headers: { ...UA, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}
type Rel = { version: string; date: string; url: string };

// ---- Minimal release-list adapters, one per registry ----
const ADAPTERS: Record<string, () => Promise<Rel[]>> = {
  // PyPI JSON API: version → files; the date is the first upload; yanked-only releases dropped.
  "pkg:pypi/django": async () => {
    const d = (await get("https://pypi.org/pypi/django/json")) as { releases: Record<string, Array<{ upload_time_iso_8601: string; yanked: boolean }>> };
    return Object.entries(d.releases)
      .filter(([, files]) => files.length && files.some((f) => !f.yanked))
      .map(([version, files]) => ({ version, date: files.map((f) => f.upload_time_iso_8601).sort()[0]!.slice(0, 10), url: `https://pypi.org/project/Django/${version}/` }));
  },
  // crates.io: paginated version list with created_at; yanked versions dropped.
  "pkg:cargo/tokio": async () => {
    const out: Rel[] = [];
    for (let q: string | null = "?per_page=100"; q; ) {
      const d = (await get(`https://crates.io/api/v1/crates/tokio/versions${q}`)) as { versions: Array<{ num: string; created_at: string; yanked: boolean }>; meta: { next_page: string | null } };
      for (const v of d.versions) if (!v.yanked) out.push({ version: v.num, date: v.created_at.slice(0, 10), url: `https://crates.io/crates/tokio/${v.num}` });
      q = d.meta.next_page;
    }
    return out;
  },
  // Go module proxy: tag list, then one .info per version for its time. Go's vocabulary is `v1.2.3`; OSV writes
  // `1.2.3`. The adapter stores OSV's form (the lockfile reader at the edge would strip the `v` the same way).
  "pkg:golang/golang.org/x/net": async () => {
    const list = String(await get("https://proxy.golang.org/golang.org/x/net/@v/list")).split("\n").filter(Boolean);
    const out: Rel[] = [];
    for (const v of list) {
      const info = (await get(`https://proxy.golang.org/golang.org/x/net/@v/${v}.info`)) as { Time: string };
      out.push({ version: v.replace(/^v/, ""), date: info.Time.slice(0, 10), url: `https://pkg.go.dev/golang.org/x/net@${v}` });
    }
    return out;
  },
  // Maven Central search (gav core): version and timestamp.
  "pkg:maven/org.apache.logging.log4j/log4j-core": async () => {
    const d = (await get("https://search.maven.org/solrsearch/select?q=g:org.apache.logging.log4j+AND+a:log4j-core&core=gav&rows=400&wt=json")) as { response: { docs: Array<{ v: string; timestamp: number }> } };
    return d.response.docs.map((x) => ({ version: x.v, date: new Date(x.timestamp).toISOString().slice(0, 10), url: `https://central.sonatype.com/artifact/org.apache.logging.log4j/log4j-core/${x.v}` }));
  },
};

const out: Record<string, unknown> = {};
for (const [purl, adapter] of Object.entries(ADAPTERS)) {
  const all = await adapter();
  const releases = all.filter((r) => r.date >= SINCE).sort((a, b) => a.date.localeCompare(b.date) || a.version.localeCompare(b.version));
  const index = releases.map((r) => r.version);
  const t: Technology = { id: purl.replace(/^pkg:/, "").replace(/[^a-z0-9.]+/gi, "-"), name: purl, repo: "", components: [purl], tag: /^$/, clean: (b) => b };
  const advisories = await fetchAdvisories(t);
  const byType: Record<string, { resolved: number; unresolved: number }> = {};
  for (const a of advisories)
    for (const r of a.affected) {
      const k = (byType[r.type] ??= { resolved: 0, unresolved: 0 });
      if (resolveRange(r, index)) k.resolved++;
      else k.unresolved++;
    }
  const inWindow = advisories
    .map((a) => ({ a, fixes: fixesInWindow(a, releases) }))
    .filter((x) => x.fixes.length)
    .map(({ a, fixes }) => {
      const rec = toRecordAdvisory(a, index);
      return {
        id: a.id,
        aliases: a.aliases,
        summary: a.summary,
        fixes: fixes.map((f) => `${f.version} (${f.date})`),
        ranges: rec.affected.map((r) => ({ range: r.range, patched: r.patched, affectedInIndex: r.versions ? `${r.versions.length}: ${r.versions.slice(0, 3).join(", ")}${r.versions.length > 3 ? ", ..." : ""}${r.versions.length > 3 ? ` ${r.versions.at(-1)}` : ""}` : "unresolved" })),
      };
    });
  // Release lines derived from the index (central lines.ts), and what the old rule collapsed.
  const lines = buildIndex(releases);
  const stable = lines.releases;
  const interleavings = Object.fromEntries(
    [1, 2, 3].map((d) => {
      const last = new Map<string, { v: string; date: string }>();
      const ex: string[] = [];
      for (const r of stable) {
        const g = prefix(r.version, d)!;
        const p = last.get(g);
        if (p && r.date < p.date) ex.push(`${r.version} (${r.date}) before ${p.v} (${p.date})`);
        if (!p || r.date >= p.date) last.set(g, { v: r.version, date: r.date });
      }
      return [d, { count: ex.length, examples: ex.slice(0, 3) }];
    }),
  );
  const lineOf = lineFn({ releaseIndex: lines });
  const datedPerLine = advisories.flatMap((a) => {
    const old = new Set(fixesInWindow(a, releases).map((f) => f.version));
    return fixesInWindow(a, releases, lineOf).filter((f) => !old.has(f.version)).map((f) => `${a.id} ${f.version} (${f.date}, line ${f.line})`);
  });
  const lost = advisories.flatMap((a) => {
    const now = new Set(fixesInWindow(a, releases, lineOf).map((f) => f.version));
    return fixesInWindow(a, releases).filter((f) => !now.has(f.version)).map((f) => `${a.id} ${f.version}`);
  });
  console.log(purl, JSON.stringify({ depth: lines.depth, check: deriveDepth(releases), interleavings: Object.fromEntries(Object.entries(interleavings).map(([d, x]) => [d, x.count])), datedPerLine: datedPerLine.length, oldLinesMerged: lost.length }));
  out[purl] = {
    lines: { depth: lines.depth, stableReleases: stable.length, lines: [...new Set(stable.map((r) => r.line))].length, lineStarts: stable.filter((r) => r.line_start).length, interleavings, fixesDatedPerLineNow: datedPerLine, oldLineFixesNowOneLine: lost },
    releasesSince: releases.length,
    first: index[0],
    last: index.at(-1),
    advisories: advisories.length,
    rangesByType: byType,
    advisoriesWithEveryRangeResolved: advisories.filter((a) => a.affected.every((r) => resolveRange(r, index))).length,
    inWindow: inWindow.length,
    fixed: inWindow,
  };
  console.log(purl, JSON.stringify({ releases: releases.length, advisories: advisories.length, rangesByType: byType, inWindow: inWindow.length }));
}
out.network = { ...advisoryStats, registryRequests };
writeAtomic(process.argv[2]!, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out.network));
