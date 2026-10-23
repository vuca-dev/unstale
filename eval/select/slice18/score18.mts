// Slice 18 (PREREG.md): the lineage bar, re-deciding each request from its recorded judged list.
//
//   cd central && npx tsx ../eval/select/slice18/score18.mts --round 1|2
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { nearIdenticalQuote } from "../../../central/src/pipeline/match.ts";

const { values: a } = parseArgs({ options: { round: { type: "string", default: "1" } } });
const OUT17 = join(import.meta.dirname, "..", "out", "slice17");
const OUT = join(import.meta.dirname, "..", "out", "slice18");
const rj = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
type V = "SAME" | "DIFFERENT" | "UNSURE";
const adj: Record<string, V> = { ...rj<{ adjudicated: Record<string, V> }>(join(import.meta.dirname, "..", "slice17", "adjudicated.json")).adjudicated, ...rj<{ adjudicated: Record<string, V> }>(join(import.meta.dirname, "adjudicated.json")).adjudicated };
const V = new Map<string, V>();
for (const u of rj<Array<{ id: string; j1?: string; j2?: string }>>(join(OUT17, "lin2-units.json"))) {
  const v = adj[u.id] ?? (u.j1 && u.j1 === u.j2 ? (u.j1 === "same" ? "SAME" : "DIFFERENT") : undefined);
  if (!v) throw new Error(`no verdict for ${u.id}`);
  V.set(u.id, v);
}
interface J { id: string; p: number; outcome: string; lineage: boolean; docQuotes: string[] }
interface Req { tech: string; key: string; quote: string; judged: J[] }
const reqs = Object.values(rj<Record<string, Req>>(join(OUT, "requests.json")));
const DEV = new Set(["next", "nestjs", "prisma"]);
const split = { dev: reqs.filter((r) => DEV.has(r.tech)), heldout: reqs.filter((r) => !DEV.has(r.tech)) };
interface Arm { L: number; Q?: number }
const BLOCK = new Set(["guard:breaking", "guard:advisory", "guard:cross", "unasked"]);
function decide(r: Req, A: Arm): J | undefined {
  let best: J | undefined;
  for (const j of r.judged) {
    let ok: boolean;
    if (!j.lineage) ok = j.outcome === "same" || j.outcome === "not-best";
    else {
      ok = j.p >= Math.max(0.7, A.L) && !BLOCK.has(j.outcome);
      if (ok && A.Q !== undefined && j.p < A.Q && !j.docQuotes.some((q) => nearIdenticalQuote(r.quote, q))) ok = false;
    }
    if (ok && (!best || j.p > best.p)) best = j;
  }
  return best;
}
type Row = { merged?: V; lineageMerge: boolean; hasSame: boolean; recalled: boolean };
const rows = (rs: Req[], A: Arm): Row[] => rs.map((r) => {
  const m = decide(r, A);
  const v = m?.lineage ? V.get(`${r.tech}|${r.key}|${m.id}`) : undefined;
  return { merged: v, lineageMerge: !!m?.lineage, hasSame: r.judged.some((j) => j.lineage && V.get(`${r.tech}|${r.key}|${j.id}`) === "SAME"), recalled: v === "SAME" };
});
const binom = (k: number, n: number) => { let s = 0, c = 1; for (let i = 0; i <= k; i++) { s += c; c = (c * (n - i)) / (i + 1); } return s / 2 ** n; };
const mcnemar = (b: number, c: number) => (b + c ? Math.min(1, 2 * binom(Math.min(b, c), b + c)) : 1);
function cp(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const cdf = (x: number, p: number) => { let s = 0, t = (1 - p) ** n; for (let i = 0; i <= x; i++) { s += t; t *= ((n - i) / (i + 1)) * (p / (1 - p)); } return s; };
  const solve = (f: (p: number) => boolean) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m)) lo = m; else hi = m; } return lo; };
  return [k ? solve((p) => 1 - cdf(k - 1, p) < 0.025) : 0, k === n ? 1 : solve((p) => cdf(k, p) > 0.025)];
}
function metrics(rs: Row[]) {
  const m = rs.filter((r) => r.lineageMerge);
  const D = m.filter((r) => r.merged === "DIFFERENT").length, U = m.filter((r) => r.merged === "UNSURE").length;
  const s = rs.filter((r) => r.hasSame), rec = s.filter((r) => r.recalled).length;
  return { requests: rs.length, merges: m.length, D, U, false_per_100: m.length ? +((100 * (D + 0.5 * U)) / m.length).toFixed(2) : 0, ci95: cp(D + U, m.length).map((x) => +(100 * x).toFixed(1)), same_requests: s.length, recalled: rec, recall: s.length ? +(rec / s.length).toFixed(3) : null };
}
const vs = (x: Row[], y: Row[]) => { const s = x.map((r, i) => [r, y[i]!] as const).filter(([r]) => r.hasSame); const lost = s.filter(([p, q]) => p.recalled && !q.recalled).length, gained = s.filter(([p, q]) => !p.recalled && q.recalled).length; return { lost, gained, mcnemar_p: mcnemar(lost, gained) }; };

// Check: at 0.80 the re-decision reproduces production's.
let mismatch = 0;
for (const r of reqs) { const m = decide(r, { L: 0.8 }); const prod = r.judged.find((j) => j.outcome === "same"); if ((m?.id ?? null) !== (prod?.id ?? null)) mismatch++; }
const grid = Array.from({ length: 30 }, (_, i) => +(0.7 + i * 0.01).toFixed(2));
const arms: Arm[] = a.round === "2" ? grid.flatMap((L) => [0.85, 0.9, 0.95, 0.99, undefined].map((Q) => ({ L, ...(Q !== undefined ? { Q } : {}) }))) : grid.map((L) => ({ L }));
const scored = arms.map((A) => ({ A, m: metrics(rows(split.dev, A)) }));
const ok = (x: (typeof scored)[number]) => x.m.false_per_100 <= 1.0;
const higher = (x: Arm) => x.L + (x.Q ?? 1.0);
const fit = scored.reduce((b, x) => {
  if (ok(x) !== ok(b)) return ok(x) ? x : b;
  if (!ok(x) && x.m.false_per_100 !== b.m.false_per_100) return x.m.false_per_100 < b.m.false_per_100 ? x : b;
  if (x.m.recalled !== b.m.recalled) return x.m.recalled > b.m.recalled ? x : b;
  return higher(x.A) > higher(b.A) ? x : b;
});
const P: Arm = { L: 0.8 };
const out = {
  round: a.round, check_mismatch_at_080: mismatch, requests: reqs.length,
  dev: { production: metrics(rows(split.dev, P)), fitted: fit.A, fit: fit.m },
  heldout: { production: metrics(rows(split.heldout, P)), fitted: metrics(rows(split.heldout, fit.A)), vs_production: vs(rows(split.heldout, P), rows(split.heldout, fit.A)) },
  dev_curve: scored.filter((x) => x.A.Q === undefined).map((x) => ({ L: x.A.L, merges: x.m.merges, false: x.m.false_per_100, recall: x.m.recall })),
};
writeFileSync(join(OUT, `summary-round${a.round}.json`), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ ...out, dev_curve: undefined }, null, 1));
