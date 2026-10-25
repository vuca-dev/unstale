// Three orthogonal compression experiments and two fresh baselines. Plan-only unless --execute is passed.
// Reused H1/H2 benchmarks screen directions; a winner still needs an independent confirmation set before shipping.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Jev, type Classification, type Questions } from "../../../central/src/pipeline/classify/adapter.ts";
import { labelQuestions, recordState } from "../../../central/src/pipeline/classify/labels.ts";
import { canonical, pool, sha256, writeAtomic } from "../../../central/src/pipeline/util.ts";

const { values } = parseArgs({ options: {
  "data-root": { type: "string", default: join(import.meta.dirname, "../../..") },
  out: { type: "string", default: join(import.meta.dirname, "../out/slice4/compact-20261025") },
  execute: { type: "boolean", default: false },
} });
const root = values["data-root"]!;
const out = values.out!;
const CAP = 1.25;
const PRICE = 0.042 / 1e6; // typesafe.ai: $42 per billion input tokens, verified 25 October 2026.
const CONCURRENCY = 2;
const base = labelQuestions();
const surface = {
  instructions: "Where does a project meet this change?",
  options: {
    code_api: "Application code calls, imports, implements or extends it.",
    configuration: "Config file or object, setting or environment variable.",
    file_convention: "Recognised file or directory name or location.",
    command_line: "Terminal command, subcommand, flag or package.json script.",
    schema_or_migration: "Database schema, data model or migration.",
    types_only: "Types only; no runtime change.",
    runtime_internal: "Runtime behaviour; nothing for the project to write.",
    build_tooling: "Build, bundler, compiler or dev-server output/behaviour.",
    other: "None of the above.",
  },
};
const breaking = {
  instructions: "Breaking means an unchanged project that worked before fails (runtime, build, types or commands) " +
    "or behaves noticeably differently after upgrading. Removals and raised minimum runtime/dependency versions count. " +
    "Not breaking: new optional features/options; deprecations that still work; recommendations, optional modernisation " +
    "or new-project defaults existing projects need not adopt; fixes restoring documented behaviour; docs changes. " +
    "Judge effects on existing code, not the section title. If the source does not show existing code fails or changes behaviour, no.",
  options: { ...base.breaking!.options },
};
const arms: Record<string, Questions> = {
  baseline: base,
  repeat: structuredClone(base),
  surface: { ...structuredClone(base), surface },
  breaking: { ...structuredClone(base), breaking },
  combined: { ...structuredClone(base), surface, breaking },
};
for (const [arm, q] of Object.entries(arms)) {
  for (const key of Object.keys(base).filter((k) => k !== "surface" && k !== "breaking")) {
    if (canonical(q[key]) !== canonical(base[key])) throw Error(`${arm}: changed protected question ${key}`);
  }
}
interface Unit { id: string; set: string; state: Record<string, unknown> }
const h1path = join(root, "eval/select/holdout/classify/records.json");
const h2path = join(root, "eval/select/out/slice4/h2-units.json");
const h1 = JSON.parse(readFileSync(h1path, "utf8")).records;
const h2 = JSON.parse(readFileSync(h2path, "utf8")).units;
const units: Unit[] = [
  ...h1.map((r: { id: string; state: Record<string, unknown> }) => ({ id: `h1:${r.id}`, set: "h1", state: r.state })),
  ...h2.map((r: { id: string; name: string; incoming: Parameters<typeof recordState>[1] }) => ({ id: r.id, set: "h2", state: recordState(r.name, r.incoming) })),
].sort((a, b) => sha256(`compact-20261025:${a.id}`).localeCompare(sha256(`compact-20261025:${b.id}`)));
const reservedPlan = Object.values(arms).reduce((sum, q) => sum + units.reduce((n, u) => n +
  (Buffer.byteLength(JSON.stringify({ model: "jev-latest", state: u.state, questions: Object.fromEntries(Object.entries(q).map(([id, x]) => [id, { type: "choice", instructions: x.instructions, criteria: x.options }])) })) + 1024) * PRICE, 0), 0);
if (reservedPlan > CAP) throw Error(`planned reservation $${reservedPlan} exceeds cap $${CAP}`);
const plan = {
  arms, counts: { h1: h1.length, h2: h2.length }, seed: "compact-20261025", concurrency: CONCURRENCY,
  planned_reserved_dollars: reservedPlan, price_per_million_input: PRICE * 1e6, cap_dollars: CAP, retries: 0,
  data_sha256: { h1: sha256(readFileSync(h1path)), h2: sha256(readFileSync(h2path)) },
  unit_sha256: sha256(canonical(units)),
  decision: "Exploratory on reused H1/H2. Keep live thresholds 0.5. No measured decline in breaking recall/precision, obligation recall, change_type accuracy, benefit recall/precision, actionable recall or benefit exact agreement. Examine section-cluster paired intervals and baseline repeat noise. No production adoption without fresh independent confirmation.",
};
mkdirSync(out, { recursive: true });
const planText = JSON.stringify(plan, null, 2) + "\n";
if (existsSync(join(out, "plan.json")) && readFileSync(join(out, "plan.json"), "utf8") !== planText) throw Error("frozen plan differs");
writeAtomic(join(out, "plan.json"), planText);
console.log(JSON.stringify({ plan: join(out, "plan.json"), units: units.length, calls: units.length * Object.keys(arms).length, cap: CAP }));
if (!values.execute) process.exit(0);
process.env.UNSTALE_CENTRAL_DIR = join(out, "central");
let model: string | undefined;
let reserved = 0;
let actual = 0;
let paid = 0;
let stopped = false;
const usage: Record<string, unknown>[] = existsSync(join(out, "usage.json")) ? JSON.parse(readFileSync(join(out, "usage.json"), "utf8")) : [];
reserved = usage.reduce((n, u) => n + Number(u.reserved_dollars), 0);
actual = usage.reduce((n, u) => n + Number(u.dollars ?? 0), 0);
model = usage.find((u) => typeof u.model === "string")?.model as string | undefined;
const answers: Record<string, Record<string, Classification | null>> = {};
for (const arm of Object.keys(arms)) answers[arm] = existsSync(join(out, `${arm}.json`)) ? JSON.parse(readFileSync(join(out, `${arm}.json`), "utf8")) : {};
const checkpoint = () => {
  writeAtomic(join(out, "usage.json"), JSON.stringify(usage) + "\n");
  for (const arm of Object.keys(arms)) writeAtomic(join(out, `${arm}.json`), JSON.stringify(answers[arm]) + "\n");
};
async function ask(arm: string, u: Unit): Promise<void> {
  if (Object.hasOwn(answers[arm]!, u.id) || stopped) return;
  const metered: typeof fetch = async (url, init) => {
    // Reserve for every attempted request, including failures without usage. Bytes + 1k overhead is a conservative
    // input-token bound for these UTF-8 JSON prompts; reservations are retained across a resumed experiment.
    const bound = (Buffer.byteLength(String(init?.body ?? "")) + 1024) * PRICE;
    if (reserved + bound > CAP) { stopped = true; throw Error("experiment cap reached"); }
    reserved += bound;
    const row: Record<string, unknown> = { arm, id: u.id, reserved_dollars: bound };
    usage.push(row);
    checkpoint();
    const res = await fetch(url, init);
    if (!res.ok) { row.status = res.status; stopped = true; checkpoint(); return res; }
    const j = await res.clone().json() as { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    if (!j.model || !j.usage || typeof j.usage.input_tokens !== "number") { stopped = true; throw Error("missing model/usage"); }
    if (model && model !== j.model) { stopped = true; throw Error(`model changed: ${model} -> ${j.model}`); }
    model = j.model;
    const dollars = j.usage.input_tokens * PRICE;
    actual += dollars; paid++;
    Object.assign(row, { model, ...j.usage, dollars });
    checkpoint();
    return res;
  };
  try {
    answers[arm]![u.id] = await new Jev({ model: model ?? "jev-latest", fetch: metered, retries: 0 }).classify(u.state, arms[arm]!);
  } catch (e) {
    answers[arm]![u.id] = null;
    console.error(`${arm} ${u.id}: ${String(e)}`);
    // A missing/failed answer is never retried for this experiment and is counted wrong in analysis.
  }
  checkpoint();
  if (paid % 50 === 0) console.log(JSON.stringify({ calls: paid, dollars: actual, reserved, model }));
}
// First call discovers the current version, then all arms explicitly request that same model.
await ask("baseline", units[0]!);
await pool(units, CONCURRENCY, async (u, i) => {
  const names = Object.keys(arms);
  for (let n = 0; n < names.length; n++) await ask(names[(i + n) % names.length]!, u);
});
console.log(JSON.stringify({ calls: usage.length, dollars: actual, reserved, stopped, model }));
if (stopped) process.exitCode = 2;
