// Slice 8 scorer (PREREG.md): the frozen candidate on one split against production (records lost) and against a
// fresh replicate's noise, plus the step-A dollars it saves at the production mix. No model calls.
//
//   cd central && npx tsx ../eval/select/slice8/score8.mts --split heldout [--noise heldout] [--days] [--impl frozen|central]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { boilerplate } from "./skip.ts";
import { FROZEN } from "./frozen.ts";
const { values: a } = parseArgs({ options: { split: { type: "string" }, noise: { type: "string" }, days: { type: "boolean" }, impl: { type: "string", default: "frozen" } } });
// --impl frozen: skip.ts with FROZEN (as registered); --impl central: the shipped contentFree (a strict subset, RESULTS.md).
const { contentFree } = await import("../../../central/src/pipeline/extract.ts");
const skips = (t: string): boolean => (a.impl === "central" ? !t.trim() || contentFree(t) : boilerplate(t, FROZEN));
const OUT = join(import.meta.dirname, "..", "out", "slice8");
type Row = { id: number; tech: string; split: string; status: string; records?: number; dollars: number; phase: string; at: string; text: string };
const all = readFileSync(join(OUT, "rows.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
const rows = all.filter((r) => r.split === a.split);
const rep = (set: string, split = a.split!) => {
  const f = join(OUT, "rep", `${split}-${set}.jsonl`);
  return new Map(existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; records: number | null }).map((x) => [x.id, x.records] as const) : []);
};

// Seeded resampling (mulberry32).
let s = 20261020;
const rnd = () => {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** Ratio sum(num)/sum(den) with a 95% percentile CI over 2,000 resamples of the items. */
function ratio(items: Array<[number, number]>): [number, number, number] {
  const r = (xs: Array<[number, number]>) => xs.reduce((p, x) => p + x[0], 0) / Math.max(1, xs.reduce((p, x) => p + x[1], 0));
  const bs: number[] = [];
  for (let b = 0; b < 2000; b++) bs.push(r(items.map(() => items[Math.floor(rnd() * items.length)]!)));
  bs.sort((x, y) => x - y);
  return [r(items), bs[49]!, bs[1949]!];
}
const pct = (x: number) => (100 * x).toFixed(2);

const skipped = rows.filter((r) => skips(r.text));
const records = rows.reduce((p, r) => p + (r.records ?? 0), 0);
// 1. Records lost against production, with a CI over chunks.
const lost = ratio(rows.map((r) => [skips(r.text) ? (r.records ?? 0) : 0, r.records ?? 0]));
// 2. Noise: production records in chunks a fresh replicate answered [] (whole-chunk loss), over the replicate's chunks.
const noiseSplit = a.noise ?? a.split!;
const ra = rep("aplus", noiseSplit);
const noiseRows = all.filter((r) => r.split === noiseSplit && r.status === "A+" && ra.has(r.id) && ra.get(r.id) !== null);
const noise = ratio(noiseRows.map((r) => [ra.get(r.id) === 0 ? r.records! : 0, r.records!]));
const flips = noiseRows.filter((r) => ra.get(r.id) === 0).length;
// 3. The replicate on the skipped chunks.
const rs = rep("skipped");
const rsRun = skipped.filter((r) => rs.has(r.id) && rs.get(r.id) !== null);
const rsHit = rsRun.filter((r) => (rs.get(r.id) ?? 0) > 0);
// 4. Dollars.
const saved = skipped.reduce((p, r) => p + r.dollars, 0);
const a0$ = rows.filter((r) => r.status === "A0").reduce((p, r) => p + r.dollars, 0);
const allA$ = rows.reduce((p, r) => p + r.dollars, 0);

console.log(`## ${a.split} (noise from ${noiseSplit})\n`);
console.log(`| Measure | Value |\n|---|---|`);
console.log(`| Chunks / answered [] / production records | ${rows.length} / ${rows.filter((r) => r.status === "A0").length} / ${records} |`);
console.log(`| Skipped chunks (of them answered []) | ${skipped.length} (${skipped.filter((r) => r.status === "A0").length}) |`);
console.log(`| Records lost vs production | ${skipped.reduce((p, r) => p + (r.records ?? 0), 0)} = ${pct(lost[0])}% (95% CI ${pct(lost[1])}…${pct(lost[2])}) |`);
console.log(`| Replicate noise: records in chunks a fresh call answered [] | ${pct(noise[0])}% (95% CI ${pct(noise[1])}…${pct(noise[2])}); ${flips} of ${noiseRows.length} chunks |`);
console.log(`| Replicate on skipped chunks: chunks with records | ${rsHit.length} of ${rsRun.length} (${rsHit.reduce((p, r) => p + (rs.get(r.id) ?? 0), 0)} records) |`);
console.log(`| Step-A $ saved | $${saved.toFixed(4)} of $${allA$.toFixed(4)} (${pct(saved / allA$)}%); of the [] $${a0$.toFixed(4)}: ${pct(saved / Math.max(a0$, 1e-12))}% |`);
const pass1 = lost[0] <= noise[0];
const pass2 = lost[0] <= 0.005;
console.log(`\nCondition 1 (lost ≤ replicate noise): ${pass1 ? "pass" : "FAIL"}; condition 2 (lost ≤ 0.5%): ${pass2 ? "pass" : "FAIL"}`);

// Saving at the production mix (--days, read at the held-out look): every chunk answered each day (all splits), by phase.
if (a.days) {
const byDay = new Map<string, { all: number; skip: number; mon: number; monSkip: number; monA0: number }>();
for (const r of all) {
  if (!r.at) continue;
  const d = r.at.slice(0, 10);
  const e = byDay.get(d) ?? { all: 0, skip: 0, mon: 0, monSkip: 0, monA0: 0 };
  const sk = skips(r.text);
  e.all += r.dollars;
  if (sk) e.skip += r.dollars;
  if (r.phase === "monitoring") {
    e.mon += r.dollars;
    if (sk) e.monSkip += r.dollars;
    if (r.status === "A0") e.monA0 += r.dollars;
  }
  byDay.set(d, e);
}
console.log(`\n| Day | Step-A $ (all phases) | Skipped $ | Monitoring step-A $ | Monitoring [] $ | Monitoring skipped $ |\n|---|---|---|---|---|---|`);
for (const [d, e] of [...byDay].sort()) console.log(`| ${d} | $${e.all.toFixed(4)} | $${e.skip.toFixed(4)} | $${e.mon.toFixed(4)} | $${e.monA0.toFixed(4)} | $${e.monSkip.toFixed(4)} |`);
}
