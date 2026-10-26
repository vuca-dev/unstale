// Same-document duplicates across extraction chunks (eval/dedupe/RESULTS.md): match.ts `mergeChunkDuplicates` in dry
// run on every stored technology. Each later record of a snapshot, subject and facet made from another chunk of one
// release body than an earlier one (ingest never compared them) is asked against it as ingest now asks it. Jev calls
// go through the central classifier cache.
//
//   cd central && UNSTALE_STORE=<store> node ../eval/dedupe/chunks.mts <out.json>
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { makeClassifier } from "../../central/src/pipeline/pipeline.ts";
import { mergeChunkDuplicates } from "../../central/src/pipeline/match.ts";
import { centralDir } from "../../central/src/pipeline/paths.ts";
import type { TechStore } from "../../central/src/pipeline/store.ts";
import { readJson, writeAtomic } from "../../central/src/pipeline/util.ts";

const [out] = process.argv.slice(2);
if (!out) throw new Error("usage: chunks.mts <out.json>");
const cls = makeClassifier();
const rows: Array<Record<string, unknown>> = [];
for (const f of readdirSync(join(centralDir(), "records")).filter((x) => x.endsWith(".json")).sort()) {
  const s = readJson<TechStore>(join(centralDir(), "records", f))!;
  const judged = await mergeChunkDuplicates(s, s.technology.replace(/-[0-9a-f]{8}$/, ""), (st, q) => cls.classify(st, q), { dryRun: true });
  for (const j of judged) rows.push({ tech: s.technology, ...j, a: s.records[j.into]!.summary, b: s.records[j.from]!.summary });
}
const outcomes = rows.reduce<Record<string, number>>((m, x) => ((m[x.outcome as string] = (m[x.outcome as string] ?? 0) + 1), m), {});
writeAtomic(out, JSON.stringify({ pairs: rows.length, outcomes, classifier: cls.counts, rows }, null, 1) + "\n");
console.log(JSON.stringify({ pairs: rows.length, outcomes, classifier: cls.counts }));
