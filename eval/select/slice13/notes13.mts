// Writes each DEV release's notes to out/slice13/notes/<tech>@<version>.md (analysis only; no model calls).
//   cd central && npx tsx ../eval/select/slice13/notes13.mts --state <restored store>/central
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { values: a } = parseArgs({ options: { state: { type: "string" } } });
process.env.UNSTALE_CENTRAL_DIR = a.state!;
const { loadTechnologies } = await import("../slice6/common.mts");
const { fetchReleases } = await import("../../../central/src/pipeline/fetch.ts");
const { chunk } = await import("../../../central/src/pipeline/extract.ts");
const SET = JSON.parse(readFileSync(join(import.meta.dirname, "..", "slice12", "set.json"), "utf8")) as { releases: Array<{ tech: string; version: string }> };
const techs = loadTechnologies(join(a.state!, "onboarding", "jobs"));
const dir = join(import.meta.dirname, "..", "out", "slice13", "notes");
mkdirSync(dir, { recursive: true });
for (const r of SET.releases) {
  const n = (await fetchReleases(techs.get(r.tech)!, { offline: true })).notes.find((x) => x.version === r.version)!;
  const parts = chunk(n.notes);
  writeFileSync(join(dir, `${r.tech}@${r.version}.md`), parts.map((p, i) => `<<<CHUNK ${i}>>>\n${p}`).join("\n"));
}
