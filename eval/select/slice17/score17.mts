// Slice 17 (PREREG.md): one look at every set. Reference = the two judges where they agree, else adjudicated.json.
// ADV and DOCS: each request re-decided with each arm's constants (short-rules requests by the short constants, the
// rest by SAME_P / CROSS_SAME_P), as match.ts pick decides (score16.mts's re-implementation, plus the lineage bar).
// LIN: production's own decisions on its recorded answers. QG: the SAME share. SURF: Jev 1.14's surface against the
// reference, and the surface question's share of a step-D request.
//
//   cd central && UNSTALE_STORE=<side store 2> npx tsx ../eval/select/slice17/score17.mts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advisoryIds, nearIdenticalQuote, pick, sameLineage, shortRulesApply, type IncomingForGuard } from "../../../central/src/pipeline/match.ts";
import { labelQuestions, recordState } from "../../../central/src/pipeline/classify/labels.ts";
import type { Classification } from "../../../central/src/pipeline/classify/adapter.ts";
import type { StoredRecord } from "../../../central/src/pipeline/store.ts";
import type { Incoming } from "../../../central/src/pipeline/extract.ts";
import { centralDir } from "../../../central/src/pipeline/paths.ts";
import { techLocal } from "../../../central/src/state/client.ts";
import { readdirSync } from "node:fs";

const OUT = join(import.meta.dirname, "..", "out", "slice17");
const rj = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const adj = rj<{ adjudicated: Record<string, string> }>(join(import.meta.dirname, "adjudicated.json")).adjudicated;
type V = "SAME" | "DIFFERENT" | "UNSURE";
interface Unit { id: string; j1?: string; j2?: string; p?: number; outcome?: string; tech: string; key: string; candidate: string }
const verdict = (u: Unit): V | undefined => adj[u.id] as V | undefined ?? (u.j1 && u.j1 === u.j2 ? (u.j1 === "same" ? "SAME" : "DIFFERENT") : undefined);
const missing: string[] = [];
const verdicts = (set: string) => {
  const m = new Map<string, V>();
  for (const u of rj<Unit[]>(join(OUT, `${set}-units.json`))) { const v = verdict(u); if (v) m.set(u.id, v); else missing.push(`${set}:${u.id}`); }
  return m;
};

interface Params { same: number; cross: number; quote: number }
interface Arm { short: Params; other: Params; lineage: number }
const ARMS: Record<string, Arm> = {
  P: { short: { same: 0.87, cross: 0.87, quote: 0.95 }, other: { same: 0.7, cross: 0.85, quote: 0.95 }, lineage: 0.8 },
  C: { short: { same: 0.82, cross: 0.91, quote: 0.99 }, other: { same: 0.7, cross: 0.85, quote: 0.99 }, lineage: 0.8 },
  "C′": { short: { same: 0.82, cross: 0.91, quote: 0.99 }, other: { same: 0.7, cross: 0.85, quote: 0.95 }, lineage: 0.8 },
};
interface Req { key: string; tech: string; cands: StoredRecord[]; answer: Classification | null; guardInc: IncomingForGuard; incoming: { kind?: "release_notes" | "upgrade_guide" | "docs" | "advisory" } }
function decide(r: Req, A: Arm): string | undefined {
  if (!r.answer) return undefined;
  const P = shortRulesApply(r.incoming as never, r.cands) ? A.short : A.other;
  const inc = r.guardInc;
  let best: { id: string; p: number } | undefined;
  r.cands.forEach((c, i) => {
    const p = r.answer!.answers[`same_c${i + 1}`]?.probabilities.yes ?? 0;
    if (p < P.same) return;
    if (inc.breaking && !c.breaking) return;
    const ia = advisoryIds(`${inc.quote} ${inc.summary}`), ca = advisoryIds(`${c.evidence.map((e) => e.quote).join(" ")} ${c.summary}`);
    if (ia.size && ca.size && ![...ia].some((x) => ca.has(x))) return;
    if (sameLineage(inc, c)) { if (p < A.lineage) return; }
    else {
      const kind = inc.kind ?? "release_notes";
      const same = c.evidence.filter((e) => (e.kind ?? "release_notes") === kind);
      if (!same.length ? p < P.cross : p < P.quote && !same.some((e) => nearIdenticalQuote(inc.quote, e.quote))) return;
    }
    if (!best || p > best.p) best = { id: c.id, p };
  });
  return best?.id;
}
const binom = (k: number, n: number) => { let s = 0, c = 1; for (let i = 0; i <= k; i++) { s += c; c = (c * (n - i)) / (i + 1); } return s / 2 ** n; };
const mcnemar = (b: number, c: number) => (b + c ? Math.min(1, 2 * binom(Math.min(b, c), b + c)) : 1);
function cp(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const cdf = (x: number, p: number) => { let s = 0, t = (1 - p) ** n; for (let i = 0; i <= x; i++) { s += t; t *= ((n - i) / (i + 1)) * (p / (1 - p)); } return s; };
  const solve = (f: (p: number) => boolean) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m)) lo = m; else hi = m; } return lo; };
  return [k ? solve((p) => 1 - cdf(k - 1, p) < 0.025) : 0, k === n ? 1 : solve((p) => cdf(k, p) > 0.025)];
}
type Row = { merged?: string; v?: V; hasSame: boolean; recalled: boolean };
function metrics(rows: Row[]) {
  const m = rows.filter((r) => r.merged);
  const D = m.filter((r) => r.v === "DIFFERENT").length, U = m.filter((r) => r.v === "UNSURE").length;
  const s = rows.filter((r) => r.hasSame), rec = s.filter((r) => r.recalled).length;
  return { requests: rows.length, merges: m.length, D, U, false_per_100: m.length ? (100 * (D + 0.5 * U)) / m.length : 0, ci95_unsure_whole: cp(D + U, m.length).map((x) => +(100 * x).toFixed(1)), same_requests: s.length, recalled: rec, recall: s.length ? rec / s.length : null };
}
function vsP(a: Row[], b: Row[]) {
  const s = a.map((x, i) => [x, b[i]!] as const).filter(([x]) => x.hasSame);
  const lost = s.filter(([x, y]) => x.recalled && !y.recalled).length, gained = s.filter(([x, y]) => !x.recalled && y.recalled).length;
  const isF = (r: Row) => !!r.merged && r.v !== "SAME";
  const fl = a.filter((x, i) => isF(x) && !isF(b[i]!)).length, fg = a.filter((x, i) => !isF(x) && isF(b[i]!)).length;
  return { recall_lost: lost, recall_gained: gained, recall_mcnemar_p: mcnemar(lost, gained), false_removed: fl, false_added: fg, false_mcnemar_p: mcnemar(fl, fg) };
}
function scoreReqs(set: string, reqs: Req[]) {
  const V = verdicts(set);
  const out: Record<string, unknown> = {};
  const rows: Record<string, Row[]> = {};
  for (const [name, A] of Object.entries(ARMS)) {
    rows[name] = reqs.map((r) => {
      const merged = decide(r, A);
      const v = merged ? V.get(`${r.tech}|${r.key}|${merged}`) : undefined;
      if (merged && !v) missing.push(`${set}: merge into an unlabelled candidate ${r.tech}|${r.key}|${merged}`);
      return { merged, v, hasSame: r.cands.some((c) => V.get(`${r.tech}|${r.key}|${c.id}`) === "SAME"), recalled: v === "SAME" };
    });
    out[name] = metrics(rows[name]!);
  }
  for (const name of ["C", "C′"]) (out[name] as Record<string, unknown>).vs_P = vsP(rows.P!, rows[name]!);
  const checked = reqs.filter((r) => r.answer).length;
  const mismatch = reqs.filter((r) => r.answer && (decide(r, ARMS.P!) ?? null) !== (pick(r.cands, r.answer.answers, r.guardInc).id ?? null)).length;
  return { ...out, pick_check: { checked, mismatch } };
}

const res: Record<string, unknown> = {};
// ADV
const adv = Object.values(rj<Record<string, Req>>(join(OUT, "advisory-requests.json")));
if (existsSync(join(OUT, "adv-units.json"))) res.ADV = scoreReqs("adv", adv);
// DOCS
const sample = rj<{ docs: string[]; docs_population: number }>(join(OUT, "docs-sample.json"));
const all = new Map<string, Req>();
for (const t of new Set(sample.docs.map((x) => x.split("|")[0]!))) for (const r of Object.values(rj<Record<string, Req>>(join(OUT, `${t}-requests.json`)))) all.set(`${t}|${r.key}`, r);
if (existsSync(join(OUT, "docs-units.json"))) res.DOCS = { population: sample.docs_population, ...scoreReqs("docs", sample.docs.map((k) => all.get(k)!)) };
// LIN: production's decisions (outcome "same"), per request.
{
  const units = rj<Unit[]>(join(OUT, "lin-units.json"));
  const V = verdicts("lin");
  const byReq = new Map<string, Unit[]>();
  for (const u of units) byReq.set(`${u.tech}|${u.key}`, [...(byReq.get(`${u.tech}|${u.key}`) ?? []), u]);
  const rows: Row[] = [...byReq.values()].map((us) => { const m = us.find((u) => u.outcome === "same"); const v = m ? V.get(m.id) : undefined; return { merged: m?.candidate, v, hasSame: us.some((u) => V.get(u.id) === "SAME"), recalled: v === "SAME" }; });
  const pairs = units.map((u) => ({ v: V.get(u.id), p: u.p ?? 0 }));
  res.LIN = { production: metrics(rows), pairs: units.length, same_pairs: pairs.filter((x) => x.v === "SAME").length, same_pairs_below_bar: pairs.filter((x) => x.v === "SAME" && x.p < 0.8).length, different_pairs_at_or_above_bar: pairs.filter((x) => x.v !== "SAME" && x.p >= 0.8).length };
}
// QG
{
  const V = verdicts("qg");
  const vs = [...V.values()];
  res.QG = { pairs: vs.length, SAME: vs.filter((v) => v === "SAME").length, DIFFERENT: vs.filter((v) => v === "DIFFERENT").length, UNSURE: vs.filter((v) => v === "UNSURE").length, production_merges: 3903 };
}
// SURF
{
  const units = rj<Array<{ id: string; tech: string; key: string; jev: string; j1?: string; j2?: string }>>(join(OUT, "surf-units.json"));
  const ref = (u: (typeof units)[number]) => adj[`surf|${u.id}`] ?? (u.j1 === u.j2 ? u.j1 : undefined);
  const lab = units.map((u) => ({ jev: u.jev, ref: ref(u)! })).filter((x) => x.ref);
  const n = lab.length, ok = lab.filter((x) => x.jev === x.ref).length;
  const act = lab.filter((x) => (x.jev === "runtime_internal") === (x.ref === "runtime_internal")).length;
  const cfgRef = lab.filter((x) => x.ref === "configuration"), cfgJev = lab.filter((x) => x.jev === "configuration");
  const conf: Record<string, number> = {};
  for (const x of lab) if (x.jev !== x.ref) conf[`${x.ref}→${x.jev}`] = (conf[`${x.ref}→${x.jev}`] ?? 0) + 1;
  const dist = (k: "jev" | "ref") => lab.reduce((m, x) => ((m[x[k]] = (m[x[k]] ?? 0) + 1), m), {} as Record<string, number>);
  // The surface question's share of a step-D request (characters; Jev bills by tokens, which scale with them).
  const q = labelQuestions();
  const qSurface = JSON.stringify({ surface: q.surface }).length;
  let total = 0, cnt = 0;
  for (const u of units.slice(0, 130)) {
    const ex = join(centralDir(), "extractions", techLocal(u.tech));
    const inc = readdirSync(ex).flatMap((f) => rj<Incoming[]>(join(ex, f))).find((i) => i.key === u.key);
    const name = u.tech.replace(/-[0-9a-f]{8}$/, "");
    if (inc) { total += JSON.stringify({ state: recordState(name, inc), questions: q }).length; cnt++; }
  }
  const share = qSurface / (total / cnt);
  res.SURF = {
    n, accuracy: ok / n, accuracy_ci95: cp(ok, n).map((x) => +(100 * x).toFixed(1)), actionable_accuracy: act / n,
    configuration: { reference: cfgRef.length, jev: cfgJev.length, recall: cfgRef.length ? cfgRef.filter((x) => x.jev === "configuration").length / cfgRef.length : null, precision: cfgJev.length ? cfgJev.filter((x) => x.ref === "configuration").length / cfgJev.length : null },
    confusions: Object.fromEntries(Object.entries(conf).sort((a, b) => b[1] - a[1])), reference_distribution: dist("ref"), jev_distribution: dist("jev"),
    question_share_of_request: share, step_d_tech_year_usd: 0.0101, surface_tech_year_usd: 0.0101 * share,
  };
}
res.missing = missing;
writeFileSync(join(OUT, "summary17.json"), JSON.stringify(res, null, 1) + "\n");
console.log(JSON.stringify(res, null, 1));
