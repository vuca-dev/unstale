// Summarises calls.jsonl (run.mts) and prices one technology-year through the CLI against the direct API.
//
//   cd central && npx tsx ../eval/edge-cli/summarize.mts
//
// Overhead per call = input tokens of the trivial probe ("Reply with exactly: OK") under the same flags; payload =
// input − overhead. API-equivalent dollars use gpt-6-luna list price ($0.10 input, $0.01 cached input, $0.50 output
// per million; eval/select/prices.json, openai/gpt-6-luna on the gateway), since a plan-billed CLI charges no per call.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rows = readFileSync(join(import.meta.dirname, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
// $/M list price of the model each CLI ran: gpt-6-luna (Codex); spacexai/grok-4.5 on the gateway for Cursor's
// cursor-grok-4.5-low-fast, the cheapest priced model its plan included (eval/select/prices.json, checked 2026-10-20).
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  codex: { input: 0.1, cached: 0.01, output: 0.5 },
  cursor: { input: 2, cached: 0.3, output: 6 },
};
let PRICE = PRICES.codex!;
const usd = (u: { input: number; cached: number; output: number }) => ((u.input - u.cached) * PRICE.input + u.cached * PRICE.cached + u.output * PRICE.output) / 1e6;

// Per technology-year (vault "Inference Costs", 16 October 2026): 114.6 records; about 8k note tokens in 3,373 notes
// over 186 technologies, so 18.1 notes; a note under MAX_CHUNK is one chunk.
const R = 114.6;
const CHUNKS = 3373 / 186;
// Direct-API payload per technology-year (same source): A + B 560 input and 220 output tokens per record (two calls);
// E from slice 5's direct chat runs (gpt-oss-20b held-out: 2,431 input, 246 output per request at mean K 7.52), scaled to K = 8.
const AB = { input: 560 * R, output: 220 * R };
const E_REQ = { input: 2431 * (8 / 7.52), output: 246 * (8 / 7.52) };
// Direct-API options to beat (Edge Inference experiments): A + B on gpt-6-luna flex; D + E on Jev.
const DIRECT = { ab: 0.0096, de: 0.021 };

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

for (const cli of [...new Set(rows.map((r) => r.cli))]) {
  PRICE = PRICES[cli]!;
  for (const variant of [...new Set(rows.filter((r) => r.cli === cli).map((r) => r.variant))]) {
    const ok = rows.filter((r) => r.cli === cli && r.variant === variant && r.code === 0 && r.input && !r.tag);
    const triv = ok.filter((r) => r.task === "trivial");
    if (!triv.length) continue;
    const over = { input: mean(triv.map((r) => r.input)), cached: mean(triv.map((r) => r.cached)) };
    const overUsd = usd({ ...over, output: 0 });
    console.log(`\n## ${cli} / ${variant}: overhead ${over.input.toFixed(0)} input tokens per call (${over.cached.toFixed(0)} cached), ≈ $${overUsd.toFixed(6)} per call`);
    console.log("| task | items/call | calls | input | cached | output | payload input/item | overhead/item | wall p50 / max s | parsed | files left |");
    console.log("|---|---|---|---|---|---|---|---|---|---|---|");
    const per: Record<string, { payload: number; output: number }> = {};
    for (const task of ["trivial", "sandbox", "sandbox-root", "extract", "extract8", "labels", "labels8"]) {
      const t = ok.filter((r) => r.task === task);
      if (!t.length) continue;
      const items = t[0].items || 1;
      const inp = mean(t.map((r) => r.input));
      const payload = (inp - over.input) / items;
      per[task] = { payload, output: mean(t.map((r) => r.output)) / items };
      const ms = t.map((r) => r.ms / 1000);
      console.log(`| ${task} | ${t[0].items} | ${t.length} | ${inp.toFixed(0)} | ${mean(t.map((r) => r.cached)).toFixed(0)} | ${mean(t.map((r) => r.output)).toFixed(0)} | ${task === "trivial" || task.startsWith("sandbox") ? "—" : payload.toFixed(0)} | ${(over.input / items).toFixed(0)} | ${pct(ms, 0.5).toFixed(1)} / ${Math.max(...ms).toFixed(1)} | ${t.filter((r) => r.parsed).length}/${t.length} | ${t.filter((r) => r.leftover.length).length} |`);
    }
    // One technology-year through this CLI, API-equivalent.
    for (const batch of [1, 8]) {
      const abCalls = (2 * CHUNKS) / batch;
      const dCalls = R / batch;
      const eCalls = R / batch;
      const d = per[batch === 1 ? "labels" : "labels8"];
      const abPayload = usd({ input: AB.input, cached: 0, output: AB.output });
      const dPayload = d ? usd({ input: d.payload * R, cached: 0, output: d.output * R }) : NaN;
      // E's payload is not batched here: each request already carries its 8 candidates (only overhead is shared).
      const ePayload = usd({ input: E_REQ.input * R, cached: 0, output: E_REQ.output * R });
      const ab = abPayload + abCalls * overUsd;
      const de = dPayload + ePayload + (dCalls + eCalls) * overUsd;
      const tokens = {
        overhead: (abCalls + dCalls + eCalls) * over.input,
        payload_in: AB.input + (d?.payload ?? 0) * R + E_REQ.input * R,
        output: AB.output + (d?.output ?? 0) * R + E_REQ.output * R,
      };
      console.log(`\nbatch ${batch}: calls/tech-year A+B ${abCalls.toFixed(1)}, D ${dCalls.toFixed(1)}, E ${eCalls.toFixed(1)}; ` +
        `tokens/tech-year: overhead ${(tokens.overhead / 1e3).toFixed(0)}k + payload ${(tokens.payload_in / 1e3).toFixed(0)}k input, ${(tokens.output / 1e3).toFixed(0)}k output. ` +
        `API-equivalent: A+B ≈ $${ab.toFixed(4)} (overhead $${(abCalls * overUsd).toFixed(4)}; direct flex $${DIRECT.ab}), ` +
        `D+E ≈ $${de.toFixed(4)} (overhead $${((dCalls + eCalls) * overUsd).toFixed(4)}; direct Jev $${DIRECT.de})`);
    }
  }
}

console.log("\n## Failure modes");
for (const r of rows.filter((r) => r.tag)) console.log(`- ${r.cli} ${r.tag} (model ${r.model}): exit ${r.code}, ${(r.ms / 1000).toFixed(1)} s: ${(r.errors.filter((e: string) => e && !e.startsWith("error: Code Mode")).at(-1) ?? r.stderr ?? "").toString().trim().slice(0, 200)}`);
