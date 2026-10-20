// Slice 9 runner: step D asked today's way (one request of eight questions per record) or grouped (grouped.ts), on
// slice 4's dev set or the held-out sets H1 / H2 (PREREG.md). Every run starts from its own empty cache.
//
//   cd central && npx tsx ../eval/select/slice9/run9.mts --arm base|g2|g4|… --split smoke|dev|heldout|heldout2 [--tag T]
//
// Output: out/slice9/runs/<arm>-<split>[-tag]/answers.json ({uid: Classification | null}) and meta.json (calls, Jev
// input tokens, dollars). Usage lines: out/slice9/usage.jsonl.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const OUT9 = join(SELECT, "out", "slice9");
process.env.UNSTALE_CENTRAL_DIR = join(OUT9, "central");
const { ClassifierCache } = await import("../../../central/src/pipeline/classify/adapter.ts");
const { labelQuestions, recordState } = await import("../../../central/src/pipeline/classify/labels.ts");
const { pool, sha256 } = await import("../../../central/src/pipeline/util.ts");
const { jevClassifier, jevStats } = await import("../jev.ts");
const { spendByProvider } = await import("../budget.ts");
const S = await import("../states.ts");
const G = await import("./grouped.ts");
import type { Classification } from "../../../central/src/pipeline/classify/adapter.ts";

const { values: a } = parseArgs({
  options: {
    arm: { type: "string", default: "base" },
    split: { type: "string", default: "smoke" },
    tag: { type: "string" },
    concurrency: { type: "string", default: "4" },
    cap: { type: "string", default: "0.9" },
  },
});
const USAGE = join(OUT9, "usage.jsonl");
const spent = spendByProvider(USAGE).jev?.dollars ?? 0;
if (spent > Number(a.cap)) throw new Error(`slice 9 Jev spend $${spent.toFixed(4)} > cap $${a.cap}`);
const runId = [a.arm, a.split, ...(a.tag ? [a.tag] : [])].join("-");
const runDir = join(OUT9, "runs", runId);

interface Unit {
  uid: string;
  tech: string;
  state: Record<string, unknown>;
}

/** Slice 4's dev set: the benefit units, and the breaking 241 where both reference judges agree. */
function devUnits(): Unit[] {
  const brk = join(homedir(), "ati-slice2", "results", "datamodel", "breaking");
  const judge = (arm: string) => {
    const out = new Map<string, boolean>();
    for (const f of readdirSync(join(brk, arm)).sort()) {
      const run = JSON.parse(readFileSync(join(brk, arm, f), "utf8")) as { unit: { rids: string[] }; answer: Record<string, { breaking?: unknown }> };
      run.unit.rids.forEach((rid, n) => {
        const v = run.answer[`r${n + 1}`];
        if (v && typeof v.breaking === "boolean") out.set(rid, v.breaking);
      });
    }
    return out;
  };
  const p = judge("pipeline");
  const r = judge("reference");
  const agreed = new Set([...p].filter(([k, v]) => r.get(k) === v).map(([k]) => k));
  return [
    ...S.benefitUnits().units.map((u) => ({ uid: `benefit:${u.id}`, tech: u.tech, state: u.state })),
    ...S.breakingUnits().units.filter((u) => agreed.has(u.id)).map((u) => ({ uid: `breaking:${u.id}`, tech: u.tech, state: u.state })),
  ];
}
function heldoutUnits(): Unit[] {
  const recs = JSON.parse(readFileSync(join(SELECT, "holdout", "classify", "records.json"), "utf8")).records as Array<{ id: string; technology: string; state: Record<string, unknown> }>;
  return recs.map((r) => ({ uid: `heldout:${r.id}`, tech: r.technology, state: r.state }));
}
function heldout2Units(): Unit[] {
  const d = JSON.parse(readFileSync(join(SELECT, "out", "slice4", "h2-units.json"), "utf8")) as { units: Array<{ id: string; name: string; incoming: never }> };
  return d.units.map((u) => ({ uid: u.id, tech: u.name, state: recordState(u.name, u.incoming) }));
}
let units = a.split === "heldout" ? heldoutUnits() : a.split === "heldout2" ? heldout2Units() : devUnits();
if (a.split === "smoke") units = units.filter((u) => u.tech === units[0]!.tech).slice(0, 8);

const cls = jevClassifier({ step: `slice9:${runId}`, usageLog: USAGE });
const cache = new ClassifierCache(join(OUT9, "cache", runId));
const ask = async (state: Record<string, unknown>, q: ReturnType<typeof labelQuestions>): Promise<Classification> => {
  const hit = cache.get(cls, state, q);
  if (hit) return hit;
  const r = await cls.classify(state, q);
  cache.put(cls, state, q, r);
  return r;
};
const answers: Record<string, Classification | null> = {};
const errors: string[] = [];
const t0 = Date.now();
if (a.arm === "base") {
  const q = labelQuestions();
  await pool(units, Number(a.concurrency), async (u) => {
    try {
      answers[u.uid] = await ask(u.state, q);
    } catch (e) {
      errors.push(`${u.uid}: ${e instanceof Error ? e.message : String(e)}`);
      answers[u.uid] = null;
    }
  });
} else {
  const v = G.VARIANTS[a.arm];
  if (!v) throw new Error(`unknown arm ${a.arm}`);
  const groups = G.groupUnits(units, (u) => u.tech, v.n);
  await pool(groups, Number(a.concurrency), async (g) => {
    try {
      const cs = await G.classifyGroup(cls, g.map((u) => u.state), v, (r) => ask(r.state, r.questions));
      g.forEach((u, i) => (answers[u.uid] = cs[i]!));
    } catch (e) {
      errors.push(`${g.map((u) => u.uid).join(",")}: ${e instanceof Error ? e.message : String(e)}`);
      for (const u of g) answers[u.uid] = null;
    }
  });
}
const answered = Object.values(answers).filter(Boolean).length;
const meta = {
  runId, arm: a.arm, split: a.split, units: units.length, answered, errors,
  calls: jevStats.calls, input_tokens: jevStats.input_tokens, dollars: jevStats.dollars,
  input_per_record: jevStats.input_tokens / units.length, calls_per_record: jevStats.calls / units.length,
  wall_s: (Date.now() - t0) / 1000, order: sha256(units.map((u) => u.uid).join("\n")),
};
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, "answers.json"), JSON.stringify(answers, null, 1) + "\n");
writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 1) + "\n");
console.log(JSON.stringify({ ...meta, errors: errors.slice(0, 5) }, null, 1));
console.log(`slice 9 Jev spend so far: $${(spendByProvider(USAGE).jev?.dollars ?? 0).toFixed(4)}`);
