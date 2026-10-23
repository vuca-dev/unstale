// Slice 16 (PREREG.md): the three arms (P, C, F) on the fresh set's short-rules requests, one look. Each request is
// re-decided as match.ts `pick` decides it, with the arm's constants (score5.mts's re-implementation: the breaking and
// advisory guards, the cross bar, the quote guard), on the run's own Jev 1.14 answers. Verdicts: verdicts.json.
//
//   cd central && npx tsx ../eval/select/slice16/score16.mts <tech>...
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advisoryIds, nearIdenticalQuote, pick, sameLineage, shortRulesApply, type IncomingForGuard } from "../../../central/src/pipeline/match.ts";
import type { Classification } from "../../../central/src/pipeline/classify/adapter.ts";
import type { StoredRecord } from "../../../central/src/pipeline/store.ts";

const techs = process.argv.slice(2);
const OUT = join(import.meta.dirname, "..", "out", "slice16");
type V = "SAME" | "DIFFERENT" | "UNSURE";
const verdicts = (JSON.parse(readFileSync(join(import.meta.dirname, "verdicts.json"), "utf8")) as { verdicts: Record<string, V> }).verdicts;
interface Req { key: string; tech: string; cands: StoredRecord[]; answer: Classification; guardInc: IncomingForGuard; incoming: { kind?: "release_notes" | "upgrade_guide" } }
interface Params { same: number; cross: number; quote: number }
const P0: Params = { same: 0.87, cross: 0.87, quote: 0.95 };
interface Item { id: string; req: Req; verdicts: Map<string, V>; hasSame: boolean }
const items: Item[] = [];
let checked = 0, mismatch = 0;
for (const tech of techs) {
  const reqs = JSON.parse(readFileSync(join(OUT, `${tech}-requests.json`), "utf8")) as Record<string, Req>;
  for (const r of Object.values(reqs)) {
    if (!shortRulesApply(r.incoming, r.cands)) continue;
    // The re-implementation must equal match.ts pick at production's constants.
    checked++;
    if ((decide(r, P0) ?? null) !== (pick(r.cands, r.answer.answers, r.guardInc).id ?? null)) mismatch++;
    const vs = new Map<string, V>();
    for (const c of r.cands) { const v = verdicts[`${tech}|${r.key}|${c.id}`]; if (v) vs.set(c.id, v); }
    items.push({ id: `${tech}|${r.key}`, req: r, verdicts: vs, hasSame: [...vs.values()].includes("SAME") });
  }
}
function decide(r: Req, P: Params): string | undefined {
  let best: { id: string; p: number } | undefined;
  r.cands.forEach((c, i) => {
    const p = r.answer.answers[`same_c${i + 1}`]?.probabilities.yes ?? 0;
    if (p < P.same) return;
    const inc = r.guardInc;
    if (inc.breaking && !c.breaking) return;
    const ia = advisoryIds(`${inc.quote} ${inc.summary}`), ca = advisoryIds(`${c.evidence.map((e) => e.quote).join(" ")} ${c.summary}`);
    if (ia.size && ca.size && ![...ia].some((x) => ca.has(x))) return;
    if (sameLineage(inc, c)) throw new Error("lineage under the short rules: not expected");
    const kind = inc.kind ?? "release_notes";
    const same = c.evidence.filter((e) => (e.kind ?? "release_notes") === kind);
    if (!same.length ? p < P.cross : p < P.quote && !same.some((e) => nearIdenticalQuote(inc.quote, e.quote))) return;
    if (!best || p > best.p) best = { id: c.id, p };
  });
  return best?.id;
}
const ARMS: Record<string, Params> = { P: P0, C: { same: 0.82, cross: 0.91, quote: 0.99 }, F: { same: 0.97, cross: 0.97, quote: 0.95 } };
const binom = (k: number, n: number) => { let s = 0, c = 1; for (let i = 0; i <= k; i++) { s += c; c = (c * (n - i)) / (i + 1); } return s / 2 ** n; };
const mcnemar = (b: number, c: number) => (b + c ? Math.min(1, 2 * binom(Math.min(b, c), b + c)) : 1);
function cp(k: number, n: number): [number, number] {
  const cdf = (x: number, p: number) => { let s = 0, t = (1 - p) ** n; for (let i = 0; i <= x; i++) { s += t; t *= ((n - i) / (i + 1)) * (p / (1 - p)); } return s; };
  const solve = (f: (p: number) => boolean) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m)) lo = m; else hi = m; } return lo; };
  return [k ? solve((p) => 1 - cdf(k - 1, p) < 0.025) : 0, k === n ? 1 : solve((p) => cdf(k, p) > 0.025)];
}
const res: Record<string, unknown> = {};
const rows: Record<string, Array<{ merged?: string; v?: V; recalled: boolean }>> = {};
for (const [name, P] of Object.entries(ARMS)) {
  rows[name] = items.map((it) => { const m = decide(it.req, P); const v = m ? it.verdicts.get(m) : undefined; if (m && !v) throw new Error(`${it.id} → ${m}: unaudited merge (p >= 0.5 pairs are all audited)`); return { merged: m, v, recalled: v === "SAME" }; });
  const m = rows[name].filter((r) => r.merged);
  const D = m.filter((r) => r.v === "DIFFERENT").length, U = m.filter((r) => r.v === "UNSURE").length;
  const same = items.map((it, i) => [it, rows[name]![i]!] as const).filter(([it]) => it.hasSame);
  const rec = same.filter(([, r]) => r.recalled).length;
  const ci = cp(D + U, m.length);
  res[name] = { constants: P, merges: m.length, D, U, false_per_100: m.length ? (100 * (D + 0.5 * U)) / m.length : 0, ci_95_counting_unsure_whole: ci.map((x) => 100 * x), same_items: same.length, recalled: rec, recall: rec / same.length };
}
for (const name of ["C", "F"]) {
  const pairs = items.map((it, i) => [it, rows.P![i]!, rows[name]![i]!] as const);
  const s = pairs.filter(([it]) => it.hasSame);
  const b = s.filter(([, x, y]) => x.recalled && !y.recalled).length, c = s.filter(([, x, y]) => !x.recalled && y.recalled).length;
  const isF = (r: { merged?: string; v?: V }) => !!r.merged && r.v !== "SAME";
  const fb = pairs.filter(([, x, y]) => isF(x) && !isF(y)).length, fc = pairs.filter(([, x, y]) => !isF(x) && isF(y)).length;
  (res[name] as Record<string, unknown>).vs_P = { recall_P_only: b, recall_arm_only: c, recall_mcnemar_p: mcnemar(b, c), recall_diff_pts: (100 * (c - b)) / s.length, false_P_only: fb, false_arm_only: fc, false_mcnemar_p: mcnemar(fb, fc) };
}
const out = { requests_short: items.length, pick_check: { checked, mismatch }, by_tech: Object.fromEntries(techs.map((t) => [t, items.filter((i) => i.id.startsWith(t + "|")).length])), arms: res };
writeFileSync(join(OUT, "summary16.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1));
