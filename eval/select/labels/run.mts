// Label-call runner (#5b, #6): one label call per chunk of items.json (or dev-items.json), as extract.ts does, with a
// prompt variant (prompts.mts) and optionally the input diet (sections holding the records' evidence only).
//
//   cd central && npx tsx ../eval/select/labels/run.mts --cand vercel|luna --prompt base|v1|v2|v3 [--diet] [--rep]
//     [--split set|dev] [--limit N] [--dry-run]
// Output: out/labels/runs/<run>/answers.json ({"<doc>#<ci>": raw answer text}), meta.json (tokens, $, input chars).
// Gateway usage goes to out/labels/usage.jsonl; a call is refused once that log reaches the track cap ($1.20), and a
// run is refused when the live balance minus the $1 reserve is below its worst case.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const OUT = join(SELECT, "out", "labels");
process.env.UNSTALE_CENTRAL_DIR = join(OUT, "central");
const { values: a } = parseArgs({ options: { cand: { type: "string" }, prompt: { type: "string", default: "base" }, diet: { type: "boolean", default: false }, evidence: { type: "boolean", default: false }, rep: { type: "boolean", default: false }, split: { type: "string", default: "set" }, limit: { type: "string" }, "dry-run": { type: "boolean", default: false }, concurrency: { type: "string", default: "4" } } });
const { ChatClient, PROVIDERS } = await import("../client.ts");
const { gatewayBalance, GATEWAY_RESERVE } = await import("../budget.ts");
const { codex, parseJson, codexStats } = await import("../../lib/codex.ts");
const { fill } = await import("../../../central/src/pipeline/extract.ts");
const { pool } = await import("../../../central/src/pipeline/util.ts");
const { PROMPTS, dietNotes, evidenceOnly } = await import("./prompts.mts");
import type { Chunk } from "./items.mts";

const CAP = 1.2;
const cand = a.cand!;
if (!["vercel", "luna"].includes(cand) || !(a.prompt! in PROMPTS)) throw new Error("usage: --cand vercel|luna --prompt base|v1|v2|v3");
const file = a.split === "dev" ? "dev-items.json" : "items.json";
const chunks = (JSON.parse(readFileSync(join(import.meta.dirname, file), "utf8")) as { chunks: Chunk[] }).chunks.slice(0, a.limit ? Number(a.limit) : undefined);
const runId = [cand, a.prompt, ...(a.diet ? ["diet"] : []), ...(a.evidence ? ["evonly"] : []), ...(a.rep ? ["rep"] : []), a.split, ...(a.limit ? [`n${a.limit}`] : [])].join("-");
const runDir = join(OUT, "runs", runId);
const USAGE = join(OUT, "usage.jsonl");
const tpl = PROMPTS[a.prompt!]!;

const spent = () => existsSync(USAGE) ? readFileSync(USAGE, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (Number(JSON.parse(l).dollars) || 0), 0) : 0;
const prompts = chunks.map((c) => {
  if (a.evidence) { const e = evidenceOnly(c); return fill(tpl, { TECH: c.name, VERSION: c.version, RECORDS: JSON.stringify(e.records, null, 1), NOTES: e.notes }); }
  return fill(tpl, { TECH: c.name, VERSION: c.version, RECORDS: JSON.stringify(c.records, null, 1), NOTES: a.diet ? dietNotes(c) : c.notes });
});
const inChars = prompts.reduce((s, p) => s + p.length, 0);
// Worst case: input at chars/3 tokens, 16k output per call, gpt-6-luna list $0.10 / $0.50.
const worst = (inChars / 3) * 0.1e-6 + chunks.length * 16_000 * 0.5e-6;
console.error(`${runId}: ${chunks.length} chunks, ${inChars} prompt chars, worst case $${worst.toFixed(3)}, track spent $${spent().toFixed(3)}`);
if (a["dry-run"]) process.exit(0);
if (cand === "vercel") {
  const bal = await gatewayBalance();
  if (bal - GATEWAY_RESERVE < worst) throw new Error(`gateway balance $${bal} minus reserve is below the worst case`);
  if (spent() + worst > CAP + 0.4) throw new Error("track cap would be exceeded");
}

const client = new ChatClient({ provider: PROVIDERS.vercel!, cacheDir: join(OUT, "cache"), usageLog: USAGE, concurrency: Number(a.concurrency) });
const labelObject = (text: string) => { const v = parseJson(text, "object"); return v && typeof v === "object" && !Array.isArray(v) ? v : undefined; };
const answers: Record<string, string | null> = {};
let failed = 0;
await pool(chunks.map((c, i) => [c, prompts[i]!] as const), Number(a.concurrency), async ([c, prompt]) => {
  const key = `${c.doc}#${c.ci}`;
  if (cand === "luna") {
    let text: string | null = null;
    await codex(prompt, (t) => { const v = labelObject(t); if (v) text = t; return v; });
    answers[key] = text;
    if (!text) failed++;
    return;
  }
  if (spent() >= CAP) { answers[key] = null; failed++; console.error("track cap reached"); return; }
  const body = { model: "openai/gpt-6-luna", messages: [{ role: "user", content: prompt }], max_tokens: 16_000, reasoning_effort: "low", ...(a.rep ? { user: "labels-rep" } : {}) };
  const r = await client.complete(body, labelObject, { step: "label", run: runId, doc: c.doc, ci: c.ci });
  answers[key] = r.value ? r.text : null;
  if (!r.value) failed++;
});
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, "answers.json"), JSON.stringify(answers, null, 1) + "\n");
const meta = { runId, cand, prompt: a.prompt, diet: a.diet, rep: a.rep, split: a.split, chunks: chunks.length, failed, prompt_chars: inChars, notes_chars: chunks.reduce((s, c) => s + (a.evidence ? 0 : a.diet ? dietNotes(c) : c.notes).length, 0), evidence_only: a.evidence, gateway: client.stats, codex: codexStats };
writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 1) + "\n");
console.log(JSON.stringify(meta));
