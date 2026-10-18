// Question floor (PREREG.md, "Question floor"): retrieval scores for the slice 5 judge requests, and the token share a
// floor on them saves. No model calls.
//
//   cd central && npx tsx ../eval/select/slice5/floor.mts --scores        # out/slice5/floor-scores.json
//   cd central && npx tsx ../eval/select/slice5/floor.mts --population next,prisma,nestjs [--store central-v1]
//   cd central && npx tsx ../eval/select/slice5/floor.mts --invariance dev|heldout   # Q8's p against M8's, per question
//
// --scores: match.ts `retrieve` re-run on each request's own incoming item (the stored extraction) and candidates (the
// records as they stood when it was asked); the scores must reproduce the request's candidate order, or it fails.
// --population: every judge request of a store, rebuilt by re-running ingest from empty and following the store's own
// decisions (each incoming merges where `ingested` says it did), so the candidate sets are ingest's own. Per floor:
// requests skipped, questions kept, Jev input saved (characters of the request JSON, M8 text), and the store's merges
// whose target falls below the floor. The floor applies only where the shorter rules do (match.ts shortRulesApply);
// other requests keep every question. The replay itself asks every candidate, as the store was built.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const OUT5 = join(import.meta.dirname, "..", "out", "slice5");
process.env.UNSTALE_CENTRAL_DIR = join(OUT5, "central");
const S = await import("../states.ts");
const { ingest, matchRequest, retrieve, shortRulesApply } = await import("../../../central/src/pipeline/match.ts");
const { interpret, recordState } = await import("../../../central/src/pipeline/classify/labels.ts");
const { compareVersions } = await import("../../../central/src/pipeline/util.ts");
import type { Incoming } from "../../../central/src/pipeline/extract.ts";
import type { StoredRecord, TechStore } from "../../../central/src/pipeline/store.ts";
import type { Questions } from "../../../central/src/pipeline/classify/adapter.ts";

const { values: a } = parseArgs({ options: { scores: { type: "boolean", default: false }, population: { type: "string" }, invariance: { type: "string" }, store: { type: "string", default: "central-v1" } } });
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
export const FLOORS = Array.from({ length: 201 }, (_, i) => i / 100);

/** The request a floor leaves: the state unchanged, only the questions of candidates scored at or above it. */
export function floored(questions: Questions, scores: number[], floor: number): Questions {
  return Object.fromEntries(Object.entries(questions).filter(([q]) => scores[Number(q.replace("same_c", "")) - 1]! >= floor));
}
const reqChars = (state: Record<string, unknown>, questions: Questions) => (Object.keys(questions).length ? JSON.stringify({ state, questions }).length : 0);

if (a.scores) {
  const D = readJson<{ units: Array<{ set: string; tech: string; key: string; req: string; cands: StoredRecord[] }> }>(join(OUT5, "units.json"));
  const exts = new Map<string, Map<string, Incoming>>();
  const incOf = (set: string, tech: string, key: string): Incoming | undefined => {
    const id = `${set}:${tech}`;
    if (!exts.has(id)) {
      const dirs = set === "within" ? ["central-v1"] : set === "nuxt" ? ["central-trust-nuxt"] : ["central", "central-pre-rematch"];
      exts.set(id, new Map(dirs.flatMap((d) => [...S.extractions(join(S.STORE, d), tech)])));
    }
    return exts.get(id)!.get(key);
  };
  const out: Record<string, number[]> = {};
  for (const u of D.units) {
    if (out[u.req]) continue;
    const inc = incOf(u.set, u.tech, u.key);
    if (!inc) throw new Error(`${u.set} ${u.key}: no stored extraction`);
    const got = retrieve(inc, u.cands);
    if (got.map((c) => c.id).join() !== u.cands.map((c) => c.id).join()) throw new Error(`${u.set} ${u.key}: retrieve does not reproduce the candidate order`);
    out[u.req] = got.map((c) => Math.round(c.score * 1e6) / 1e6);
  }
  writeFileSync(join(OUT5, "floor-scores.json"), JSON.stringify(out) + "\n");
  console.log(`${Object.keys(out).length} requests scored; every candidate order reproduced`);
}

if (a.population) {
  const central = join(S.STORE, a.store!);
  const rows: Array<{ tech: string; key: string; scores: number[]; short: boolean; target: number; stateChars: number; full: number; q: number[] }> = [];
  for (const tech of a.population.split(",")) {
    const real = readJson<TechStore>(join(central, "records", `${tech}.json`));
    const cache = join(central, "cache", "classifier");
    const q = S.buildTimeLabelQuestions();
    const order: Array<{ inc: Incoming; lab: ReturnType<typeof interpret> }> = [];
    let missing = 0;
    for (const inc of S.extractions(central, tech).values()) {
      if (!real.ingested[inc.key]) continue;
      const ans = S.cached(cache, recordState(S.techName(tech), inc), q);
      if (ans) order.push({ inc, lab: interpret(ans) });
      else missing++;
    }
    order.sort((x, y) => x.inc.date.localeCompare(y.inc.date) || compareVersions(x.inc.version, y.inc.version) || x.inc.key.localeCompare(y.inc.key, "en", { numeric: true }));
    const s: TechStore = { technology: tech, records: {}, ingested: {}, ...(real.releaseIndex ? { releaseIndex: real.releaseIndex } : {}) };
    let agree = 0;
    for (const { inc, lab } of order) {
      const cands = retrieve(inc, Object.values(s.records));
      const want = real.ingested[inc.key]!;
      if (cands.length) {
        const recs = cands.map((c) => s.records[c.id]!);
        const req = matchRequest(S.techName(tech), inc, lab.breaking, recs);
        const qs = Object.keys(req.questions);
        rows.push({ tech, key: inc.key, scores: cands.map((c) => c.score), short: shortRulesApply(inc, recs), target: cands.findIndex((c) => c.id === want), stateChars: JSON.stringify(req.state).length, full: reqChars(req.state, req.questions), q: qs.map((k) => JSON.stringify({ [k]: req.questions[k] }).length) });
      }
      // Follow the store: p 1 for the record it merged into, 0 elsewhere.
      const o = await ingest(s, S.techName(tech), S.components(tech), inc, lab, async (_st, qs) => ({
        classifier: "jev", model: "follow",
        answers: Object.fromEntries(Object.keys(qs).map((k) => { const y = cands[Number(k.slice("same_c".length)) - 1]?.id === want ? 1 : 0; return [k, { choice: y ? "yes" : "no", confidence: 1, probabilities: { yes: y, no: 1 - y } }]; })),
      }), { questionFloor: false });
      if (o.id === want) agree++;
    }
    console.log(`${tech}: ${order.length} incoming (${missing} without a cached label), ${agree} decisions reproduce the store's`);
  }
  const reqs = rows.length;
  const merges = rows.filter((r) => r.target >= 0);
  const fullChars = rows.reduce((t, r) => t + r.full, 0);
  console.log(`${reqs} judge requests, ${merges.length} merges; full (K = 8) ${rows.filter((r) => r.scores.length === 8).length}`);
  console.log("| floor | requests skipped | questions kept | Jev input saved | merges below floor |");
  for (const f of FLOORS) {
    let qs = 0, kept = 0, skipped = 0, chars = 0;
    for (const r of rows) {
      const k = r.scores.map((x, i) => (!r.short || x >= f ? i : -1)).filter((i) => i >= 0);
      qs += r.scores.length;
      kept += k.length;
      if (!k.length) skipped++;
      // The request JSON without the dropped questions (each question's JSON counted as its own share).
      else chars += r.full - r.q.reduce((t, n, i) => t + (k.includes(i) ? 0 : n), 0);
    }
    const lost = merges.filter((r) => r.short && r.scores[r.target]! < f).length;
    if (Math.round(f * 100) % 5 === 0) console.log(`| ${f.toFixed(2)} | ${(100 * skipped / reqs).toFixed(1)}% | ${(100 * kept / qs).toFixed(1)}% | ${(100 * (1 - chars / fullChars)).toFixed(1)}% | ${lost} |`);
  }
  writeFileSync(join(OUT5, `floor-population-${a.store}.json`), JSON.stringify(rows) + "\n");
}

if (a.invariance) {
  type Ans = Record<string, { answers: Record<string, { probabilities: { yes: number } }> } | null>;
  const run = (id: string) => readJson<Ans>(join(OUT5, "runs", id, "answers.json"));
  const pair = (x: Ans, y: Ans) => {
    const d: number[] = [];
    for (const [k, c] of Object.entries(x)) for (const [q, v] of Object.entries(c?.answers ?? {})) { const w = y[k]?.answers[q]; if (w) d.push(Math.abs(v.probabilities.yes - w.probabilities.yes)); }
    d.sort((p, q) => p - q);
    const at = (f: number) => d[Math.min(d.length - 1, Math.floor(f * d.length))]!;
    return { questions: d.length, mean: d.reduce((t, x) => t + x, 0) / d.length, identical: d.filter((x) => x === 0).length / d.length, p95: at(0.95), max: d.at(-1)! };
  };
  console.log(JSON.stringify({ noise_J1_r1_vs_r2: pair(run("jev-heldout-r1"), run("jev-heldout-r2")), [`Q8_vs_M8_${a.invariance}`]: pair(run(`j2-Q8-${a.invariance}`), run(`j2-M8-${a.invariance}`)) }, null, 1));
}
