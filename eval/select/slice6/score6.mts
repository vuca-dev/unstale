// Slice 6 scorer (PREREG.md): agreement of the shared design (`shared`) and of a fresh per-package replicate (`rep`)
// with production's per-package records (`base`), pair by pair (one pair = one guide unit × one package). No model calls.
//
//   cd central && npx tsx ../eval/select/slice6/score6.mts --state <central dir> --split dev|heldout
//
// Records are matched one to one as slice 3d matched them (run3d.mts): grounded quotes whose spans overlap in the folded
// guide text, else the same subject after case folding. Labels are compared on matched records. Bootstrap: 2,000
// resamples of pairs, seed 20261020; a label CI resamples pairs and takes their matched records.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a } = parseArgs({ options: { state: { type: "string" }, split: { type: "string" } } });
process.env.UNSTALE_CENTRAL_DIR = a.state!;
const { loadTechnologies, sharedUnits } = await import("./common.mts");
import type { Incoming } from "../../../central/src/pipeline/extract.ts";

type Lab = { change_type: string; surface: string; breaking: boolean; benefit: string[] | null } | null;
type Rec = Incoming & { labels: Lab };
interface Row { unit: string; tech: string; failed: number; incoming: Rec[] }
const OUT = join(SELECT, "out", "slice6", a.split!);
const load = (arm: string): Map<string, Row> => {
  const f = join(OUT, arm, "pairs.jsonl");
  const m = new Map<string, Row>();
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as Row;
    m.set(`${r.unit}\t${r.tech}`, r);
  }
  return m;
};
const SPLITS = JSON.parse(readFileSync(join(import.meta.dirname, "splits.json"), "utf8")) as Record<string, string[]>;
const techs = loadTechnologies(join(a.state!, "onboarding", "jobs"));
const units = sharedUnits(join(a.state!, "guides"), techs).filter((u) => SPLITS[a.split!]!.some((p) => u.url.startsWith(p)));
const notesOf = new Map(units.map((u) => [u.id, u.members[0]!.note.notes]));
const base = load("base"), rep = load("rep"), shared = load("shared");

const norm = (s: string): string => s.replace(/[`*_\\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
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
/** Percentile CI of stat over pair resamples (stat gets the resampled pair indices). */
function boot(n: number, stat: (idx: number[]) => number): [number, number] {
  const rnd = mulberry32(SEED), v: number[] = [];
  for (let b = 0; b < REPS; b++) v.push(stat(Array.from({ length: n }, () => Math.floor(rnd() * n))));
  v.sort((x, y) => x - y);
  return [v[Math.floor(0.025 * REPS)]!, v[Math.floor(0.975 * REPS)]!];
}

interface PairStat { key: string; f1: number; m: number; nx: number; nb: number; jac: number[]; lab: Array<{ breaking: number; benefit: number; change_type: number; surface: number }>; failed: boolean }
function stats(arm: Map<string, Row>, keys: string[]): PairStat[] {
  return keys.map((k) => {
    const b = base.get(k)!, x = arm.get(k)!;
    const pairs = match(notesOf.get(b.unit)!, x.incoming, b.incoming);
    const nx = x.incoming.length, nb = b.incoming.length;
    const lab = pairs.filter(([p, q]) => p.labels && q.labels).map(([p, q]) => ({
      breaking: +(p.labels!.breaking === q.labels!.breaking),
      benefit: +(JSON.stringify([...(p.labels!.benefit ?? [])].sort()) === JSON.stringify([...(q.labels!.benefit ?? [])].sort())),
      change_type: +(p.labels!.change_type === q.labels!.change_type),
      surface: +(p.labels!.surface === q.labels!.surface),
    }));
    return { key: k, f1: nx + nb ? (2 * pairs.length) / (nx + nb) : 1, m: pairs.length, nx, nb, jac: pairs.map(([p, q]) => jaccard(p.terms, q.terms)), lab, failed: x.failed > 0 };
  });
}
const sum = (v: number[]) => v.reduce((s, x) => s + x, 0);
const mean = (v: number[]) => sum(v) / (v.length || 1);
const pct = (x: number) => (100 * x).toFixed(1);
const pooled = (s: PairStat[], idx: number[], f: (p: PairStat) => [number, number]) => {
  let n = 0, d = 0;
  for (const i of idx) { const [x, y] = f(s[i]!); n += x; d += y; }
  return d ? n / d : 1;
};
const labRate = (s: PairStat[], idx: number[], f: "breaking" | "benefit" | "change_type" | "surface") => {
  let n = 0, d = 0;
  for (const i of idx) for (const l of s[i]!.lab) { n += l[f]; d++; }
  return d ? n / d : 1;
};

const keys = [...base.keys()].filter((k) => rep.has(k) && shared.has(k)).sort();
if (!keys.length) throw new Error("no pair is in all three arms");
const R = stats(rep, keys), S = stats(shared, keys);
const all = keys.map((_, i) => i);
const metrics = {
  f1: (s: PairStat[], idx: number[]) => mean(idx.map((i) => s[i]!.f1)),
  recall: (s: PairStat[], idx: number[]) => pooled(s, idx, (p) => [p.m, p.nb]),
  precision: (s: PairStat[], idx: number[]) => pooled(s, idx, (p) => [p.m, p.nx]),
  terms_jaccard: (s: PairStat[], idx: number[]) => mean(idx.flatMap((i) => s[i]!.jac)),
  breaking_agree: (s: PairStat[], idx: number[]) => labRate(s, idx, "breaking"),
  benefit_agree: (s: PairStat[], idx: number[]) => labRate(s, idx, "benefit"),
  change_type_agree: (s: PairStat[], idx: number[]) => labRate(s, idx, "change_type"),
  surface_agree: (s: PairStat[], idx: number[]) => labRate(s, idx, "surface"),
};
const out: Record<string, unknown> = { split: a.split, pairs: keys.length, units: new Set(keys.map((k) => k.split("\t")[0])).size };
const lines: string[] = [`slice 6 ${a.split}: ${keys.length} pairs in ${out.units} units`, "", "| Metric | rep vs base | shared vs base | shared − rep (paired CI) |", "|---|---|---|---|"];
for (const [name, f] of Object.entries(metrics)) {
  const r = f(R, all), s = f(S, all);
  const [rl, rh] = boot(all.length, (idx) => f(R, idx));
  const [sl, sh] = boot(all.length, (idx) => f(S, idx));
  const [dl, dh] = boot(all.length, (idx) => f(S, idx) - f(R, idx));
  out[name] = { rep: r, rep_ci: [rl, rh], shared: s, shared_ci: [sl, sh], diff: s - r, diff_ci: [dl, dh] };
  lines.push(`| ${name} | ${pct(r)} (${pct(rl)}…${pct(rh)}) | ${pct(s)} (${pct(sl)}…${pct(sh)}) | ${(100 * (s - r)).toFixed(1)} (${(100 * dl).toFixed(1)}…${(100 * dh).toFixed(1)}) |`);
}
const recs = { base: sum(R.map((p) => p.nb)), rep: sum(R.map((p) => p.nx)), shared: sum(S.map((p) => p.nx)) };
const failed = { rep: R.filter((p) => p.failed).length, shared: S.filter((p) => p.failed).length };
const matched = { rep: sum(R.map((p) => p.lab.length)), shared: sum(S.map((p) => p.lab.length)) };
out.records = recs;
out.failed_pairs = failed;
out.label_matched = matched;
lines.push("", `records: base ${recs.base}, rep ${recs.rep} (${pct(recs.rep / recs.base - 1)}%), shared ${recs.shared} (${pct(recs.shared / recs.base - 1)}%)`);
lines.push(`failed pairs: rep ${failed.rep}, shared ${failed.shared} of ${keys.length}; labelled matched records: rep ${matched.rep}, shared ${matched.shared}`);
// Pre-registered rule (PREREG.md, slice 6).
const g = (k: string) => out[k] as { rep: number; shared: number; diff_ci: [number, number] };
const recDev = Math.abs(recs.shared / recs.base - 1), repDev = Math.abs(recs.rep / recs.base - 1);
const rule = {
  f1: g("f1").shared >= g("f1").rep - 0.03 && g("f1").diff_ci[1] >= 0,
  recall: g("recall").shared >= g("recall").rep - 0.05 && g("recall").diff_ci[1] >= 0,
  precision: g("precision").shared >= g("precision").rep - 0.05 && g("precision").diff_ci[1] >= 0,
  records: recDev <= Math.max(0.1, repDev + 0.05),
  terms_jaccard: g("terms_jaccard").shared >= g("terms_jaccard").rep - 0.05,
  breaking_agree: g("breaking_agree").shared >= g("breaking_agree").rep - 0.03 && g("breaking_agree").diff_ci[1] >= 0,
  benefit_agree: g("benefit_agree").shared >= g("benefit_agree").rep - 0.03 && g("benefit_agree").diff_ci[1] >= 0,
  failures: failed.shared <= Math.max(1, Math.floor(0.02 * keys.length)),
};
out.rule = rule;
out.pass = Object.values(rule).every(Boolean);
lines.push("", `rule: ${Object.entries(rule).map(([k, v]) => `${k} ${v ? "pass" : "FAIL"}`).join(", ")}`, `verdict: ${out.pass ? "PASS" : "FAIL"}`);
// Per pair, for reading.
lines.push("", "| Pair | base | rep (F1) | shared (F1) |", "|---|---|---|---|");
keys.forEach((k, i) => lines.push(`| ${k.replace("\t", " · ")} | ${R[i]!.nb} | ${R[i]!.nx} (${pct(R[i]!.f1)}) | ${S[i]!.nx} (${pct(S[i]!.f1)}) |`));
writeFileSync(join(OUT, "score.json"), JSON.stringify(out, null, 1) + "\n");
writeFileSync(join(OUT, "score.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
