// After a live extraction cell: is the client's second call (the label call) the request central would make for the
// same first answer? No model call. For every chunk, the client's cached extract answer is read, central's own code
// builds the label prompt from it (extract.ts: the `Extracted` schema, the record briefs, LABEL_PROMPT), and the
// client's cache must hold an entry under that prompt's key.
//
//   cd central && npx tsx ../eval/edge-port/check_label_prompts.mts INPUT.jsonl CELL_DIR [MODEL_KEY]
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const { Extracted, LABEL_PROMPT, EXTRACT_PROMPT, fill, strings, contentFree } = await import("../../central/src/pipeline/extract.ts");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const [input, cell, modelKey = "gpt-6-luna@low"] = process.argv.slice(2) as [string, string, string?];
const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "schema", "prompts", "extract.json"), "utf8")).version as number;
const caches = readdirSync(cell).filter((d) => d.startsWith("shard")).map((d) => join(cell, d, "cache", "inference", "results"));
const get = (key: string): { outcome: string; answer?: unknown } | undefined => {
  for (const c of caches) { const p = join(c, key.slice(0, 2), `${key}.json`); if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); }
  return undefined;
};
const keyOf = (step: string, notes: string, prompt: string, form = "") => sha(`${step}${form}\n${modelKey}\n${version}\n${sha(notes)}\n${sha(prompt)}`);
let chunks = 0, answered = 0, withRecords = 0, labelFound = 0, other = 0;
const missing: string[] = [];
for (const line of readFileSync(input, "utf8").split("\n").filter((l) => l.trim())) {
  const ev = JSON.parse(line) as { id: string; name: string; version: string; date: string; chunks: Array<{ id: string; text: string }> };
  ev.chunks.forEach((c, ci) => {
    if (!c.text.trim() || contentFree(c.text)) return;
    chunks++;
    const part = ev.chunks.length > 1 ? `\nPart ${ci + 1} of ${ev.chunks.length} of these release notes.` : "";
    const prompt = fill(EXTRACT_PROMPT, { TECH: ev.name, VERSION: ev.version, DATE: ev.date, PART: part, NOTES: c.text });
    // Asked alone, or (through Codex) answered in a batch of eight.
    const e = get(keyOf("extract", c.text, prompt)) ?? get(keyOf("extract", c.text, prompt, "@batch8"));
    if (!e || e.outcome !== "answer" || !Array.isArray(e.answer)) return void other++;
    answered++;
    const recs = (e.answer as unknown[]).flatMap((r) => { const p = Extracted.safeParse(r); return p.success ? [p.data] : []; });
    if (!recs.length) return;
    withRecords++;
    const brief = recs.map((x, i) => ({ id: `r${i + 1}`, subject: x.subject, facet: x.facet ?? null, change_type: x.change_type ?? null, summary: x.summary, introduces: strings(x.introduces, 20), evidence: x.evidence ?? "" }));
    const label = fill(LABEL_PROMPT, { TECH: ev.name, VERSION: ev.version, RECORDS: JSON.stringify(brief, null, 1), NOTES: c.text });
    if (get(keyOf("extract-label", c.text, label))) labelFound++;
    else missing.push(c.id);
  });
}
console.log(JSON.stringify({ input, chunks_with_content: chunks, extract_answers_found_under_centrals_prompt: answered, not_answered_or_split: other, chunks_with_records: withRecords, label_calls_made_with_centrals_prompt: labelFound, missing }));
