// The advisories stage's affected-API step on a store copy for a set of advisory ids only (eval/advisory-apis/
// RESULTS.md: the advisories the A/B attempts' reports name), then republished: what `catalog advisory-apis --all`
// does for every advisory, at a fraction of the calls. For measurement only.
//
//   cd central && UNSTALE_STORE=<store copy> node ../eval/advisory-apis/apply.mts <ids.txt>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attachAdvisoryApis, packageNamesOf } from "../../central/src/pipeline/advisory-apis.ts";
import { aliasDetails, fetchAdvisories, osvTexts } from "../../central/src/pipeline/advisories.ts";
import { llmStats } from "../../central/src/pipeline/llm.ts";
import { catalogDir, centralDir } from "../../central/src/pipeline/paths.ts";
import { activeTerms, publishTechnology } from "../../central/src/pipeline/publish.ts";
import { sampleCounts } from "../../central/src/pipeline/sample.ts";
import { loadStore, saveStore } from "../../central/src/pipeline/store.ts";
import type { Technology } from "../../central/src/pipeline/technologies.ts";
import { pool, readJson } from "../../central/src/pipeline/util.ts";
import { techLocal } from "../../central/src/state/client.ts";

const want = new Set(readFileSync(process.argv[2]!, "utf8").split("\n").map((x) => x.trim().toUpperCase()).filter(Boolean));
const ids = readdirSync(join(centralDir(), "records")).filter((f) => f.endsWith(".json")).map((f) => readJson<{ technology: string }>(join(centralDir(), "records", f))!.technology);
const total = { technologies: 0, advisories: 0, named: 0, records: 0 };
await pool(ids, 4, async (id) => {
  const purls = readJson<{ purls?: string[] }>(join(centralDir(), "advisories", techLocal(id), "packages.json"))?.purls;
  if (!purls?.length) return;
  const t = { id, name: id, repo: "", components: purls, tag: /^$/, clean: (b: string) => b } as Technology;
  const advisories = (await fetchAdvisories(t, { offline: true })).filter((a) => [a.id, ...a.aliases].some((x) => want.has(x.toUpperCase())));
  if (!advisories.length) return;
  const s = loadStore(id);
  const r = await attachAdvisoryApis(s, advisories, packageNamesOf(purls), await osvTexts(t), (x) => aliasDetails(t, x));
  total.technologies++;
  total.advisories += r.advisories;
  total.named += r.named;
  total.records += r.records;
  saveStore(s);
  const checked = readJson<{ checked: string }>(join(centralDir(), "releases", techLocal(id), "index.json"))?.checked ?? new Date(0).toISOString();
  publishTechnology(s, checked, catalogDir(), sampleCounts(id, activeTerms(s)));
});
console.log(JSON.stringify({ ...total, model: llmStats }));
