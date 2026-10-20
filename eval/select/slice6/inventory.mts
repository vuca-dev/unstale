// Slice 6 inventory (no model calls): every shared guide unit, whether each member technology's two-call answers are in
// the production cache (the free baseline), and what in the extract prompt differs between members.
//
//   cd central && npx tsx ../eval/select/slice6/inventory.mts --state <central dir: guides/, onboarding/jobs/, cache/llm/>
import { parseArgs } from "node:util";
import { join } from "node:path";
const { values: a } = parseArgs({ options: { state: { type: "string" } } });
process.env.UNSTALE_CENTRAL_DIR = a.state!;
process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
process.env.UNSTALE_EXTRACT_EFFORT = "low";
const { loadTechnologies, sharedUnits, noNetwork } = await import("./common.mts");
const { releaseCached, extractRelease, chunk } = await import("../../../central/src/pipeline/extract.ts");
noNetwork();
const techs = loadTechnologies(join(a.state!, "onboarding", "jobs"));
const units = sharedUnits(join(a.state!, "guides"), techs);
let cached = 0, total = 0;
for (const u of units) {
  const parts = chunk(u.members[0]!.note.notes).length;
  console.log(`\n${u.id}: ${u.members.length} technologies, ${u.members[0]!.note.notes.length} chars, ${parts} chunks`);
  for (const m of u.members) {
    total++;
    const hit = releaseCached(m.tech, m.note);
    let recs = "";
    if (hit) {
      cached++;
      const r = await extractRelease(m.tech, m.note).catch((e: Error) => ({ incoming: [], failed: -1, err: e.message }));
      recs = `${r.incoming.length} records${r.failed ? ` (failed ${r.failed})` : ""}`;
    }
    console.log(`  ${hit ? "cached" : "MISS  "} ${m.tech.id.padEnd(44)} name=${JSON.stringify(m.tech.name)} v=${m.note.version} date=${m.note.date} ${recs}`);
  }
}
console.log(`\n${units.length} units, ${total} unit-technology pairs, ${cached} fully cached`);
