// Bump-digest security lines against the GitHub Advisory Database (eval/advisories/RESULTS.md).
//
// For next, prisma and nestjs: the advisories of each technology's packages (central advisories.ts: OSV, cached in
// the central store), the catalog's records, and a reference mapping advisory → records describing its fix (Codex
// gpt-5.6-luna, one advisory per call, cached by request). Then:
//   (a) every advisory fixed inside the catalog window has, on each line it was fixed on, a security record dated to a
//       release that contains the fix;
//   (b) no record describing an advisory is dated, on a line, to a release the advisory says is still affected;
//   (c) the `unstale digest` of the two dogfood repositories (digest.sh output) lists exactly the advisories fixed
//       between the installed and the target version.
//
//   cd central && UNSTALE_CENTRAL_DIR=<store with the advisory cache> \
//     npx tsx ../eval/advisories/measure.mts <catalog dir> <digest dir> <out.json> [--offline] [--derived]
//
// `--derived`: units per release line as the catalog's tech index derives it (eval/lines/RESULTS.md), instead of the
// old rule (major, or 0.minor); a catalog without a release index falls back to the old rule.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { affects, fetchAdvisories, fixesInWindow, inRange, npmName, semverCmp, type Advisory } from "../../central/src/pipeline/advisories.ts";
import { codex, codexStats, parseJson } from "../../central/src/pipeline/codex.ts";
import { advisoryIds } from "../../central/src/pipeline/match.ts";
import { centralDir } from "../../central/src/pipeline/paths.ts";
import { TECHNOLOGIES } from "../../central/src/pipeline/technologies.ts";
import { pool, releaseLine, writeAtomic } from "../../central/src/pipeline/util.ts";

const [catalogDir, digestDir, outPath] = process.argv.slice(2);
if (!catalogDir || !digestDir || !outPath) throw new Error("usage: measure.mts <catalog dir> <digest dir> <out.json>");
const TECHS = ["next", "prisma", "nestjs"];
const DERIVED = process.argv.includes("--derived");
/** The line function the units are counted by: the tech index's derived lines (`--derived`), else the old rule. */
function lineFnOf(tech: string): (v: string) => string {
  if (!DERIVED) return releaseLine;
  const idx = JSON.parse(readFileSync(join(catalogDir!, "v1", "tech", `${tech}.json`), "utf8")) as { releases?: Array<{ version: string; line: string }> };
  const rel = idx.releases ?? [];
  if (!rel.length) return releaseLine;
  const by = new Map(rel.map((r) => [r.version, r.line]));
  const depth = rel[0]!.line.split(".").length;
  return (v) => by.get(v) ?? (/^\d+(\.\d+)*$/.test(v) ? Array.from({ length: depth }, (_, i) => String(Number(v.split(".")[i] ?? 0))).join(".") : releaseLine(v));
}
const E2E = join(process.env.HOME!, "ati-slice0", "e2e");

interface Rec {
  id: string;
  technology: string;
  change_type: string;
  benefit: string[];
  subject: string;
  summary: string;
  releases: Array<{ component: string; version: string; line: string }>;
  evidence: Array<{ kind: string; quote: string; url: string }>;
  advisories?: Array<{ id: string; aliases: string[] }>;
}
const isSecurity = (r: Rec) => r.change_type === "security" || r.benefit.includes("security");

function records(tech: string): Rec[] {
  const idx = JSON.parse(readFileSync(join(catalogDir, "v1", "tech", `${tech}.json`), "utf8")) as { shards: Array<{ path: string }> };
  return idx.shards.flatMap((s) =>
    gunzipSync(readFileSync(join(catalogDir, s.path)))
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.status === "active"),
  );
}

const recText = (r: Rec) => `${r.summary} ${r.evidence.map((e) => e.quote).join(" ")}`;

const REF = `You check a catalog of change records for %TECH% against a security advisory from the GitHub Advisory Database.

Advisory %ID% (%ALIASES%), severity %SEV%: %SUMMARY%
Affected: %RANGES%
Description (start): %DESC%

Catalog records (id: subject; releases; summary; evidence quotes):
%RECORDS%

Which of these records describe the fix for THIS vulnerability? A record counts when the change it describes is the fix
for this advisory, including a record that lists several security fixes among which this one is named or clearly
described. A fix for a different vulnerability, a general hardening change, or a dependency bump does not count. If
unsure, leave it out.

Output only a JSON object: {"records": [ids]} (an empty list when none).`;

interface TechData {
  advisories: Advisory[];
  inWindow: Advisory[];
  releases: Array<{ version: string; date: string }>;
  recs: Rec[];
  reference: Map<string, string[]>;
}

const data: Record<string, TechData> = {};
for (const tech of TECHS) {
  const t = TECHNOLOGIES[tech]!;
  const advisories = await fetchAdvisories(t, { offline: process.argv.includes("--offline") });
  const releases = (JSON.parse(readFileSync(join(centralDir(), "releases", tech, "index.json"), "utf8")) as { releases: Array<{ version: string; date: string }> }).releases;
  const recs = records(tech);
  const lineOf = lineFnOf(tech);
  const inWindow = advisories.filter((a) => fixesInWindow(a, releases, lineOf).length);
  const desc = new Map(advisories.map((a) => [a.id, a.details ?? ""]));
  const order = releases.map((r) => r.version);
  const reference = new Map<string, string[]>();
  await pool(inWindow, 5, async (a) => {
    const fixes = fixesInWindow(a, releases);
    const fixV = new Set(fixes.map((f) => f.version));
    const near = new Set<string>();
    for (const f of fixes) {
      const lineRel = order.filter((v) => releaseLine(v) === f.line);
      const i = lineRel.indexOf(f.version);
      for (const v of lineRel.slice(Math.max(0, i - 3), i + 4)) near.add(v);
    }
    const ids = new Set([a.id, ...a.aliases.map((x) => x.toUpperCase())]);
    const named = recs.filter((r) => [...advisoryIds(recText(r))].some((x) => ids.has(x)) || (r.advisories ?? []).some((x) => x.id === a.id));
    const exact = recs.filter((r) => r.releases.some((x) => fixV.has(x.version)));
    const close = recs.filter((r) => isSecurity(r) && r.releases.some((x) => near.has(x.version)));
    const cands = [...new Set([...named, ...exact, ...close])].slice(0, 60);
    if (!cands.length) return reference.set(a.id, []);
    const show = (r: Rec) =>
      `- ${r.id}: ${r.subject}; releases ${[...new Set(r.releases.map((x) => x.version))].join(", ")}; ${r.summary} Evidence: ${r.evidence.filter((e) => e.kind !== "advisory").slice(0, 3).map((e) => `"${e.quote.slice(0, 300)}"`).join(" | ")}`;
    const prompt = REF.replace("%TECH%", t.name)
      .replace("%ID%", a.id)
      .replace("%ALIASES%", a.aliases.join(", ") || "no CVE")
      .replace("%SEV%", a.severity ?? "unknown")
      .replace("%SUMMARY%", a.summary)
      .replace("%RANGES%", a.affected.map((x) => `${npmName(x.component)} ${x.range}${x.patched ? ` (patched ${x.patched})` : ""}`).join("; "))
      .replace("%DESC%", (desc.get(a.id) ?? "").replace(/\s+/g, " ").slice(0, 900))
      .replace("%RECORDS%", cands.sort((x, y) => x.id.localeCompare(y.id)).map(show).join("\n"));
    const ok = new Set(cands.map((r) => r.id));
    const ans = await codex(prompt, (text) => {
      const v = parseJson(text, "object") as { records?: unknown } | undefined;
      if (!v || !Array.isArray(v.records) || !v.records.every((x) => typeof x === "string" && ok.has(x))) return undefined;
      return v.records as string[];
    });
    reference.set(a.id, ans ?? []);
  });
  data[tech] = { advisories, inWindow, releases, recs, reference };
}

// ---- (a) and (b), per advisory and fixed line ----
interface Unit {
  tech: string;
  id: string;
  line: string;
  patched: string;
  status: "exact" | "late" | "missing" | "unmapped";
  wrong: string[];
}
const units: Unit[] = [];
const securityLines: Record<string, { total: number; mapped: number; unmapped: string[] }> = {};
for (const tech of TECHS) {
  const d = data[tech]!;
  const byId = new Map(d.recs.map((r) => [r.id, r]));
  const affectedAny = (a: Advisory, v: string) => a.affected.some((x) => inRange(v, x.range));
  for (const a of d.inWindow) {
    const mapped = (d.reference.get(a.id) ?? []).map((id) => byId.get(id)!).filter(Boolean);
    const lineOf = lineFnOf(tech);
    for (const f of fixesInWindow(a, d.releases, lineOf)) {
      const onLine = mapped.flatMap((r) => r.releases.filter((x) => lineOf(x.version) === f.line).map((x) => ({ r, v: x.version })));
      const wrong = [...new Set(onLine.filter((x) => affectedAny(a, x.v)).map((x) => `${x.r.id}@${x.v}`))];
      const good = onLine.filter((x) => isSecurity(x.r) && !affectedAny(a, x.v));
      const status = !mapped.length ? "unmapped" : good.some((x) => x.v === f.version) ? "exact" : good.length ? "late" : "missing";
      units.push({ tech, id: a.id, line: f.line, patched: f.version, status, wrong });
    }
  }
  const mappedIds = new Set([...d.reference.values()].flat());
  const sec = d.recs.filter(isSecurity);
  securityLines[tech] = { total: sec.length, mapped: sec.filter((r) => mappedIds.has(r.id)).length, unmapped: sec.filter((r) => !mappedIds.has(r.id)).map((r) => r.id) };
}

// ---- (c) the digest of each dogfood repository ----
function installed(repo: string): Map<string, string> {
  const out = new Map<string, string>();
  const dirs = [join(E2E, repo, "repo"), join(E2E, repo, "repo", "backend")];
  for (const d of dirs) {
    let pj: Record<string, Record<string, string>>;
    try {
      pj = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
    } catch {
      continue;
    }
    let lock: { packages?: Record<string, { version?: string }> } = {};
    try {
      lock = JSON.parse(readFileSync(join(d, "package-lock.json"), "utf8"));
    } catch {
      // No lockfile: the range floor.
    }
    for (const [name, spec] of Object.entries({ ...pj.dependencies, ...pj.devDependencies })) {
      const v = lock.packages?.[`node_modules/${name}`]?.version ?? /\d+\.\d+\.\d+/.exec(spec)?.[0];
      if (v && (!out.has(name) || semverCmp(v, out.get(name)!) < 0)) out.set(name, v);
    }
  }
  return out;
}
const digest: Record<string, unknown> = {};
for (const repo of ["next-prisma-app", "nest-prisma-api"]) {
  const inst = installed(repo);
  const text = readFileSync(join(digestDir, `${repo}.txt`), "utf8");
  const truth = new Set<string>();
  const detail: string[] = [];
  for (const tech of TECHS) {
    const d = data[tech]!;
    const target = d.releases.map((r) => r.version).sort(semverCmp).at(-1)!;
    for (const a of d.advisories) {
      for (const comp of new Set(a.affected.map((x) => x.component))) {
        const v = inst.get(npmName(comp));
        if (v && affects(a, comp, v) && !affects(a, comp, target)) {
          truth.add(a.id);
          detail.push(`${a.id} ${npmName(comp)} ${v} → ${target}`);
          break;
        }
      }
    }
  }
  const lines = text.split("\n").filter((l) => /^\s+security:/.test(l));
  const listed = new Set<string>();
  const lineRows = lines.map((l) => {
    const explicit = [...l.matchAll(/GHSA(?:-[a-z0-9]{4}){3}/gi)].map((m) => m[0].toUpperCase());
    const rid = /\[([^,\]]+),/.exec(l)?.[1];
    const tech = rid?.split(":")[0] ?? "";
    const viaRef = rid ? [...(data[tech]?.reference ?? new Map()).entries()].filter(([, rs]) => rs.includes(rid)).map(([id]) => id) : [];
    const ids = explicit.length ? explicit : viaRef;
    for (const id of ids) listed.add(id);
    return { line: l.trim().slice(0, 160), record: rid, advisories: ids, inTruth: ids.filter((x) => truth.has(x)) };
  });
  const tp = [...listed].filter((x) => truth.has(x));
  digest[repo] = {
    installed: Object.fromEntries([...inst].filter(([k]) => /^(next|prisma|@prisma\/client|@nestjs\/)/.test(k))),
    truth: [...truth].sort(),
    truthDetail: detail.sort(),
    lines: lineRows.length,
    linesWithTruthAdvisory: lineRows.filter((r) => r.inTruth.length).length,
    linesWithoutAdvisory: lineRows.filter((r) => !r.advisories.length).map((r) => r.line),
    linesWithOtherAdvisoryOnly: lineRows.filter((r) => r.advisories.length && !r.inTruth.length).map((r) => `${r.line} → ${r.advisories.join(",")}`),
    listed: [...listed].sort(),
    recall: truth.size ? tp.length / truth.size : 1,
    advisoryPrecision: listed.size ? tp.length / listed.size : 1,
    linePrecision: lineRows.length ? lineRows.filter((r) => r.inTruth.length).length / lineRows.length : 1,
    missed: [...truth].filter((x) => !listed.has(x)).sort(),
    extra: [...listed].filter((x) => !truth.has(x)).sort(),
  };
}

const count = (f: (u: Unit) => boolean) => units.filter(f).length;
const result = {
  advisories: Object.fromEntries(TECHS.map((t) => [t, { reviewed: data[t]!.advisories.length, inWindow: data[t]!.inWindow.length }])),
  a: {
    units: units.length,
    exact: count((u) => u.status === "exact"),
    late: count((u) => u.status === "late"),
    missing: count((u) => u.status === "missing"),
    unmapped: count((u) => u.status === "unmapped"),
    recall: (count((u) => u.status === "exact" || u.status === "late") / units.length),
  },
  b: { unitsWithWrongDate: count((u) => u.wrong.length > 0), wrong: units.filter((u) => u.wrong.length).map((u) => `${u.id} line ${u.line} (patched ${u.patched}): ${u.wrong.join(", ")}`) },
  securityRecords: securityLines,
  reference: Object.fromEntries(TECHS.map((t) => [t, Object.fromEntries([...data[t]!.reference].sort())])),
  units,
  digest,
  codex: codexStats,
};
writeAtomic(outPath, JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify({ advisories: result.advisories, a: result.a, b: result.b.unitsWithWrongDate, securityRecords: Object.fromEntries(TECHS.map((t) => [t, { total: securityLines[t]!.total, mapped: securityLines[t]!.mapped }])), digest: Object.fromEntries(Object.entries(digest).map(([k, v]) => { const x = v as Record<string, unknown>; return [k, { truth: (x.truth as string[]).length, lines: x.lines, linePrecision: x.linePrecision, recall: x.recall, advisoryPrecision: x.advisoryPrecision }]; })), codex: codexStats }));
