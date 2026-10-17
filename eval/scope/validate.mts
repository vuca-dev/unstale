// Validates the catalog's records-per-note-token fit on sampled packages: runs the production extraction (two calls,
// UNSTALE_EXTRACT_MODEL) on each package's in-window release notes and counts incoming records.
//   cd central && UNSTALE_CENTRAL_DIR=<tmp> UNSTALE_EXTRACT_MODEL=vercel:openai/gpt-6-luna npx tsx ../eval/scope/validate.mts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractRelease } from "../../central/src/pipeline/extract.ts";
import { llmStats } from "../../central/src/pipeline/llm.ts";

const here = import.meta.dirname;
const subjects = JSON.parse(readFileSync(join(here, "validate-input.json"), "utf8")) as Array<{
  name: string; repo: string; tokens: number; releases: Array<{ tag: string; version: string; date: string; url: string; notes: string }>;
}>;
const CAP = Number(process.env.SCOPE_CAP ?? 0.75);
const out: Array<Record<string, unknown>> = [];
for (const s of subjects) {
  if (llmStats.dollars >= CAP) break;
  const t = { id: s.name, name: s.name, repo: s.repo, components: [], tag: /./, clean: (b: string) => b };
  let records = 0;
  let failed = 0;
  for (const r of s.releases) {
    if (!r.notes.trim()) continue;
    const res = await extractRelease(t, { technology: s.name, tag: r.tag, version: r.version, date: r.date, url: r.url, snapshot: `sha256:${r.tag}`, notes: r.notes });
    records += res.incoming.length;
    failed += res.failed;
  }
  out.push({ name: s.name, tokens: s.tokens, releases: s.releases.length, records, failed, spent: llmStats.dollars });
  console.log(JSON.stringify(out.at(-1)));
}
writeFileSync(join(here, "validate.json"), JSON.stringify({ rows: out, stats: llmStats }, null, 1));
