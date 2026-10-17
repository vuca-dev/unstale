// Old against new admission rules (central/src/pipeline/admission.ts) on the scope study's deep sample (deep20.json),
// from the cached registry, GitHub and ecosyste.ms responses only (no network). Weighted by each row's population
// weight (packages). The old rule: fresh by the newer of the last release and the last push; stars for any package.
//   cd central && npx tsx ../eval/scope/admission-check.mts
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { admit, fromGithub, fromNpm, fromPypi, repoShare, THRESHOLDS, type Signals } from "../../central/src/pipeline/admission.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-16T00:00:00Z");
const cached = (url: string): any => {
  const key = createHash("sha256").update(url).digest("hex");
  const path = join(HERE, "cache", key.slice(0, 2), `${key}.json`);
  if (!existsSync(path)) return { missing: true };
  const raw = readFileSync(path, "utf8");
  return raw === "__404__" ? undefined : JSON.parse(raw);
};

type Row = { eco: "npm" | "pypi"; name: string; band: string; weight: number; repo: string | null; downloads_month: number | null; multiplicity?: number; per_package_tags?: boolean };
const rows: Row[] = JSON.parse(readFileSync(join(HERE, "deep20.json"), "utf8"));
const purlOf = (r: Row) => (r.eco === "npm" ? `pkg:npm/${r.name.replace(/^@/, "%40")}` : `pkg:pypi/${r.name}`);

let missing = 0;
const out = rows.map((r) => {
  const reg = r.eco === "npm" ? cached(`https://registry.npmjs.org/${r.name.replace("/", "%2f")}`) : cached(`https://pypi.org/pypi/${r.name}/json`);
  const gh = r.repo ? cached(`https://api.github.com/repos/${r.repo}`) : undefined;
  if (reg?.missing || gh?.missing) missing++;
  const base: Signals = {
    purl: purlOf(r),
    repo: r.repo ?? undefined,
    downloads: r.downloads_month === null ? undefined : (r.downloads_month * 7) / 30.44,
    downloadsWindow: "week",
    ...(reg?.missing ? {} : r.eco === "npm" ? fromNpm(reg) : fromPypi(reg)),
    ...(gh?.missing ? {} : fromGithub(gh)),
  };
  const t = THRESHOLDS[r.eco]!;
  const starsOnly = base.stars !== undefined && base.stars >= t.minStars && !(base.downloads !== undefined && base.downloads >= t.minDownloads);
  const lookup = starsOnly && r.repo ? cached(`https://packages.ecosyste.ms/api/v1/packages/lookup?repository_url=${encodeURIComponent(`https://github.com/${r.repo}`)}`) : undefined;
  const s: Signals = { ...base, ...(lookup && !lookup.missing ? repoShare(lookup, r.name, r.eco) : {}) };
  // Old rule: no type/deprecated/archived checks, freshness by the newer of release and push, stars for any package.
  const fresh = [s.lastRelease, s.lastCommit].filter(Boolean) as string[];
  const oldS: Signals = { purl: "pkg:x/old", downloads: s.downloads, stars: s.stars, lastRelease: fresh.sort().at(-1) };
  const old = admit(oldS, t, NOW);
  const now = admit(s, t, NOW);
  const shared = (r.multiplicity ?? 1) > 1 && !r.per_package_tags;
  return { name: r.name, eco: r.eco, band: r.band, w: r.weight, tw: shared ? r.weight / (r.multiplicity ?? 1) : r.weight, old: old.admit, new: now.admit, rule: now.rule, why: now.why, lookup: starsOnly ? (lookup?.missing ? "missing" : lookup ? "read" : "404") : "-" };
});

const sum = (xs: typeof out, k: "w" | "tw") => xs.reduce((a, x) => a + x[k], 0);
const oldAdm = out.filter((x) => x.old);
const lost = oldAdm.filter((x) => !x.new);
const gained = out.filter((x) => !x.old && x.new);
const byRule: Record<string, { n: number; pkgShare: number; techShare: number; examples: string[] }> = {};
for (const x of lost) {
  const b = (byRule[x.rule ?? "?"] ??= { n: 0, pkgShare: 0, techShare: 0, examples: [] });
  b.n++;
  b.pkgShare += x.w / sum(oldAdm, "w");
  b.techShare += x.tw / sum(oldAdm, "tw");
  if (b.examples.length < 4) b.examples.push(`${x.eco}:${x.name}`);
}
const report = {
  sample: rows.length,
  cache_misses: missing,
  admitted_old: oldAdm.length,
  admitted_new: out.filter((x) => x.new).length,
  lost_from_old: lost.length,
  gained_over_old: gained.map((x) => `${x.eco}:${x.name} (${x.rule})`),
  lost_by_rule: Object.fromEntries(Object.entries(byRule).map(([k, v]) => [k, { ...v, pkgShare: +v.pkgShare.toFixed(3), techShare: +v.techShare.toFixed(3) }])),
  lookups: out.reduce<Record<string, number>>((a, x) => ((a[x.lookup] = (a[x.lookup] ?? 0) + 1), a), {}),
};
writeFileSync(join(HERE, "admission-check.json"), JSON.stringify({ report, rows: out }, null, 1) + "\n");
console.log(JSON.stringify(report, null, 1));
