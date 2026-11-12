// Slice 19 part 2 (PREREG.md), step E fresh confirmation: scores fresh16.mts runs on slice 16's verdicts. Each request is
// decided as slice16/score16.mts decides it (match.ts pick re-implemented with the constants as parameters), at each
// candidate's slice 5 dev fit. Merges onto pairs slice 16 did not label are listed for reading (unaudited.json) and,
// once read, taken from adjudicated.json. No model calls.
//
//   cd central && npx tsx ../eval/select/slice19/fresh16-score.mts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advisoryIds, nearIdenticalQuote, shortRulesApply } from "../../../central/src/pipeline/match.ts";
import type { Classification } from "../../../central/src/pipeline/classify/adapter.ts";
import type { IncomingForGuard } from "../../../central/src/pipeline/match.ts";
import type { StoredRecord } from "../../../central/src/pipeline/store.ts";

type V = "SAME" | "DIFFERENT" | "UNSURE";
interface Params { same: number; cross: number; quote: number }
const TECHS = ["nx-808e5281", "langchain-core-a4216c71", "openvino-502d9770", "astro-71c9db18"];
const SELECT = join(import.meta.dirname, "..");
const OUT = join(SELECT, "out", "slice19");
const ADJ = join(import.meta.dirname, "adjudicated.json");
const verdicts = (JSON.parse(readFileSync(join(SELECT, "slice16", "verdicts.json"), "utf8")) as { verdicts: Record<string, V> }).verdicts;
const adjudicated: Record<string, V> = existsSync(ADJ) ? (JSON.parse(readFileSync(ADJ, "utf8")) as { verdicts: Record<string, V> }).verdicts : {};
// PREREG part 2: each candidate at its slice 5 dev fit.
const ARMS: Record<string, { run: string; P: Params }> = {
  luna: { run: "luna-F8", P: { same: 0.82, cross: 0.97, quote: 1.01 } },
  snap: { run: "subq-1.2-F4", P: { same: 0.61, cross: 0.93, quote: 0.95 } },
};

interface Req { key: string; cands: StoredRecord[]; guardInc: IncomingForGuard; incoming: { kind?: "release_notes" | "upgrade_guide" } }
const items: Array<{ id: string; tech: string; req: Req; hasSame: boolean }> = [];
for (const t of TECHS) {
  const all = JSON.parse(readFileSync(join(SELECT, "out", "slice16", `${t}-requests.json`), "utf8")) as Record<string, Req>;
  for (const r of Object.values(all)) {
    if (!shortRulesApply(r.incoming, r.cands) || !r.cands.length) continue;
    items.push({ id: `${t}|${r.key}`, tech: t, req: r, hasSame: r.cands.some((c) => verdicts[`${t}|${r.key}|${c.id}`] === "SAME") });
  }
}

function decide(r: Req, ans: Classification | null | undefined, P: Params): string | undefined {
  let best: { id: string; p: number } | undefined;
  r.cands.forEach((c, i) => {
    const p = ans?.answers[`same_c${i + 1}`]?.probabilities.yes ?? 0;
    if (p < P.same) return;
    const inc = r.guardInc;
    if (inc.breaking && !c.breaking) return;
    const ia = advisoryIds(`${inc.quote} ${inc.summary}`), ca = advisoryIds(`${c.evidence.map((e) => e.quote).join(" ")} ${c.summary}`);
    if (ia.size && ca.size && ![...ia].some((x) => ca.has(x))) return;
    const kind = inc.kind ?? "release_notes";
    const same = c.evidence.filter((e) => (e.kind ?? "release_notes") === kind);
    if (!same.length ? p < P.cross : p < P.quote && !same.some((e) => nearIdenticalQuote(inc.quote, e.quote))) return;
    if (!best || p > best.p) best = { id: c.id, p };
  });
  return best?.id;
}
const binom = (k: number, n: number) => { let s = 0, c = 1; for (let i = 0; i <= k; i++) { s += c; c = (c * (n - i)) / (i + 1); } return s / 2 ** n; };
const mcnemar = (b: number, c: number) => (b + c ? Math.min(1, 2 * binom(Math.min(b, c), b + c)) : 1);
function cp(k: number, n: number): [number, number] {
  const cdf = (x: number, p: number) => { let s = 0, t = (1 - p) ** n; for (let i = 0; i <= x; i++) { s += t; t *= ((n - i) / (i + 1)) * (p / (1 - p)); } return s; };
  const solve = (f: (p: number) => boolean) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m)) lo = m; else hi = m; } return lo; };
  return [k ? solve((p) => 1 - cdf(k - 1, p) < 0.025) : 0, k === n ? 1 : solve((p) => cdf(k, p) > 0.025)];
}

const unaudited: Record<string, { incoming: unknown; candidate: unknown; arms: string[] }> = {};
const rows: Record<string, Array<{ merged?: string; v?: V; recalled: boolean }>> = {};
const res: Record<string, unknown> = {};
for (const [name, { run, P }] of Object.entries(ARMS)) {
  const ans = JSON.parse(readFileSync(join(OUT, "runs", run, "answers.json"), "utf8")) as Record<string, Classification | null>;
  rows[name] = items.map((it) => {
    const m = decide(it.req, ans[it.id], P);
    const k = m ? `${it.id}|${m}` : "";
    const v = m ? verdicts[k] ?? adjudicated[k] : undefined;
    if (m && !v) {
      const c = it.req.cands.find((x) => x.id === m)!;
      (unaudited[k] ??= { incoming: { summary: it.req.guardInc.summary, quote: it.req.guardInc.quote, version: it.req.guardInc.version }, candidate: { subject: c.subject, summary: c.summary, quotes: c.evidence.map((e) => e.quote) }, arms: [] }).arms.push(name);
    }
    return { merged: m, v, recalled: v === "SAME" };
  });
  const m = rows[name].filter((r) => r.merged);
  const D = m.filter((r) => r.v === "DIFFERENT").length, U = m.filter((r) => r.v === "UNSURE").length, X = m.filter((r) => !r.v).length;
  const same = items.filter((it) => it.hasSame);
  const rec = items.filter((it, i) => it.hasSame && rows[name]![i]!.recalled).length;
  // PREREG: an unread merge counts as DIFFERENT.
  const bad = D + X + 0.5 * U;
  res[name] = { constants: P, answered: Object.values(ans).filter(Boolean).length, merges: m.length, D, U, unread: X, false_per_100: m.length ? (100 * bad) / m.length : 0, ci_95_counting_unsure_whole: cp(D + U + X, m.length).map((x) => 100 * x), same_items: same.length, recalled: rec, recall: rec / same.length };
}
const pairs = items.map((it, i) => [it, rows.luna![i]!, rows.snap![i]!] as const).filter(([it]) => it.hasSame);
const b = pairs.filter(([, x, y]) => x.recalled && !y.recalled).length, c = pairs.filter(([, x, y]) => !x.recalled && y.recalled).length;
const out = { requests_short: items.length, arms: res, snap_vs_luna: { recall_luna_only: b, recall_snap_only: c, recall_mcnemar_p: mcnemar(b, c), recall_diff_pts: (100 * (c - b)) / pairs.length }, unaudited: Object.keys(unaudited).length };
writeFileSync(join(OUT, "fresh16-summary.json"), JSON.stringify(out, null, 1) + "\n");
writeFileSync(join(OUT, "unaudited.json"), JSON.stringify(unaudited, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1));
