// Slice 8: the candidate's decisions on one split's chunks (no model calls). For each option set: chunks skipped, of
// them answered [] and answered with records, production records lost, and the step-A dollars of the skipped chunks.
//
//   cd central && npx tsx ../eval/select/slice8/fit.mts --split dev [--opts bump,sections,deps,markup] [--show A+]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { boilerplate, type SkipOptions } from "./skip.ts";
const { values: a } = parseArgs({ options: { split: { type: "string", default: "dev" }, opts: { type: "string" }, show: { type: "string" }, out: { type: "string" } } });
const OUT = join(import.meta.dirname, "..", "out", "slice8");
type Row = { id: number; tech: string; source: string; version: string; split: string; status: string; records?: number; dollars: number; phase: string; text: string };
const rows = readFileSync(join(OUT, "rows.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row).filter((r) => r.split === a.split);
const sets: Record<string, SkipOptions> = a.opts
  ? { [a.opts]: Object.fromEntries(a.opts.split(",").map((k) => [k, true])) }
  : {
      bump: { bump: true },
      "bump+sections": { bump: true, sections: true },
      "bump+sections+markup": { bump: true, sections: true, markup: true },
      "bump+sections+markup+deps": { bump: true, sections: true, markup: true, deps: true },
      "+bumps": { bump: true, sections: true, markup: true, deps: true, bumps: true },
      "+release+bumps": { bump: true, sections: true, markup: true, deps: true, release: true, bumps: true },
      "+pointers": { bump: true, sections: true, markup: true, deps: true, pointers: true },
      "+release": { bump: true, sections: true, markup: true, deps: true, release: true },
      "+chores": { bump: true, sections: true, markup: true, deps: true, chores: true },
      all: { bump: true, sections: true, markup: true, deps: true, bumps: true, pointers: true, release: true, chores: true },
    };
const records = rows.reduce((s, r) => s + (r.records ?? 0), 0);
const a0$ = rows.filter((r) => r.status === "A0").reduce((s, r) => s + r.dollars, 0);
console.log(`${a.split}: ${rows.length} chunks (${rows.filter((r) => r.status === "A0").length} answered []), ${records} records, step-A $${rows.reduce((s, r) => s + r.dollars, 0).toFixed(4)} ([] $${a0$.toFixed(4)})`);
console.log(`| Options | Skipped | of them [] | with records | Records lost | Lost % | [] $ saved | Share of [] $ |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const decisions: Record<string, number[]> = {};
for (const [name, o] of Object.entries(sets)) {
  const sk = rows.filter((r) => boilerplate(r.text, o));
  decisions[name] = sk.map((r) => r.id);
  const plus = sk.filter((r) => r.status === "A+");
  const lost = plus.reduce((s, r) => s + (r.records ?? 0), 0);
  const saved = sk.reduce((s, r) => s + r.dollars, 0);
  console.log(`| ${name} | ${sk.length} | ${sk.length - plus.length} | ${plus.length} | ${lost} | ${((100 * lost) / records).toFixed(3)} | $${saved.toFixed(4)} | ${((100 * saved) / a0$).toFixed(1)}% |`);
  if (a.show === "A+") for (const r of plus) console.log(`\n--- ${r.tech} ${r.version} (${r.records})\n${r.text.slice(0, 800)}`);
}
if (a.out) writeFileSync(a.out, JSON.stringify(decisions));
