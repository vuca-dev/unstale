// Slice 5 scorer (PREREG.md): fits each candidate's constants on DEV, scores HELD-OUT once, compares with J1.
// No model calls. match.ts `pick` is re-implemented with the constants as parameters; the guard pieces are match.ts's
// own exports (advisoryIds, nearIdenticalQuote, sameLineage), so the guarded decision equals the pipeline's when the
// constants equal thresholds.ts (checked below on the cache run).
//
//   cd central && npx tsx ../eval/select/slice5/score5.mts [--adjudicated ../eval/select/slice5/adjudicated.json]
//   --rules: the "Judge rules compression" arms (M8, T8) against J1; writes *-rules.json.
//   --judge2: the "Judge 2" arms (PREREG.md) against J1 instead of the slice 5 candidates; writes *-judge2.json.
//   --base <id>: compares against that candidate instead of J1.
//   --subq <arm>: adds that arm answered by SubQ Snap (judge2.mts --cand subq), e.g. --rules --subq M8 --base M8:
//     Snap against Jev on the pipeline's own wording.
//   --subq-tag T: the SubQ runs of judge2.mts --subq-model subq-snap-T (with a second held-out run, -r2, if present).
//   --quote Q: fit with QUOTE_GUARD_BELOW fixed at Q (slice 15).
//   --floor F: the "Question floor" arm (PREREG.md): M8, Q8 (judge2.mts --arm Q8 --floor F) and M8 with the floor
//     applied to its own answers (no calls); use with --base M8 --fixed 0.87,0.87,0.95. Writes *-floor.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { advisoryIds, nearIdenticalQuote, sameLineage, pick } = await import("../../../central/src/pipeline/match.ts");
const { CROSS_SAME_P, SAME_P } = await import("../../../central/src/pipeline/thresholds.ts");
import type { Classification } from "../../../central/src/pipeline/classify/adapter.ts";
import type { IncomingForGuard } from "../../../central/src/pipeline/match.ts";
import type { StoredRecord } from "../../../central/src/pipeline/store.ts";

const { values: a } = parseArgs({ options: { adjudicated: { type: "string" }, unaudited: { type: "string" }, judge2: { type: "boolean", default: false }, rules: { type: "boolean", default: false }, clef: { type: "string" }, subq: { type: "string" }, "subq-tag": { type: "string" }, floor: { type: "string" }, base: { type: "string", default: "J1" }, fixed: { type: "string" }, quote: { type: "string" } } });
const OUT5 = join(import.meta.dirname, "..", "out", "slice5");
const D = JSON.parse(readFileSync(join(OUT5, "units.json"), "utf8")) as {
  units: Array<{ set: string; n: number; tech: string; key: string; candidate: string; index: number; p_audit: number; verdict: V; cross: boolean; split: "dev" | "heldout"; req: string; cands: StoredRecord[]; guardInc: IncomingForGuard }>;
};
type V = "SAME" | "DIFFERENT" | "UNSURE";
const R: Record<string, number> = { within: 1072, "guides:dev": 94, nuxt: 794, "guides:heldout": 73 };
/** New verdicts for merges no audit read (PREREG "Unaudited merges"), keyed `${set}|${key}|${candidate}`. */
const adj: Record<string, V> = a.adjudicated && existsSync(a.adjudicated) ? JSON.parse(readFileSync(a.adjudicated, "utf8")) : {};

// ---- Items: one judge request per incoming item, with its audited pairs ----
interface Item { set: string; split: "dev" | "heldout"; key: string; req: string; cands: StoredRecord[]; inc: IncomingForGuard; verdicts: Map<string, V>; hasSame: boolean }
const items = new Map<string, Item>();
for (const u of D.units) {
  const id = `${u.set}|${u.key}`;
  const it = items.get(id) ?? { set: u.set, split: u.split, key: u.key, req: u.req, cands: u.cands, inc: u.guardInc, verdicts: new Map(), hasSame: false };
  it.verdicts.set(u.candidate, u.verdict);
  it.hasSame ||= u.verdict === "SAME";
  items.set(id, it);
}

interface Params { same: number; cross: number; quote: number; guards: boolean }
const PIPELINE: Params = { same: SAME_P, cross: CROSS_SAME_P, quote: 0.95, guards: true };

/** match.ts guard with the constants as parameters (lineage never applies in these sets: PREREG). */
const flagsMemo = new Map<string, { hard: boolean; sameKind: boolean; near: boolean }>();
function flags(inc: IncomingForGuard, c: StoredRecord, memo: string) {
  let f = flagsMemo.get(memo);
  if (f) return f;
  const ia = advisoryIds(`${inc.quote} ${inc.summary}`);
  const ca = advisoryIds(`${c.evidence.map((e) => e.quote).join(" ")} ${c.summary}`);
  const hard = (inc.breaking && !c.breaking) || (ia.size > 0 && ca.size > 0 && ![...ia].some((x) => ca.has(x)));
  if (sameLineage(inc, c)) throw new Error("lineage case: not expected in these sets");
  const kind = inc.kind ?? "release_notes";
  const same = c.evidence.filter((e) => (e.kind ?? "release_notes") === kind);
  f = { hard, sameKind: same.length > 0, near: same.some((e) => nearIdenticalQuote(inc.quote, e.quote)) };
  flagsMemo.set(memo, f);
  return f;
}
function guardP(inc: IncomingForGuard, c: StoredRecord, p: number, P: Params, memo: string): boolean {
  const f = flags(inc, c, memo);
  if (f.hard) return true;
  if (!f.sameKind) return p < P.cross;
  return p < P.quote && !f.near;
}
function decide(it: Item, ans: Classification | null | undefined, P: Params, taken?: Set<string>): string | undefined {
  if (!ans) return undefined;
  let best: { id: string; p: number } | undefined;
  it.cands.forEach((c, i) => {
    if (taken?.has(c.id)) return;
    const p = ans.answers[`same_c${i + 1}`]?.probabilities.yes ?? 0;
    if (p < P.same) return;
    if (P.guards && guardP(it.inc, c, p, P, `${it.set}|${it.key}|${c.id}`)) return;
    if (!best || p > best.p) best = { id: c.id, p };
  });
  return best?.id;
}

type Answers = Record<string, Classification | null>;
/** Answer-by-id arms (one `same` choice over c1..cK and none) as per-candidate yes/no: reading A p_yes(cN) = p(cN);
 * reading B as A, but the most probable candidate gets 1 − p(none). */
function fromId(ans: Answers, reading: string): Answers {
  const out: Answers = {};
  for (const [k, c] of Object.entries(ans)) {
    const q = c?.answers.same;
    if (!c || !q) { out[k] = c ?? null; continue; }
    const ids = Object.keys(q.probabilities).filter((o) => o !== "none");
    const top = ids.reduce((b, x) => (q.probabilities[x]! > q.probabilities[b]! ? x : b), ids[0]!);
    const answers: Classification["answers"] = {};
    for (const id of ids) {
      const p = reading === "B" && id === top ? 1 - (q.probabilities.none ?? 0) : q.probabilities[id]!;
      answers[`same_${id}`] = { choice: p >= 0.5 ? "yes" : "no", confidence: Math.max(p, 1 - p), probabilities: { yes: p, no: 1 - p } };
    }
    out[k] = { ...c, answers };
  }
  return out;
}
/** A run's answers with the questions of candidates retrieved below the floor removed (floor.mts --scores). */
function belowFloor(ans: Answers, floor: number): Answers {
  const scores = JSON.parse(readFileSync(join(OUT5, "floor-scores.json"), "utf8")) as Record<string, number[]>;
  return Object.fromEntries(Object.entries(ans).map(([k, c]) => [k, c && { ...c, answers: Object.fromEntries(Object.entries(c.answers).filter(([q]) => scores[k]![Number(q.slice("same_c".length)) - 1]! >= floor)) }]));
}
const load = (run: string): Answers => {
  const [name, reading] = run.split("#");
  const raw = JSON.parse(readFileSync(join(OUT5, "runs", name!, "answers.json"), "utf8")) as Answers;
  if (reading?.startsWith("floor=")) return belowFloor(raw, Number(reading.slice("floor=".length)));
  return reading ? fromId(raw, reading) : raw;
};

interface Row { item: Item; merged?: string; v?: V | "UNAUDITED" | "ADJ_SAME" | "ADJ_DIFFERENT" | "ADJ_UNSURE"; recalled: boolean }
/** Guides set: ingest's snapshot exclusion across one guide (a record that took an item of this guide is not a candidate
 * for the next item), applied in key order as eval/guides/rule_eval.py does; the requests were built without it. */
const keyorder = (k: string) => k.split(/(\d+)/).map((x) => (/^\d+$/.test(x) ? x.padStart(8, "0") : x)).join("");
function rows(its: Item[], ans: Answers, P: Params): Row[] {
  const taken = new Map<string, Set<string>>();
  const order = [...its].sort((x, y) => (x.set === "guides" && y.set === "guides" ? keyorder(x.key).localeCompare(keyorder(y.key)) : 0));
  const byItem = new Map<Item, Row>();
  for (const item of order) {
    const doc = item.set === "guides" ? item.key.split("#")[0]! : "";
    const t = item.set === "guides" ? (taken.get(doc) ?? taken.set(doc, new Set()).get(doc)!) : undefined;
    const merged = decide(item, ans[item.req], P, t);
    if (merged && t) t.add(merged);
    let v: Row["v"];
    if (merged) {
      const audited = item.verdicts.get(merged);
      const k = `${item.set}|${item.key}|${merged}`;
      v = audited ?? (adj[k] ? (`ADJ_${adj[k]}` as Row["v"]) : "UNAUDITED");
    }
    byItem.set(item, { item, merged, v, recalled: !!merged && item.verdicts.get(merged) === "SAME" });
  }
  return its.map((i) => byItem.get(i)!);
}
interface Metrics { items: number; merges: number; S: number; D: number; U: number; unaudited: number; adjS: number; adjD: number; adjU: number; false_audited: number; false_adj: number; false_bound: number; ci_bound: [number, number]; same_items: number; recalled: number; recall: number; duplicates: number; R: number; dup_per_100: number; answered: number }
function metrics(rs: Row[], ans: Answers): Metrics {
  const m = rs.filter((r) => r.merged);
  const c = (x: string) => m.filter((r) => r.v === x).length;
  const [S, Dd, U, un, aS, aD, aU] = ["SAME", "DIFFERENT", "UNSURE", "UNAUDITED", "ADJ_SAME", "ADJ_DIFFERENT", "ADJ_UNSURE"].map(c) as number[];
  const auditedMerges = S! + Dd! + U!;
  const fa = auditedMerges ? (100 * (Dd! + 0.5 * U!)) / auditedMerges : 0;
  const fadj = m.length ? (100 * (Dd! + aD! + 0.5 * (U! + aU!) + un!)) / m.length : 0; // unadjudicated stay as DIFFERENT
  const fb = m.length ? (100 * (Dd! + 0.5 * U! + un! + aS! + aD! + aU!)) / m.length : 0;
  const sameItems = rs.filter((r) => r.item.hasSame);
  const rec = sameItems.filter((r) => r.recalled).length;
  const Rn = [...new Set(rs.map((r) => (r.item.set === "guides" ? `guides:${r.item.split}` : r.item.set)))].reduce((s, k) => s + R[k]!, 0);
  return {
    items: rs.length, merges: m.length, S: S!, D: Dd!, U: U!, unaudited: un!, adjS: aS!, adjD: aD!, adjU: aU!,
    false_audited: fa, false_adj: fadj, false_bound: fb, ci_bound: exactCI(Dd! + un! + aS! + aD! + aU! + U!, m.length).map((x) => 100 * x) as [number, number],
    same_items: sameItems.length, recalled: rec, recall: sameItems.length ? rec / sameItems.length : 0,
    duplicates: sameItems.length - rec, R: Rn, dup_per_100: (100 * (sameItems.length - rec)) / Rn,
    answered: [...new Set(rs.map((r) => r.item.req))].filter((k) => ans[k]).length,
  };
}

// ---- Stats ----
function lbeta(x: number, y: number) { return lgamma(x) + lgamma(y) - lgamma(x + y); }
function lgamma(z: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const c of g) s += c / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
const binom = (k: number, n: number, p: number) => Math.exp(lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p));
function binCdf(k: number, n: number, p: number) { let s = 0; for (let i = 0; i <= k; i++) s += binom(i, n, p); return s; }
/** Clopper–Pearson 95% interval for k of n (counts UNSURE as a whole event: conservative). */
function exactCI(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const solve = (f: (p: number) => number) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; } return (lo + hi) / 2; };
  const lower = k === 0 ? 0 : solve((p) => 1 - binCdf(k - 1, n, p) < 0.025 ? 1 : -1);
  const upper = k === n ? 1 : solve((p) => binCdf(k, n, p) > 0.025 ? 1 : -1);
  return [lower, upper];
}
void lbeta;
/** Exact two-sided McNemar p on discordant counts b (A only) and c (B only). */
function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (!n) return 1;
  return Math.min(1, 2 * binCdf(Math.min(b, c), n, 0.5));
}
function bootstrapDiff(x: boolean[], y: boolean[], B = 10000): [number, number] {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const n = x.length, ds: number[] = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) { const j = Math.floor(rnd() * n); s += (y[j] ? 1 : 0) - (x[j] ? 1 : 0); } ds.push(s / n); }
  ds.sort((p, q) => p - q);
  return [ds[Math.floor(0.025 * B)]!, ds[Math.floor(0.975 * B)]!];
}

// ---- Fitting on DEV ----
function fit(dev: Item[], ans: Answers, grid: number[]): { P: Params; m: Metrics } {
  // --quote q: QUOTE_GUARD_BELOW held at q during the fit (it is shared with request kinds these sets do not cover).
  const quotes = a.quote ? [Number(a.quote)] : [0.9, 0.95, 0.99, 1.01];
  let best: { P: Params; m: Metrics; ok: boolean } | undefined;
  const better = (x: { m: Metrics; ok: boolean; P: Params }, y: typeof best) => {
    if (!y) return true;
    if (x.ok !== y.ok) return x.ok;
    if (!x.ok && x.m.false_bound !== y.m.false_bound) return x.m.false_bound < y.m.false_bound;
    if (x.m.recalled !== y.m.recalled) return x.m.recalled > y.m.recalled;
    // ties: the more conservative constants
    return x.P.same + x.P.cross + x.P.quote > y.P.same + y.P.cross + y.P.quote;
  };
  for (const same of grid) for (const cross of grid.filter((g) => g >= same)) for (const quote of quotes) {
    const P = { same, cross, quote, guards: true };
    const m = metrics(rows(dev, ans, P), ans); // dev: unaudited counted as DIFFERENT (false_bound)
    const cand = { P, m, ok: m.false_bound <= 1.0 };
    if (better(cand, best)) best = cand;
  }
  return { P: best!.P, m: best!.m };
}

// ---- Candidates ----
interface Cand { id: string; name: string; dev: string; held: string[]; grid?: "prob" | "obs"; readings?: string[]; K?: number }
const J2: Cand[] = [
  { id: "J1", name: "Jev fresh run 1 (= F8)", dev: "jev-dev", held: ["jev-heldout-r1"], K: 8 },
  ...["F4", "O8", "O4", "O2", "O1"].map((arm) => ({ id: arm, name: arm, dev: `j2-${arm}-dev`, held: [`j2-${arm}-heldout`], K: Number(arm.slice(1)) })),
  ...["I8", "I4"].map((arm) => ({ id: arm, name: arm, dev: `j2-${arm}-dev`, held: [`j2-${arm}-heldout`], readings: ["A", "B"], K: Number(arm.slice(1)) })),
  ...(a.clef ? [{ id: `${a.clef}-clef`, name: `${a.clef} on Clef Flash`, dev: `j2-${a.clef}-dev-clef`, held: [`j2-${a.clef}-heldout-clef`], K: Number(a.clef.slice(1)), ...(a.clef.startsWith("I") ? { readings: ["A", "B"] } : {}) }] : []),
];
const C5: Cand[] = [
  { id: "J0", name: "Jev (audit answers, the pipeline's cache)", dev: "cache-dev", held: ["cache-heldout"] },
  { id: "J1", name: "Jev fresh run 1", dev: "jev-dev", held: ["jev-heldout-r1"] },
  { id: "J2", name: "Jev fresh run 2", dev: "jev-dev", held: ["jev-heldout-r2"] },
  { id: "G20", name: "gpt-oss-20b", dev: "vercel_openai_gpt-oss-20b-dev", held: ["vercel_openai_gpt-oss-20b-heldout"] },
  { id: "Q", name: "qwen3.8-flash", dev: "vercel_alibaba_qwen3.8-flash-dev", held: ["vercel_alibaba_qwen3.8-flash-heldout"] },
  { id: "DS", name: "deepseek-v4-flash", dev: "vercel_deepseek_deepseek-v4-flash-dev", held: ["vercel_deepseek_deepseek-v4-flash-heldout"] },
  { id: "L", name: "Luna (codex)", dev: "codex-dev", held: ["codex-heldout"] },
  { id: "EMB", name: "qwen3-embedding-0.6b cosine", dev: "embed_alibaba_qwen3-embedding-0.6b-dev", held: ["embed_alibaba_qwen3-embedding-0.6b-heldout"], grid: "obs" },
];
// --rules: "Judge rules compression" (PREREG.md), J1 against the compressed-rule arms; writes *-rules.json.
const JR: Cand[] = [J2[0]!, ...["M8", "T8"].map((arm) => ({ id: arm, name: arm, dev: `j2-${arm}-dev`, held: [`j2-${arm}-heldout`], K: 8 }))];
// --floor: "Question floor" (PREREG.md).
const QF: Cand[] = a.floor ? [
  { id: "M8", name: "M8 (production)", dev: "j2-M8-dev", held: ["j2-M8-heldout"], K: 8 },
  { id: "Q8", name: `Q8: M8 questions at retrieval score >= ${a.floor}`, dev: "j2-Q8-dev", held: ["j2-Q8-heldout"], K: 8 },
  { id: "M8floor", name: `M8's own answers below ${a.floor} removed (no calls)`, dev: `j2-M8-dev#floor=${a.floor}`, held: [`j2-M8-heldout#floor=${a.floor}`], K: 8 },
] : [];
const ST = a["subq-tag"] ? `-${a["subq-tag"]}` : "";
const SUBQ: Cand[] = a.subq ? [{ id: `${a.subq}-subq${ST}`, name: `${a.subq} on SubQ Snap${ST}`, dev: `j2-${a.subq}-dev-subq${ST}`, held: [`j2-${a.subq}-heldout-subq${ST}`, ...(ST ? [`j2-${a.subq}-heldout-subq${ST}-r2`] : [])], K: Number(a.subq.slice(1)), ...(a.subq.startsWith("I") ? { readings: ["A", "B"] } : {}) }] : [];
const C = [...(a.floor ? QF : a.rules ? JR : a.judge2 ? J2 : C5), ...SUBQ];
const SUFFIX = (a.floor ? "-floor" : a.rules ? "-rules" : a.judge2 ? "-judge2" : "") + (a.subq ? `-subq-${a.subq}${ST}` : "") + (a.base !== "J1" ? `-vs-${a.base}` : "") + (a.fixed ? "-fixed" : "") + (a.quote ? `-quote${a.quote}` : "");
/** Descriptive only (not the pre-registered fit): every candidate scored at these constants, "same,cross,quote". */
const FIXED: Params | undefined = a.fixed ? (([same, cross, quote]) => ({ same: same!, cross: cross!, quote: quote!, guards: true }))(a.fixed.split(",").map(Number)) : undefined;
const exists = (r: string) => existsSync(join(OUT5, "runs", r.split("#")[0]!, "answers.json"));
const all = [...items.values()];
const dev = all.filter((i) => i.split === "dev");
const held = all.filter((i) => i.split === "heldout");
const probGrid = Array.from({ length: 50 }, (_, i) => Math.round((0.5 + i * 0.01) * 100) / 100);
const out: Record<string, unknown> = {};
const fmt = (x: number, d = 1) => x.toFixed(d);
const heldRows: Record<string, Row[]> = {};

// Sanity: at the pipeline's constants, our pick equals match.ts pick on the cache answers.
if (exists("cache-heldout")) {
  const ans = { ...load("cache-dev"), ...load("cache-heldout") };
  let diff = 0;
  for (const it of all) if (it.set !== "guides" && decide(it, ans[it.req], PIPELINE) !== pick(it.cands, ans[it.req]!.answers, it.inc).id) diff++;
  console.log(`check: re-implemented pick vs match.ts pick at the pipeline's constants: ${diff} differences over ${all.length} items`);
}

for (const c of C) {
  if (!exists(c.dev)) { console.log(`${c.id}: dev run missing`); continue; }
  // Answer-by-id arms: the reading is chosen on DEV (floor met first, then recall, then fewer false merges).
  if (c.readings) {
    const fits = c.readings.map((rd) => ({ rd, f: fit(dev, load(`${c.dev}#${rd}`), probGrid) }));
    for (const x of fits) console.log(`${c.id} reading ${x.rd} dev: recall ${x.f.m.recalled}/${x.f.m.same_items} false_bound ${fmt(x.f.m.false_bound)}`);
    const okf = (m: Metrics) => m.false_bound <= 1.0;
    const best = fits.reduce((b, x) => (okf(x.f.m) !== okf(b.f.m) ? (okf(x.f.m) ? x : b) : x.f.m.recalled !== b.f.m.recalled ? (x.f.m.recalled > b.f.m.recalled ? x : b) : x.f.m.false_bound < b.f.m.false_bound ? x : b));
    c.dev = `${c.dev}#${best.rd}`;
    c.held = c.held.map((h) => `${h}#${best.rd}`);
    console.log(`${c.id}: reading ${best.rd} chosen on dev`);
  }
  const dans = load(c.dev);
  const obs = [...new Set(dev.flatMap((it) => Object.values(dans[it.req]?.answers ?? {}).map((x) => Math.round(x.probabilities.yes! * 1000) / 1000)))].filter((p) => p >= 0.3).sort();
  const obsGrid = [...new Set(obs.map((p) => Math.floor(p * 200) / 200))];
  const grid = c.grid === "obs" ? obsGrid : probGrid;
  const f0 = fit(dev, dans, grid);
  const f = FIXED ? { P: FIXED, m: metrics(rows(dev, dans, FIXED), dans) } : f0;
  const res: Record<string, unknown> = { fitted: f.P, dev: f.m, ...(c.K ? { K: c.K, certain_misses_heldout: held.filter((it) => it.hasSame && ![...it.verdicts].some(([cid, v]) => v === "SAME" && it.cands.findIndex((x) => x.id === cid) < c.K!)).length } : {}) };
  const pd = metrics(rows(dev, dans, PIPELINE), dans);
  console.log(`${c.id} dev fit: ${JSON.stringify(f.P)} recall ${f.m.recalled}/${f.m.same_items} merges ${f.m.merges} false_bound ${fmt(f.m.false_bound)} (D ${f.m.D} U ${f.m.U} unaudited ${f.m.unaudited}) | at pipeline constants: recall ${pd.recalled}/${pd.same_items} merges ${pd.merges} false_bound ${fmt(pd.false_bound)} (D ${pd.D} U ${pd.U} unaudited ${pd.unaudited}); answered ${f.m.answered}`);
  for (const h of c.held.filter(exists)) {
    const hans = load(h);
    const g = rows(held, hans, f.P);
    heldRows[`${c.id}`] = g;
    const jo = rows(held, hans, { ...f.P, guards: false });
    const pipe = rows(held, hans, PIPELINE);
    const per = (rs: Row[]) => Object.fromEntries(["nuxt", "guides"].map((s) => [s, metrics(rs.filter((r) => r.item.set === s), hans)]));
    res[h] = { guarded: metrics(g, hans), judge_only: metrics(jo, hans), at_pipeline_constants: metrics(pipe, hans), guarded_per_set: per(g), judge_only_per_set: per(jo), pipeline_per_set: per(pipe) };
  }
  out[c.id] = res;
}

// Never merge.
{
  const nm = held.map((item): Row => ({ item, recalled: false }));
  out.NM = { guarded: metrics(nm, {}) };
}

// Paired comparison with J1, or the --base candidate (held-out items).
const B0 = a.base!;
const VS = `vs_${B0}`;
const base = heldRows[B0];
if (base) {
  const cmp: Record<string, unknown> = {};
  for (const [id, rs] of Object.entries(heldRows)) {
    if (id === B0) continue;
    const same = base.map((r, i) => [r, rs[i]!] as const).filter(([r]) => r.item.hasSame);
    const b = same.filter(([x, y]) => x.recalled && !y.recalled).length;
    const c2 = same.filter(([x, y]) => !x.recalled && y.recalled).length;
    const isFalse = (r: Row) => !!r.merged && r.v !== "SAME" && r.v !== "ADJ_SAME";
    const fb = base.filter((r, i) => isFalse(r) && !isFalse(rs[i]!)).length;
    const fc = base.filter((r, i) => !isFalse(r) && isFalse(rs[i]!)).length;
    cmp[id] = { [`recall_${B0}_only`]: b, recall_cand_only: c2, recall_mcnemar_p: mcnemar(b, c2), recall_diff_ci95: bootstrapDiff(same.map(([x]) => x.recalled), same.map(([, y]) => y.recalled)), [`false_${B0}_only`]: fb, false_cand_only: fc, false_mcnemar_p: mcnemar(fb, fc) };
  }
  out[VS] = cmp;
}

// Unaudited held-out merges, for adjudication (blind: no model names).
const un = new Map<string, { set: string; key: string; candidate: string; incoming: unknown; record: unknown }>();
for (const rs of Object.values(heldRows)) for (const r of rs) if (r.v === "UNAUDITED") {
  const k = `${r.item.set}|${r.item.key}|${r.merged}`;
  const rec = r.item.cands.find((x) => x.id === r.merged)!;
  un.set(k, { set: r.item.set, key: r.item.key, candidate: r.merged!, incoming: { quote: r.item.inc.quote, summary: r.item.inc.summary, breaking: r.item.inc.breaking, kind: r.item.inc.kind, version: r.item.inc.version }, record: { id: rec.id, subject: rec.subject, facet: rec.facet, summary: rec.summary, breaking: rec.breaking, releases: rec.releases.map((x) => x.version), quotes: rec.evidence.map((e) => `[${e.kind ?? "release_notes"}] ${e.quote}`) } });
}
writeFileSync(join(OUT5, `unaudited${SUFFIX}.json`), JSON.stringify([...un.entries()].sort().map(([k, v]) => ({ k, ...v })), null, 1) + "\n");
writeFileSync(join(OUT5, `summary${SUFFIX}.json`), JSON.stringify(out, null, 1) + "\n");

// Compact table.
console.log("| cand | fitted same/cross/quote | dev recall, false/100 | HO merges | HO judge-only false/100 | HO guarded false/100 audited / adj / bound [95% CI bound] | unaudited | HO recall | dup/100 | answered |");
for (const [id, r] of Object.entries(out)) {
  if (id === VS) continue;
  if (id === "NM") { const m = (r as { guarded: Metrics }).guarded; console.log(`| NM | — | — | 0 | — | — | 0 | 0/${m.same_items} | ${fmt(m.dup_per_100)} | — |`); continue; }
  const x = r as Record<string, { guarded: Metrics; judge_only: Metrics } | Params | Metrics>;
  const P = x.fitted as Params, dv = x.dev as Metrics;
  for (const [h, v] of Object.entries(x)) {
    if (h === "fitted" || h === "dev" || h === "K" || h === "certain_misses_heldout") continue;
    const g = (v as { guarded: Metrics }).guarded, j = (v as { judge_only: Metrics }).judge_only;
    console.log(`| ${id} ${h} | ${P.same}/${P.cross}/${P.quote} | ${dv.recalled}/${dv.same_items}, ${fmt(dv.false_bound)} | ${g.merges} | ${fmt(j.false_bound)} (${j.D}D ${j.U}U ${j.unaudited}?) | ${fmt(g.false_audited)} / ${fmt(g.false_adj)} / ${fmt(g.false_bound)} [${fmt(g.ci_bound[0])}–${fmt(g.ci_bound[1])}] (${g.D}D ${g.U}U) | ${g.unaudited} | ${g.recalled}/${g.same_items} = ${fmt(100 * g.recall)}% | ${fmt(g.dup_per_100)} | ${g.answered} |`);
  }
}
if (out[VS]) console.log(JSON.stringify(out[VS], null, 1));
console.log(`unaudited held-out merges (all candidates): ${un.size} → ${join(OUT5, `unaudited${SUFFIX}.json`)}`);
