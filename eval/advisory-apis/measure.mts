// Per-advisory affected-API extraction (central advisory-apis.ts; eval/advisory-apis/RESULTS.md): a seeded sample of the
// advisories in a central store's OSV cache, each read by `advisoryApis` exactly as the advisories stage reads it, with
// the model's tokens and dollars from the call log.
//
//   cd central && UNSTALE_STORE=<store> node ../eval/advisory-apis/measure.mts <out.json> [--n 200] [--ids GHSA-..,CVE-..]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { attachAdvisoryApis, packageNamesOf } from "../../central/src/pipeline/advisory-apis.ts";
import { aliasDetails, fromOsv, osvTexts, type Advisory, type OsvVuln } from "../../central/src/pipeline/advisories.ts";
import { TECHNOLOGIES, type Technology } from "../../central/src/pipeline/technologies.ts";
import { extractModel, llmStats } from "../../central/src/pipeline/llm.ts";
import { centralDir } from "../../central/src/pipeline/paths.ts";
import { pool, readJson, sha256, writeAtomic } from "../../central/src/pipeline/util.ts";

const args = process.argv.slice(2);
const out = args.find((a, i) => !a.startsWith("--") && !(i && ["--n", "--ids"].includes(args[i - 1]!)));
if (!out) throw new Error("usage: measure.mts <out.json> [--n 200] [--ids a,b]");
const opt = (k: string) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
const n = Number(opt("--n") ?? 200);
const want = new Set((opt("--ids") ?? "").split(",").filter(Boolean));

// Every advisory once, with the technology's packages (packages.json) it was fetched for.
const all = new Map<string, { a: Advisory; packages: string[]; tech: string }>();
const root = join(centralDir(), "advisories");
for (const tech of readdirSync(root).sort()) {
  const packages = readJson<{ purls?: string[] }>(join(root, tech, "packages.json"))?.purls;
  if (!packages?.length) continue;
  let files: string[] = [];
  try { files = readdirSync(join(root, tech, "osv")).sort(); } catch { continue; }
  for (const f of files) {
    for (const v of readJson<{ vulns: OsvVuln[] }>(join(root, tech, "osv", f))?.vulns ?? []) {
      const a = fromOsv(v, new Set(packages));
      if (a && !all.has(a.id)) all.set(a.id, { a, packages, tech });
    }
  }
}
// The sample: the named ids, then advisories in order of a hash of their id (seeded, reproducible).
const picked = [...all.values()].filter((x) => want.has(x.a.id) || x.a.aliases.some((y) => want.has(y)));
picked.push(...[...all.values()].filter((x) => !picked.includes(x)).sort((x, y) => sha256(x.a.id).localeCompare(sha256(y.a.id))).slice(0, Math.max(0, n - picked.length)));
const before = { ...llmStats };
// Each advisory as the stage reads it (advisory-apis.ts attachAdvisoryApis): its text, its other entries' texts, and
// its aliases' entries (cached OSV GETs) when it names none at first.
const rows = await pool(picked, 6, async ({ a, packages, tech }) => {
  const names = packageNamesOf(packages.filter((p) => a.affected.some((r) => r.component === p)));  // reported only
  const t = TECHNOLOGIES[tech] ?? ({ id: tech, name: tech, repo: "", components: packages, tag: /^$/, clean: (b: string) => b } as Technology);
  const s = { technology: tech, records: {}, ingested: {} } as never as Parameters<typeof attachAdvisoryApis>[0];
  await attachAdvisoryApis(s, [a], packageNamesOf([...t.components, ...packages]), await osvTexts(t), (id) => aliasDetails(t, id));
  const apis = s.advisoryApis?.[0]?.apis ?? [];
  return { id: a.id, aliases: a.aliases, package: names[0], apis, summary: a.summary };
});
const used = Object.fromEntries(Object.entries(llmStats).map(([k, v]) => [k, (v as number) - ((before as Record<string, number>)[k] ?? 0)]));
const named = rows.filter((r) => r.apis.length).length;
const report = { model: extractModel(), advisories_in_store: all.size, sample: rows.length, named, calls: used, per_call: { input_tokens: (used.input_tokens ?? 0) / Math.max(1, used.calls ?? 0), output_tokens: (used.output_tokens ?? 0) / Math.max(1, used.calls ?? 0), dollars: (used.dollars ?? 0) / Math.max(1, used.calls ?? 0) }, per_advisory: { calls: (used.calls ?? 0) / Math.max(1, rows.length), dollars: (used.dollars ?? 0) / Math.max(1, rows.length) }, rows };
writeAtomic(out, JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({ ...report, rows: undefined }));
