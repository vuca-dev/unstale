// Label-field set, step 1: the fixed record set. For every chunk of held-out set 1 (holdout/extraction, 40 notes) and
// held-out set 2 (holdout-majors, 7 documents), the records gpt-6-luna extracted in slice 3b (two calls, low) and the
// label call's input (the pipeline's brief and the chunk's notes). Every label variant, both baselines and the
// reference labelers label exactly these records, so all comparisons are paired by record.
//
//   cd central && npx tsx ../eval/select/labels/items.mts
// Output: eval/select/labels/items.json (committed; deterministic).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const SELECT = join(import.meta.dirname, "..");
const { chunk, Extracted, strings } = await import("../../../central/src/pipeline/extract.ts");
const { parseJson } = await import("../../../central/src/pipeline/codex.ts");

interface Note { note_file: string; technology: string; name: string; version: string; kind?: string }
const sets = [
  { set: "H1", dir: join(SELECT, "holdout", "extraction"), run: "vercel_openai_gpt-6-luna-two-call-heldout" },
  { set: "H2", dir: join(SELECT, "holdout-majors", "extraction"), run: "vercel_openai_gpt-6-luna-two-call-heldout2" },
];

export interface Brief { id: string; subject: string; facet: string | null; change_type: string | null; summary: string; introduces: string[]; evidence: string }
export interface Chunk { set: string; doc: string; tech: string; name: string; version: string; kind: string; ci: number; notes: string; records: Brief[]; baseline: string | null }

const out: Chunk[] = [];
for (const s of sets) {
  const notes = (JSON.parse(readFileSync(join(s.dir, "notes.json"), "utf8")) as { notes: Note[] }).notes;
  const raw = readFileSync(join(SELECT, "out", "slice3b", "runs", s.run, "raw.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { doc: string; ci: number; step: string; text: string; finish?: string });
  for (const n of notes) {
    const parts = chunk(readFileSync(join(s.dir, "notes", n.note_file), "utf8"));
    parts.forEach((text, ci) => {
      const ex = raw.filter((r) => r.doc === n.note_file && r.ci === ci && r.step === "extract").at(-1);
      if (!ex) return;
      const v = parseJson(ex.text, "array");
      const recs = Array.isArray(v) ? v.flatMap((r) => { const p = Extracted.safeParse(r); return p.success ? [p.data] : []; }) : [];
      if (!recs.length) return;
      const records: Brief[] = recs.map((x, i) => ({ id: `r${i + 1}`, subject: x.subject, facet: x.facet ?? null, change_type: x.change_type ?? null, summary: x.summary, introduces: strings(x.introduces, 20), evidence: x.evidence ?? "" }));
      const lab = raw.filter((r) => r.doc === n.note_file && r.ci === ci && r.step === "label").at(-1);
      out.push({ set: s.set, doc: n.note_file, tech: n.technology, name: n.name, version: n.version, kind: n.kind ?? "notes", ci, notes: text, records, baseline: lab?.text ?? null });
    });
  }
}
writeFileSync(join(import.meta.dirname, "items.json"), JSON.stringify({ chunks: out }, null, 1) + "\n");
console.log(JSON.stringify({ chunks: out.length, records: out.reduce((a, c) => a + c.records.length, 0), H1: out.filter((c) => c.set === "H1").reduce((a, c) => a + c.records.length, 0), H2: out.filter((c) => c.set === "H2").reduce((a, c) => a + c.records.length, 0), no_baseline: out.filter((c) => !c.baseline).length }));
