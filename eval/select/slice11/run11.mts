// Slice 11 primary held-out arm (PREREG.md, "P"): slice 6's held-out AI SDK units, each guide read by every package that
// ingested it, through this branch's production code (extractRelease: MiniMax primary on its frozen prompt, gpt-6-luna
// low flex fallback), with empty caches. Steps A and B only (no classifier: step D is unchanged). The design was rejected
// (RESULTS.md), so central is unchanged: `git apply eval/select/slice11/design.patch` first.
//
//   cd central && npx tsx ../eval/select/slice11/run11.mts --state <central dir: guides/, onboarding/jobs/> [--cap 2]
//
// Output: out/slice6/heldout/mm/pairs.jsonl (score6.mts reads it with --cand mm against base and rep, which are copied
// from slice 6's outputs) and the arm's usage log, out/slice6/heldout/mm/central/usage.jsonl. Every gateway call is
// refused once slice 11's paid spend (this log + out/slice11/usage.jsonl) plus the worst case in flight would pass --cap.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a } = parseArgs({ options: { state: { type: "string" }, cap: { type: "string", default: "2" }, concurrency: { type: "string", default: "4" } } });
const ARM_DIR = join(SELECT, "out", "slice6", "heldout", "mm");
mkdirSync(ARM_DIR, { recursive: true });
process.env.UNSTALE_CENTRAL_DIR = join(ARM_DIR, "central");
for (const k of ["UNSTALE_EXTRACT_MODEL", "UNSTALE_EXTRACT_FALLBACK", "UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET", "UNSTALE_EXTRACT_SERVICE_TIER", "UNSTALE_EXTRACT_EFFORT"]) delete process.env[k];
process.env.UNSTALE_GUIDE_SHARED = "0";
process.env.UNSTALE_EXTRACT_CONCURRENCY ??= "8";

const { loadTechnologies, sharedUnits } = await import("../slice6/common.mts");
const { extractRelease } = await import("../../../central/src/pipeline/extract.ts");
const { extractModels, llmStats } = await import("../../../central/src/pipeline/llm.ts");
const { pool, withUsagePhase } = await import("../../../central/src/pipeline/util.ts");

const CAP = Number(a.cap);
const LOGS = [join(ARM_DIR, "central", "usage.jsonl"), join(SELECT, "out", "slice11", "usage.jsonl")];
const spent = () => {
  let d = 0;
  for (const f of LOGS) if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) d += (JSON.parse(l) as { dollars?: number }).dollars ?? 0;
  return d;
};
let reserved = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("ai-gateway.vercel.sh")) throw new Error(`slice 11: unexpected request to ${url}`);
  const body = typeof init?.body === "string" ? init.body : "";
  // Worst case at gpt-6-luna's default-tier list price ($0.10/M in at one token per character, $0.50/M on 16k out).
  const worst = /"model":"minimax\//.test(body) ? 0 : (body.length * 0.1 + 16_000 * 0.5) / 1e6;
  if (spent() + reserved + worst > CAP) throw new Error(`slice 11: cap reached ($${spent().toFixed(4)} spent)`);
  reserved += worst;
  try {
    return await realFetch(input, init);
  } finally {
    reserved -= worst;
  }
}) as typeof fetch;

const techs = loadTechnologies(join(a.state!, "onboarding", "jobs"));
const units = sharedUnits(join(a.state!, "guides"), techs).filter((u) => u.url.startsWith("https://ai-sdk.dev/"));
const groups = units.map((u) => u.members.map((m) => ({ unit: u.id, tech: m.tech, note: m.note })));
const outFile = join(ARM_DIR, "pairs.jsonl");
const done = new Set(existsSync(outFile) ? readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => { const x = JSON.parse(l); return `${x.unit}\t${x.tech}`; }) : []);
const t0 = Date.now();
console.log(`slice 11 P: ${groups.length} units, ${groups.flat().length} pairs (${done.size} done); models ${extractModels().map((m) => m.model).join(" → ")}; paid spend so far $${spent().toFixed(4)}`);
await pool(groups, Number(a.concurrency), async (pairs) => {
  for (const p of pairs) {
    if (done.has(`${p.unit}\t${p.tech.id}`)) continue;
    const r = await withUsagePhase("other", `${p.unit}|${p.tech.id}`, () => extractRelease(p.tech, p.note));
    const row = { unit: p.unit, tech: p.tech.id, name: p.tech.name, failed: r.failed, incoming: r.incoming.map((i) => ({ ...i, labels: null })) };
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    console.log(`${p.unit} | ${p.tech.id}: ${row.incoming.length} records${row.failed ? `, ${row.failed} failed` : ""}`);
  }
});
writeFileSync(join(ARM_DIR, "meta.json"), JSON.stringify({ arm: "mm", wall_s: (Date.now() - t0) / 1000, paid_spend_after: spent(), llm: llmStats, at: new Date().toISOString() }, null, 1) + "\n");
console.log(`done; ${JSON.stringify(llmStats)}; paid spend $${spent().toFixed(4)}`);
