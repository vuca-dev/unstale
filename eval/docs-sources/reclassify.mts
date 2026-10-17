// Re-applies the current edit classifiers (the eval heuristic materiality.mts and the module's docs/materiality.ts) to a replay or Wayback result file in place, so a
// classifier change does not need a new replay.   npx tsx eval/docs-sources/reclassify.mts <result.json>...
import { readFileSync, writeFileSync } from "node:fs";
import { editKind } from "../../central/src/docs/materiality.ts";
import { noiseOf } from "./materiality.mts";

for (const f of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(f, "utf8"));
  for (const s of d.sections) {
    if (typeof s.hunks !== "string") continue;
    s.noise = noiseOf(s.hunks);
    if ("edit" in s) s.edit = editKind({ hunks: s.hunks });
  }
  writeFileSync(f, JSON.stringify(d, null, 1) + "\n");
  console.error(`${f}: ${d.sections.length} sections reclassified`);
}
