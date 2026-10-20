// Prints each member's cached per-technology records for one unit (no model calls).
import { parseArgs } from "node:util";
import { join } from "node:path";
const { values: a } = parseArgs({ options: { state: { type: "string" }, unit: { type: "string" } } });
process.env.UNSTALE_CENTRAL_DIR = a.state!;
process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
process.env.UNSTALE_EXTRACT_EFFORT = "low";
const { loadTechnologies, sharedUnits, noNetwork } = await import("./common.mts");
const { extractRelease } = await import("../../../central/src/pipeline/extract.ts");
noNetwork();
const techs = loadTechnologies(join(a.state!, "onboarding", "jobs"));
for (const u of sharedUnits(join(a.state!, "guides"), techs).filter((u) => u.id.includes(a.unit!))) {
  console.log(`\n## ${u.id}`);
  for (const m of u.members) {
    const r = await extractRelease(m.tech, m.note);
    console.log(`\n### ${m.tech.name} (${r.incoming.length})`);
    for (const i of r.incoming) console.log(`- [${i.section ?? ""}] ${i.subject}${i.facet ? "." + i.facet : ""}: ${i.summary.slice(0, 110)}`);
  }
}
