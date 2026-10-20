// Slice 8 replicate (PREREG.md "Noise"): step A asked again, with an empty cache, on inventory chunks, through the
// pipeline's own extractLlm with production's model settings and the exact prompt production sent (EXTRACT_PROMPT with
// the chunk's technology name, version, date and part line). Only step A: whether a chunk yields records is decided
// there (step B is not called for an empty answer).
//
//   cd central && npx tsx ../eval/select/slice8/rep8.mts --split heldout --set aplus|skipped [--sample 300] [--cap 2]
//
// --set aplus     the split's chunks production answered with records (the noise: how often a fresh call returns []
//                 on a chunk production got records from)
// --set skipped   the split's chunks the frozen candidate skips (does a fresh call find records there?)
// Output: out/slice8/rep/<split>-<set>.jsonl {id, records | null, truncated}. Usage: out/slice8/rep/central/usage.jsonl.
// A call is refused once the logged spend plus $0.01 per call in flight would pass --cap.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { values: a } = parseArgs({ options: { split: { type: "string" }, set: { type: "string" }, sample: { type: "string" }, cap: { type: "string", default: "2" }, seed: { type: "string", default: "20261020" } } });
const OUT = join(import.meta.dirname, "..", "out", "slice8");
const REP = join(OUT, "rep");
mkdirSync(REP, { recursive: true });
process.env.UNSTALE_CENTRAL_DIR = join(REP, "central");
process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
process.env.UNSTALE_EXTRACT_EFFORT = "low";
process.env.UNSTALE_EXTRACT_SERVICE_TIER = "flex";
for (const k of ["UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET"]) delete process.env[k];
const X = await import("../../../central/src/pipeline/extract.ts");
const { extractLlm, parseJson } = await import("../../../central/src/pipeline/llm.ts");
const { pool } = await import("../../../central/src/pipeline/util.ts");
const { boilerplate } = await import("./skip.ts");
const { FROZEN } = await import("./frozen.ts");

type Row = { id: number; name: string; version: string; promptDate: string; partText: string; split: string; status: string; text: string };
let rows = readFileSync(join(OUT, "rows.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row).filter((r) => r.split === a.split);
if (a.set === "aplus") rows = rows.filter((r) => r.status === "A+");
else if (a.set === "skipped") rows = rows.filter((r) => boilerplate(r.text, FROZEN));
else throw new Error("--set aplus|skipped");
if (a.sample) {
  // Deterministic sample: sort by a seeded hash of the id.
  const h = (i: number) => {
    let x = (i + 1) * 2654435761 + Number(a.seed);
    x ^= x >>> 16;
    x = Math.imul(x, 2246822507);
    x ^= x >>> 13;
    return x >>> 0;
  };
  rows = rows.sort((p, q) => h(p.id) - h(q.id)).slice(0, Number(a.sample));
}
const FILE = join(REP, `${a.split}-${a.set}.jsonl`);
const done = new Set(existsSync(FILE) ? readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: number }).id) : []);
const LOG = join(REP, "central", "usage.jsonl");
const spent = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).reduce((s, l) => s + ((JSON.parse(l) as { dollars?: number }).dollars ?? 0), 0) : 0);
const CAP = Number(a.cap);
let inflight = 0;
let refused = 0;
const todo = rows.filter((r) => !done.has(r.id));
console.error(`${a.split}/${a.set}: ${rows.length} chunks, ${todo.length} to run, spent so far $${spent().toFixed(4)}`);
await pool(todo, 8, async (r) => {
  if (spent() + (inflight + 1) * 0.01 > CAP) {
    refused++;
    return;
  }
  inflight++;
  let truncated = false;
  const prompt = X.fill(X.EXTRACT_PROMPT, { TECH: r.name, VERSION: r.version, DATE: r.promptDate, PART: r.partText, NOTES: r.text });
  try {
    const recs = await extractLlm(
      prompt,
      (text) => {
        const v = parseJson(text, "array");
        return Array.isArray(v) ? v.filter((x) => X.Extracted.safeParse(x).success) : undefined;
      },
      { onLength: () => (truncated = true) },
    );
    appendFileSync(FILE, JSON.stringify({ id: r.id, records: recs ? recs.length : null, truncated }) + "\n");
  } finally {
    inflight--;
  }
});
console.error(`done; refused ${refused}; spent $${spent().toFixed(4)}`);
