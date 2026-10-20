// Slice 12 scorer (PREREG.md): agreement of the design (`mm`) and of a fresh gpt-6-luna replicate (`rep`) with
// production (`base`), release by release. No model calls.
//
//   cd central && npx tsx ../eval/select/slice12/score12.mts --state <restored store>/central [--cand mm]
//
// Records are matched one to one as slices 3d and 6 did: grounded quotes whose spans overlap in the folded notes, else
// the same subject after case folding. Bootstrap: 2,000 resamples of releases, seed 20261020, percentile 95% CIs; the
// `mm − rep` CI is paired (same resampled releases).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a } = parseArgs({ options: { state: { type: "string" }, cand: { type: "string", default: "mm" } } });
process.env.UNSTALE_CENTRAL_DIR = a.state!;
const { loadTechnologies } = await import("../slice6/common.mts");
const { fetchReleases } = await import("../../../central/src/pipeline/fetch.ts");
import type { Incoming } from "../../../central/src/pipeline/extract.ts";

type Lab = { change_type: string; surface: string; breaking: boolean; benefit: string[] | null } | null;
type Rec = Incoming & { labels: Lab; e: { outcome: string } | null };
interface Row { tech: string; version: string; stratum: string; failed: number; incoming: Rec[] }
const OUT = join(SELECT, "out", "slice12");
const load = (arm: string): Map<string, Row> => {
  const f = join(OUT, arm, "releases.jsonl");
  const m = new Map<string, Row>();
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as Row;
    m.set(`${r.tech}\t${r.version}`, r);
  }
  return m;
};
const base = load("base"), rep = load("rep"), cand = load(a.cand!);
const techs = loadTechnologies(join(a.state!, "onboarding", "jobs"));
const notesOf = new Map<string, string>();
for (const k of base.keys()) {
  const [tech, version] = k.split("\t") as [string, string];
  const n = (await fetchReleases(techs.get(tech)!, { offline: true })).notes.find((x) => x.version === version)!;
  notesOf.set(k, n.notes);
}

const norm = (s: string): string => s.replace(/!?\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1").replace(/[`*_\\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
function match(notes: string, xs: Rec[], ys: Rec[]): Array<[Rec, Rec]> {
  const n = norm(notes);
  const span = (r: Rec): [number, number] | undefined => {
    const q = norm(r.quote);
    const i = q ? n.indexOf(q) : -1;
    return r.grounded && i >= 0 ? [i, i + q.length] : undefined;
  };
  const used = new Set<number>();
  const pairs: Array<[Rec, Rec]> = [];
  const left: Rec[] = [];
  for (const x of xs) {
    const sx = span(x);
    const j = sx ? ys.findIndex((y, k) => !used.has(k) && ((s) => !!s && s[0] < sx[1] && sx[0] < s[1])(span(y))) : -1;
    if (j >= 0) (used.add(j), pairs.push([x, ys[j]!]));
    else left.push(x);
  }
  for (const x of left) {
    const j = ys.findIndex((y, k) => !used.has(k) && y.subject.toLowerCase() === x.subject.toLowerCase());
    if (j >= 0) (used.add(j), pairs.push([x, ys[j]!]));
  }
  return pairs;
}
const jaccard = (x: string[], y: string[]) => {
  const A = new Set(x.map((s) => s.toLowerCase())), B = new Set(y.map((s) => s.toLowerCase()));
  const u = new Set([...A, ...B]).size;
  return u ? [...A].filter((v) => B.has(v)).length / u : 1;
};
function mulberry32(s: number) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20261020, REPS = 2000;
function boot(n: number, stat: (idx: number[]) => number): [number, number] {
  const rnd = mulberry32(SEED), v: number[] = [];
  for (let b = 0; b < REPS; b++) v.push(stat(Array.from({ length: n }, () => Math.floor(rnd() * n))));
  v.sort((x, y) => x - y);
  return [v[Math.floor(0.025 * REPS)]!, v[Math.floor(0.975 * REPS)]!];
}

const actionable = (l: Lab) => !!l && l.surface !== "runtime_internal";
interface Stat {
  key: string; stratum: string; f1: number; m: number; nx: number; nb: number;
  /** base records that are breaking / actionable (base labels), and how many of them are matched */
  bb: number; bm: number; ab: number; am: number;
  jac: number[];
  lab: Array<{ breaking: number; actionable: number; benefit: number; change_type: number }>;
  e: number[]; failed: boolean;
}
function stats(arm: Map<string, Row>, keys: string[]): Stat[] {
  return keys.map((k) => {
    const b = base.get(k)!, x = arm.get(k)!;
    const pairs = match(notesOf.get(k)!, x.incoming, b.incoming);
    const nx = x.incoming.length, nb = b.incoming.length;
    const lab = pairs.filter(([p, q]) => p.labels && q.labels).map(([p, q]) => ({
      breaking: +(p.labels!.breaking === q.labels!.breaking),
      actionable: +(actionable(p.labels) === actionable(q.labels)),
      benefit: +(JSON.stringify([...(p.labels!.benefit ?? [])].sort()) === JSON.stringify([...(q.labels!.benefit ?? [])].sort())),
      change_type: +(p.labels!.change_type === q.labels!.change_type),
    }));
    const e = pairs.filter(([p, q]) => p.e && q.e).map(([p, q]) => +(p.e!.outcome === q.e!.outcome));
    return {
      key: k, stratum: b.stratum, f1: nx + nb ? (2 * pairs.length) / (nx + nb) : 1, m: pairs.length, nx, nb,
      bb: b.incoming.filter((r) => r.labels?.breaking).length, bm: pairs.filter(([, q]) => q.labels?.breaking).length,
      ab: b.incoming.filter((r) => actionable(r.labels)).length, am: pairs.filter(([, q]) => actionable(q.labels)).length,
      jac: pairs.map(([p, q]) => jaccard(p.terms, q.terms)), lab, e, failed: x.failed > 0,
    };
  });
}
const sum = (v: number[]) => v.reduce((s, x) => s + x, 0);
const mean = (v: number[]) => sum(v) / (v.length || 1);
const pct = (x: number) => (100 * x).toFixed(1);
const pooled = (s: Stat[], idx: number[], f: (p: Stat) => [number, number]) => {
  let n = 0, d = 0;
  for (const i of idx) { const [x, y] = f(s[i]!); n += x; d += y; }
  return d ? n / d : 1;
};
const labRate = (s: Stat[], idx: number[], f: "breaking" | "actionable" | "benefit" | "change_type") => pooled(s, idx, (p) => [sum(p.lab.map((l) => l[f])), p.lab.length]);

const keys = [...base.keys()].filter((k) => rep.has(k) && cand.has(k)).sort();
if (!keys.length) throw new Error("no release is in all three arms");
const R = stats(rep, keys), C = stats(cand, keys);
const metrics: Record<string, (s: Stat[], idx: number[]) => number> = {
  recall: (s, idx) => pooled(s, idx, (p) => [p.m, p.nb]),
  breaking_recall: (s, idx) => pooled(s, idx, (p) => [p.bm, p.bb]),
  actionable_recall: (s, idx) => pooled(s, idx, (p) => [p.am, p.ab]),
  precision: (s, idx) => pooled(s, idx, (p) => [p.m, p.nx]),
  terms_jaccard: (s, idx) => mean(idx.flatMap((i) => s[i]!.jac)),
  d_breaking_agree: (s, idx) => labRate(s, idx, "breaking"),
  d_actionable_agree: (s, idx) => labRate(s, idx, "actionable"),
  e_agree: (s, idx) => pooled(s, idx, (p) => [sum(p.e), p.e.length]),
  f1: (s, idx) => mean(idx.map((i) => s[i]!.f1)),
  d_benefit_agree: (s, idx) => labRate(s, idx, "benefit"),
  d_change_type_agree: (s, idx) => labRate(s, idx, "change_type"),
};
const all = keys.map((_, i) => i);
const out: Record<string, unknown> = { cand: a.cand, releases: keys.length, technologies: new Set(keys.map((k) => k.split("\t")[0])).size };
const lines: string[] = [`slice 12: ${keys.length} releases, ${out.technologies} technologies`, "", `| Metric | rep vs base | ${a.cand} vs base | ${a.cand} − rep (paired CI) |`, "|---|---|---|---|"];
for (const [name, f] of Object.entries(metrics)) {
  const r = f(R, all), c = f(C, all);
  const [rl, rh] = boot(all.length, (idx) => f(R, idx));
  const [cl, ch] = boot(all.length, (idx) => f(C, idx));
  const [dl, dh] = boot(all.length, (idx) => f(C, idx) - f(R, idx));
  out[name] = { rep: r, rep_ci: [rl, rh], cand: c, cand_ci: [cl, ch], diff: c - r, diff_ci: [dl, dh] };
  lines.push(`| ${name} | ${pct(r)} (${pct(rl)}…${pct(rh)}) | ${pct(c)} (${pct(cl)}…${pct(ch)}) | ${(100 * (c - r)).toFixed(1)} (${(100 * dl).toFixed(1)}…${(100 * dh).toFixed(1)}) |`);
}
const recs = { base: sum(R.map((p) => p.nb)), rep: sum(R.map((p) => p.nx)), cand: sum(C.map((p) => p.nx)) };
const failed = { rep: R.filter((p) => p.failed).length, cand: C.filter((p) => p.failed).length };
const n = { base_breaking: sum(R.map((p) => p.bb)), base_actionable: sum(R.map((p) => p.ab)), d_pairs: { rep: sum(R.map((p) => p.lab.length)), cand: sum(C.map((p) => p.lab.length)) }, e_pairs: { rep: sum(R.map((p) => p.e.length)), cand: sum(C.map((p) => p.e.length)) } };
out.records = recs;
out.failed_releases = failed;
out.n = n;
lines.push("", `records: base ${recs.base}, rep ${recs.rep} (${pct(recs.rep / recs.base - 1)}%), ${a.cand} ${recs.cand} (${pct(recs.cand / recs.base - 1)}%)`);
lines.push(`base breaking ${n.base_breaking}, base actionable ${n.base_actionable}; matched pairs with labels rep ${n.d_pairs.rep}, ${a.cand} ${n.d_pairs.cand}; with E rep ${n.e_pairs.rep}, ${a.cand} ${n.e_pairs.cand}`);
lines.push(`failed releases: rep ${failed.rep}, ${a.cand} ${failed.cand} of ${keys.length}`);

// Pre-registered rule (PREREG.md).
const g = (k: string) => out[k] as { rep: number; cand: number; diff_ci: [number, number] };
const within = (k: string, margin: number) => g(k).cand >= g(k).rep - margin && g(k).diff_ci[1] >= 0;
const recDev = Math.abs(recs.cand / recs.base - 1), repDev = Math.abs(recs.rep / recs.base - 1);
const rule = {
  recall: within("recall", 0.05),
  breaking_recall: within("breaking_recall", 0.05),
  actionable_recall: within("actionable_recall", 0.05),
  precision: within("precision", 0.05),
  records: recDev <= Math.max(0.1, repDev + 0.05),
  terms_jaccard: g("terms_jaccard").cand >= g("terms_jaccard").rep - 0.05,
  d_breaking_agree: within("d_breaking_agree", 0.03),
  d_actionable_agree: within("d_actionable_agree", 0.03),
  e_agree: within("e_agree", 0.03),
  failures: failed.cand <= Math.max(1, Math.floor(0.02 * keys.length)),
};
out.rule = rule;
out.pass = Object.values(rule).every(Boolean);
lines.push("", `rule: ${Object.entries(rule).map(([k, v]) => `${k} ${v ? "pass" : "FAIL"}`).join(", ")}`, `verdict: ${out.pass ? "PASS" : "FAIL"}`);

// Per stratum (descriptive).
lines.push("", `| Stratum | Releases | Records base / rep / ${a.cand} | Recall rep / ${a.cand} | Precision rep / ${a.cand} | F1 rep / ${a.cand} |`, "|---|---|---|---|---|---|");
for (const st of [...new Set(R.map((p) => p.stratum))]) {
  const idx = all.filter((i) => R[i]!.stratum === st);
  const m = metrics;
  lines.push(`| ${st} | ${idx.length} | ${sum(idx.map((i) => R[i]!.nb))} / ${sum(idx.map((i) => R[i]!.nx))} / ${sum(idx.map((i) => C[i]!.nx))} | ${pct(m.recall!(R, idx))} / ${pct(m.recall!(C, idx))} | ${pct(m.precision!(R, idx))} / ${pct(m.precision!(C, idx))} | ${pct(m.f1!(R, idx))} / ${pct(m.f1!(C, idx))} |`);
}
// Which model answered the candidate's calls (its usage log).
const ulog = join(OUT, a.cand!, "central", "usage.jsonl");
if (existsSync(ulog)) {
  const u = readFileSync(ulog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const by: Record<string, number> = {};
  for (const x of u) if (x.api === "vercel") by[`${x.model} ${x.role ?? "-"}`] = (by[`${x.model} ${x.role ?? "-"}`] ?? 0) + 1;
  const fb: Record<string, number> = {};
  for (const x of u) if (x.event === "extract-fallback") fb[String(x.reason)] = (fb[String(x.reason)] ?? 0) + 1;
  out.calls = by;
  out.fallbacks = fb;
  lines.push("", `gateway calls by model and role: ${JSON.stringify(by)}; fallbacks by reason: ${JSON.stringify(fb)}`);
}
writeFileSync(join(OUT, `score-${a.cand}.json`), JSON.stringify(out, null, 1) + "\n");
writeFileSync(join(OUT, `score-${a.cand}.md`), lines.join("\n") + "\n");
console.log(lines.join("\n"));
