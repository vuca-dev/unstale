// Worst-case cost per step, with N, c, R and S measured on the store (read only) and P from the pipeline's own prompts.
// No model calls.
//
//   A  extraction        input O(N + c·P_A)          output R·o_A
//   B  field labelling   input O(N + R·o_A + c·P_B)  output R·o_B       (the notes are read a second time)
//   A+B one call         input O(N + c·P_1)          output R·(o_A + o_B)
//   D  record labels     input O(R·S_D)              output R·o_D       (one request of 8 questions per record)
//   E  same-or-new       input O(R·K·S_E)            output R·K·o_E     (K = 8 candidates, one request per record)
//
// Tokens are characters / 4 (no tokenizer is installed; the runner's budget guard uses the stricter / 3). Reasoning
// tokens are not bounded here: they depend on the model and are measured per run (usage.jsonl).
//
//   cd central && npx tsx ../eval/select/cost.mts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../../central/src/pipeline/util.ts";
import { labelQuestions, recordState } from "../../central/src/pipeline/classify/labels.ts";
import { chunk, EXTRACT_PROMPT, fill, LABEL_PROMPT, type Incoming } from "../../central/src/pipeline/extract.ts";
import { K, matchRequest, retrieve } from "../../central/src/pipeline/match.ts";
import type { TechStore } from "../../central/src/pipeline/store.ts";
import { loadPrices, type Price } from "./client.ts";
import { ONE_CALL_PROMPT } from "./prompts.ts";
import { extractions, STORE } from "./states.ts";

const C = join(STORE, "central");
const tok = (s: string): number => s.length / 4;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const max = (xs: number[]): number => Math.max(...xs);

// N and c per technology-year: the stored release notes are the catalog's one-year window.
const techs = readdirSync(join(C, "releases")).filter((t) => statSync(join(C, "releases", t)).isDirectory());
const perTech = techs.map((t) => {
  const files = readdirSync(join(C, "releases", t)).filter((f) => f.endsWith(".md"));
  const notes = files.map((f) => readFileSync(join(C, "releases", t, f), "utf8"));
  return { t, files: files.length, N: notes.reduce((s, n) => s + tok(n), 0), c: notes.reduce((s, n) => s + (n.trim() ? chunk(n).length : 0), 0) };
});
// R: incoming records ingested per technology (every one is classified and judged).
const R = readdirSync(join(C, "records"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => Object.keys((JSON.parse(readFileSync(join(C, "records", f), "utf8")) as TechStore).ingested).length);

const P_A = tok(fill(EXTRACT_PROMPT, { TECH: "Technology", VERSION: "1.0.0", DATE: "2026-01-01", PART: "", NOTES: "" }));
const P_B = tok(fill(LABEL_PROMPT, { TECH: "Technology", VERSION: "1.0.0", RECORDS: "", NOTES: "" }));
const P_1 = tok(fill(ONE_CALL_PROMPT, { TECH: "Technology", VERSION: "1.0.0", DATE: "2026-01-01", PART: "", NOTES: "" }));

// Per-record output and state sizes, measured on the stored extractions (Next.js, Prisma, NestJS).
const incs: Incoming[] = ["next", "prisma", "nestjs"].flatMap((t) => [...extractions(C, t).values()]);
const oA = mean(incs.map((i) => tok(JSON.stringify({ subject: i.subject, subject_kind: i.subject_kind, facet: i.facet ?? null, change_type: i.hint_change_type, surface: i.hint_surface, summary: i.summary, audience: "application", introduces: i.introduces, evidence: i.quote }))));
const oB = mean(incs.map((i) => tok(JSON.stringify({ terms: i.terms, replaces: i.replaces, requires: i.requires, prerequisites: i.prerequisites, conditions: i.conditions }))));
const q = labelQuestions();
const SD = incs.map((i) => tok(canonical({ state: recordState("Technology", i), questions: q })));
const oD = 8 * 25; // 8 answers, each a choice and its probabilities
// E: requests with the full K candidates against the current Next.js store.
const next = JSON.parse(readFileSync(join(C, "records", "next.json"), "utf8")) as TechStore;
const SE = incs
  .filter((i) => i.technology === "next")
  .map((i) => retrieve(i, Object.values(next.records)).map((c) => next.records[c.id]!))
  .map((cands, j) => ({ cands, j }))
  .filter((x) => x.cands.length === K)
  .slice(0, 200)
  .map(({ cands, j }) => {
    const i = incs.filter((x) => x.technology === "next")[j]!;
    const r = matchRequest("Next.js", i, false, cands);
    return tok(canonical(r));
  });
const oE = K * 25;

const Nm = mean(perTech.map((x) => x.N));
const cm = mean(perTech.map((x) => x.c));
const Rm = mean(R);
const steps: Record<string, { input: number; output: number; generativeOnly?: boolean; outputFreeOnClassifiers?: boolean }> = {
  A: { input: Nm + cm * P_A, output: Rm * oA, generativeOnly: true },
  B: { input: Nm + Rm * oA * 1.5 + cm * P_B, output: Rm * oB, generativeOnly: true },
  "A+B two calls": { input: 2 * Nm + Rm * oA * 1.5 + cm * (P_A + P_B), output: Rm * (oA + oB), generativeOnly: true },
  "A+B one call": { input: Nm + cm * P_1, output: Rm * (oA + oB), generativeOnly: true },
  D: { input: Rm * mean(SD), output: Rm * oD },
  E: { input: Rm * mean(SE), output: Rm * oE },
};

const r0 = (x: number) => Math.round(x).toLocaleString("en");
console.log(`Measured on ${C} (${techs.length} technologies with release notes, ${R.length} with records):`);
console.log(`  N  notes tokens per technology-year: mean ${r0(Nm)}, max ${r0(max(perTech.map((x) => x.N)))} (${perTech.reduce((s, x) => s + x.files, 0)} files)`);
console.log(`  c  chunks per technology-year: mean ${cm.toFixed(1)}, max ${max(perTech.map((x) => x.c))}`);
console.log(`  R  incoming records per technology-year: mean ${Rm.toFixed(1)}, max ${max(R)}`);
console.log(`  P  prompt tokens: A ${r0(P_A)}, B ${r0(P_B)}, one call ${r0(P_1)}`);
console.log(`  o  output tokens per record: A ${r0(oA)}, B ${r0(oB)}; D ${oD} per request, E ${oE} per request (assumed: 25 per answer)`);
console.log(`  S  D request ${r0(mean(SD))} mean / ${r0(max(SD))} max; E request with K=${K} ${r0(mean(SE))} mean (${SE.length} Next.js requests)`);
console.log("");
console.log("Tokens per technology-year (mean technology):");
for (const [s, v] of Object.entries(steps)) console.log(`  ${s.padEnd(14)} input ${r0(v.input).padStart(8)}  output ${r0(v.output).padStart(7)}`);

const priced = loadPrices().filter((p) => p.input !== null);
const generative = (p: Price) => !["jev", "openai-decisions", "cloudflare"].includes(p.provider);
const shown = priced.filter((p) =>
  ["jev", "openai-decisions", "deepinfra", "gemini", "codex"].includes(p.provider) ||
  ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "google/gemini-3.1-flash-lite", "alibaba/qwen3.8-flash", "deepseek/deepseek-v4-flash", "openai/gpt-5.6-luna"].includes(p.model));
console.log("");
console.log("$ per technology-year, and per year at 10k / 50k / 200k technologies (input at the uncached rate):");
for (const [s, v] of Object.entries(steps)) {
  console.log(`  ${s}`);
  for (const p of shown) {
    if (v.generativeOnly && !generative(p)) continue;
    const usd = p.output === null ? null : (v.input * p.input! + v.output * p.output) / 1e6;
    const label = `${p.provider}/${p.model}`.padEnd(40);
    if (usd === null) console.log(`    ${label} price unknown (no output price)`);
    else console.log(`    ${label} $${usd.toFixed(6)}  | $${(usd * 1e4).toFixed(0)} / $${(usd * 5e4).toFixed(0)} / $${(usd * 2e5).toFixed(0)}`);
  }
}
if (!existsSync(join(C, "records"))) process.exit(1);
