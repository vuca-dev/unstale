// Slice 3c D check (PREREG.md "Slice 3c amendment"): does an extraction variant change what the classifier (Jev) says?
// Records of a baseline run (A) and a variant run (B) are paired within a note by quote (exact after whitespace and case
// folding). Jev labels A, B and A again (the repeat: Jev's own run-to-run agreement on the same states). Fresh calls, no
// cache. Reports per-question agreement A–B against A–A'.
//
//   cd central && npx tsx ../eval/select/slice3/dcheck.mts RUN_A RUN_B OUT.json [--max 250] [--cap 0.15]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Jev } from "../../../central/src/pipeline/classify/adapter.ts";
import { labelQuestions, recordState } from "../../../central/src/pipeline/classify/labels.ts";
import type { Incoming } from "../../../central/src/pipeline/extract.ts";
import { pool } from "../../../central/src/pipeline/util.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
const [runA, runB, out] = args.filter((x, i) => !x.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--"))) as [string, string, string];
const MAX = Number(opt("--max", "250"));
const CAP = Number(opt("--cap", "0.15"));
const USAGE = join(import.meta.dirname, "..", "out", "slice3c", "usage.jsonl");
const NAMES: Record<string, string> = { "posthog-js-bf3ade81": "posthog-js", "zod-6ac59393": "zod", "uvicorn-9342337b": "uvicorn", "typer-4f6b46bd": "typer" };

const load = (r: string) => JSON.parse(readFileSync(join(r, "incoming.json"), "utf8")) as Incoming[];
const fold = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();
const note = (i: Incoming) => i.key.replace(/#.*$/, "");
const A = load(runA), B = load(runB);
const pairs: Array<[Incoming, Incoming]> = [];
const usedB = new Set<string>();
for (const a of A) {
  const b = B.find((x) => !usedB.has(x.key) && note(x) === note(a) && fold(x.quote) === fold(a.quote));
  if (b) { usedB.add(b.key); pairs.push([a, b]); }
}
const sample = pairs.slice(0, MAX);
console.log(`${A.length} A records, ${B.length} B records, ${pairs.length} paired by quote; labelling ${sample.length} x 3`);

let spent = 0;
const f: typeof fetch = async (url, init) => {
  if (spent >= CAP) throw new Error("dcheck: cap reached");
  const res = await fetch(url, init);
  if (res.ok) {
    const j = (await res.clone().json().catch(() => undefined)) as { usage?: { input_tokens?: number } } | undefined;
    const d = ((j?.usage?.input_tokens ?? 0) * 0.042) / 1e6;
    spent += d;
    appendFileSync(USAGE, JSON.stringify({ run: "dcheck", step: "classify", provider: "jev", model: "jev-latest", input_tokens: j?.usage?.input_tokens ?? 0, dollars: d, at: new Date().toISOString() }) + "\n");
  }
  return res;
};
const jev = new Jev({ fetch: f });
const q = labelQuestions();
const label = async (i: Incoming) => (await jev.classify(recordState(NAMES[i.technology] ?? i.technology, i), q)).answers;
const rows = await pool(sample, 4, async ([a, b]) => ({ key: a.key, a: await label(a), b: await label(b), a2: await label(a) }));

const qs = Object.keys(q);
const agree = (x: string, y: string) => {
  const res: Record<string, number> = {};
  for (const k of qs) res[k] = rows.filter((r) => (r as never)[x][k]?.choice === (r as never)[y][k]?.choice).length / rows.length;
  return res;
};
const result = { pairs: pairs.length, labelled: rows.length, dollars: spent, a_vs_b: agree("a", "b"), a_vs_repeat: agree("a", "a2"), rows };
writeFileSync(out, JSON.stringify(result, null, 1));
for (const k of qs) console.log(`${k.padEnd(26)} A–B ${(100 * result.a_vs_b[k]!).toFixed(1)}%   A–A' ${(100 * result.a_vs_repeat[k]!).toFixed(1)}%`);
console.log(`Jev $${spent.toFixed(4)}`);
