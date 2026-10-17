// Slice 4 runner: step D (record labels) on the slice's dev set, its 10-record smoke sample, or the held-out
// classifier set (eval/select/holdout/classify/records.json). See PREREG.md.
//
//   cd central && npx tsx ../eval/select/slice4/run4.mts --cand jev|clef|subq|codex|vercel:<model>|batch:<model>
//     --split smoke|dev|heldout [--tag T] [--batch 10] [--dry-run] [--concurrency 4] [--budget USD]
//
// Every candidate is asked the pipeline's labelQuestions() over the pipeline's recordState. Output:
// out/slice4/runs/<cand>-<split>[-tag]/answers.json ({unit: Classification}) and meta.json (counts, tokens, dollars,
// wall time). Usage lines go to out/slice4/usage.jsonl (this slice only); the run's cache is out/slice4/cache/<run>/
// so every run (and both Jev runs) starts empty: nothing from an earlier run or the store's cache is reused.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const OUT4 = join(SELECT, "out", "slice4");
process.env.UNSTALE_CENTRAL_DIR = join(OUT4, "central");
const { ChatClient, PROVIDERS, dollars, loadPrices, logUsageLine, priceOf, baseUrlOf } = await import("../client.ts");
const { ClassifierCache, Jev, keyFromEnvFile } = await import("../../../central/src/pipeline/classify/adapter.ts");
const { labelQuestions } = await import("../../../central/src/pipeline/classify/labels.ts");
const { runCodex } = await import("../../lib/codex.ts");
const { canonical, pool, sha256 } = await import("../../../central/src/pipeline/util.ts");
const { gatewayBalance, spendByProvider } = await import("../budget.ts");
const S = await import("../states.ts");
const { SubqClassifier } = await import("../subq.ts");
import type { Answer, Classification, Classifier, ChoiceQuestion, Questions } from "../../../central/src/pipeline/classify/adapter.ts";

const { values: a } = parseArgs({
  options: {
    cand: { type: "string" },
    split: { type: "string", default: "smoke" },
    tag: { type: "string" },
    batch: { type: "string", default: "10" },
    "dry-run": { type: "boolean", default: false },
    concurrency: { type: "string", default: "4" },
    budget: { type: "string" },
    "max-tokens": { type: "string", default: "4000" },
    // Compression arms (RESULTS-compress.md): question and record-state variants from questions.ts.
    qv: { type: "string", default: "base" },
    sv: { type: "string", default: "base" },
    "jev-cap": { type: "string", default: "0.5" },
  },
});
const cand = a.cand ?? "";
const split = a.split as "smoke" | "dev" | "heldout" | "heldout2" | "smoke2";
const USAGE = join(OUT4, "usage.jsonl");
const prices = loadPrices();
const GATEWAY_CAP = 3.0;
const runId = [cand.replace(/[^\w.-]+/g, "_"), split, ...(a.qv !== "base" ? [`q${a.qv}`] : []), ...(a.sv !== "base" ? [`s${a.sv}`] : []), ...(a.tag ? [a.tag] : [])].join("-");
const runDir = join(OUT4, "runs", runId);
const QV = await import("./questions.ts");
const q = a.qv === "base" ? labelQuestions() : QV.VARIANTS[a.qv!]!();

// ---- Units ----
interface Unit {
  uid: string;
  set: "benefit" | "breaking" | "heldout";
  state: Record<string, unknown>;
}

/** The breaking 241: items where the two reference judges agree (as eval/sets/score.py breaking). */
function breakingAgreed(): Set<string> {
  const brk = join(homedir(), "ati-slice2", "results", "datamodel", "breaking");
  const judge = (arm: string) => {
    const out = new Map<string, boolean>();
    for (const f of readdirSync(join(brk, arm)).sort()) {
      const run = JSON.parse(readFileSync(join(brk, arm, f), "utf8")) as { unit: { rids: string[] }; answer: Record<string, { breaking?: unknown }> };
      run.unit.rids.forEach((rid, n) => {
        const v = run.answer[`r${n + 1}`];
        if (v && typeof v.breaking === "boolean") out.set(rid, v.breaking);
      });
    }
    return out;
  };
  const p = judge("pipeline");
  const r = judge("reference");
  return new Set([...p].filter(([k, v]) => r.get(k) === v).map(([k]) => k));
}

function devUnits(): Unit[] {
  const agreed = breakingAgreed();
  const b = S.benefitUnits().units.map((u): Unit => ({ uid: `benefit:${u.id}`, set: "benefit", state: u.state }));
  const k = S.breakingUnits().units.filter((u) => agreed.has(u.id)).map((u): Unit => ({ uid: `breaking:${u.id}`, set: "breaking", state: u.state }));
  return [...b, ...k];
}
function heldoutUnits(): Unit[] {
  const recs = JSON.parse(readFileSync(join(SELECT, "holdout", "classify", "records.json"), "utf8")).records as Array<{ id: string; state: Record<string, unknown> }>;
  return recs.map((r) => ({ uid: `heldout:${r.id}`, set: "heldout", state: r.state }));
}
/** Held-out set 2 (PREREG "Confirm H on H2"): build_h2_units.py's records, state from the pipeline's recordState. */
async function heldout2Units(): Promise<Unit[]> {
  const { recordState } = await import("../../../central/src/pipeline/classify/labels.ts");
  const d = JSON.parse(readFileSync(join(OUT4, "h2-units.json"), "utf8")) as { units: Array<{ id: string; name: string; incoming: never }> };
  return d.units.map((u) => ({ uid: u.id, set: "heldout", state: recordState(u.name, u.incoming) }));
}
let units: Unit[] = split === "heldout" ? heldoutUnits() : split === "heldout2" || split === "smoke2" ? await heldout2Units() : devUnits();
units = units.map((u) => ({ ...u, state: QV.stateVariant(a.sv!, u.state) }));
if (split === "smoke" || split === "smoke2") units = [...units].sort((x, y) => sha256(`slice4:${x.uid}`).localeCompare(sha256(`slice4:${y.uid}`))).slice(0, 10);

// ---- Answer checking (adapter.ts checkAnswer, which is not exported) ----
function check(qid: string, qq: ChoiceQuestion, x: { choice?: unknown; probabilities?: Record<string, unknown> } | undefined): Answer {
  if (!x || typeof x.choice !== "string" || !(x.choice in qq.options)) throw new Error(`answer ${qid}: choice outside the set`);
  const probabilities: Record<string, number> = {};
  for (const o of Object.keys(qq.options)) {
    const p = x.probabilities?.[o];
    if (typeof p !== "number" || !Number.isFinite(p)) throw new Error(`answer ${qid}: no probability for ${o}`);
    probabilities[o] = p;
  }
  return { choice: x.choice, confidence: probabilities[x.choice]!, probabilities };
}
const firstObject = (t: string): Record<string, unknown> | undefined => {
  const m = /\{[\s\S]*\}/.exec(t.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  try {
    const v = m ? JSON.parse(m[0]) : undefined;
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
};
function parseAll(t: string, questions: Questions): Record<string, Answer> | undefined {
  const raw = firstObject(t) as Record<string, { choice?: unknown; probabilities?: Record<string, unknown> }> | undefined;
  if (!raw) return undefined;
  try {
    return Object.fromEntries(Object.entries(questions).map(([id, qq]) => [id, check(id, qq, raw[id])]));
  } catch {
    return undefined;
  }
}

// ---- Candidates ----
const meter = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, dollars: 0, unpriced: 0 };
function log(provider: string, model: string, u: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number | null }, d: number | null, extra: Record<string, unknown> = {}) {
  meter.calls++;
  meter.input += u.input_tokens;
  meter.cached += u.cached_input_tokens;
  meter.output += u.output_tokens;
  meter.reasoning += u.reasoning_tokens ?? 0;
  if (d === null) meter.unpriced++;
  else meter.dollars += d;
  logUsageLine(USAGE, { step: `classify:${runId}`, provider, model, ...u, dollars: d, ...extra });
}

/** A System One classifier (Jev, or Clef Flash on Workers AI, which speaks the same request and answer shape). */
function systemOne(kind: "jev" | "clef"): Classifier {
  const model = kind === "jev" ? "jev-latest" : "clef-flash";
  const cf = PROVIDERS.cloudflare!;
  const f: typeof fetch = async (url, init) => {
    let res: Response;
    if (kind === "clef") {
      const target = `${baseUrlOf(cf).replace(/\/ai\/v1$/, "")}/ai/run/@cf/cloudflare/clef-flash`;
      res = await fetch(target, { ...init, headers: { Authorization: `Bearer ${keyFromEnvFile(cf.keyFile, cf.keyVar)()}`, "Content-Type": "application/json" } });
      if (!res.ok) {
        console.error(`clef: HTTP ${res.status} ${(await res.clone().text()).slice(0, 300)}`);
        return res;
      }
      const j = (await res.json()) as { result?: unknown };
      res = new Response(JSON.stringify(j.result ?? j), { status: 200, headers: { "Content-Type": "application/json" } });
    } else res = await fetch(url, init);
    if (res.ok) {
      const j = (await res.clone().json().catch(() => undefined)) as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
      const u = { input_tokens: j?.usage?.input_tokens ?? 0, cached_input_tokens: 0, output_tokens: j?.usage?.output_tokens ?? 0, reasoning_tokens: null };
      const d = kind === "jev" ? dollars(priceOf(prices, "jev", "jev-latest"), u) : (u.input_tokens * 0.038) / 1e6;
      log(kind === "jev" ? "jev" : "cloudflare", model, u, d, kind === "clef" ? { cost_source: "input only at $0.038/M (output price unknown); free tier" } : {});
    }
    return res;
  };
  return new Jev({ model, fetch: f, apiKey: kind === "clef" ? () => "unused" : undefined });
}

const MAX_TOKENS = Number(a["max-tokens"]);
const EXTRA: Record<string, Record<string, unknown>> = {
  "openai/gpt-oss-20b": { reasoning_effort: "low" },
  "openai/gpt-oss-120b": { reasoning_effort: "low" },
  "alibaba/qwen3.8-flash": { reasoning_effort: "none" },
  "deepseek/deepseek-v4-flash": { reasoning_effort: "none" },
};
const chat = new ChatClient({ provider: PROVIDERS.vercel!, cacheDir: join(OUT4, "cache", runId, "chat"), usageLog: join(OUT4, "chat-usage.jsonl"), concurrency: Number(a.concurrency) });
// The chat arms' prompt as slice 4 ran them: the pipeline's fallback prompt before 2fa5db0 (choice plus a probability per
// option, which parseAll requires). The pipeline now asks for choices only (RESULTS-choice.md).
const CHAT_PROMPT = `You answer closed-choice questions about a record. Read the state and answer every question by picking
exactly one of its options and giving a probability for every option (the probabilities of one question sum to 1).

Output only a JSON object, no prose: {"<question id>": {"choice": "<option>", "probabilities": {"<option>": <0..1>, ...}}, ...}

State:
%STATE%

Questions:
%QUESTIONS%
`;
const chatPrompt = (state: Record<string, unknown>, questions: Questions): string =>
  CHAT_PROMPT.replace("%STATE%", canonical(state)).replace("%QUESTIONS%", JSON.stringify(Object.fromEntries(Object.entries(questions).map(([id, x]) => [id, { instructions: x.instructions, options: x.options }])), null, 1));

/** Chat over the gateway: the pipeline's Codex-fallback prompt; an answer must parse in full or it is retried (3 attempts). */
async function chatAsk(model: string, prompt: string, validate: (t: string) => unknown): Promise<string | undefined> {
  const c = await chat.complete({ model, messages: [{ role: "user", content: prompt }], max_tokens: MAX_TOKENS, ...(EXTRA[model] ?? {}) }, (t) => (validate(t) === undefined ? undefined : t), { step: `classify:${runId}` });
  return c.value;
}

/** Luna through codex exec (the user's plan), costed prompt-only at list price; up to 2 attempts as CodexClassifier. */
async function codexAsk(prompt: string, validate: (t: string) => unknown): Promise<string | undefined> {
  const price = priceOf(prices, "codex", "gpt-5.6-luna");
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runCodex(prompt, "gpt-5.6-luna");
    if (r.usage) {
      const promptTokens = Math.ceil(prompt.length / 4);
      const u = { input_tokens: r.usage.input_tokens, cached_input_tokens: r.usage.cached_input_tokens, output_tokens: r.usage.output_tokens, reasoning_tokens: null };
      log("codex", "gpt-5.6-luna", u, dollars(price, { input_tokens: promptTokens, cached_input_tokens: 0, output_tokens: u.output_tokens, reasoning_tokens: null }), {
        prompt_tokens_est: promptTokens, harness_dollars: dollars(price, u), cost_source: "prompt-only at list price (chars/4 + codex output tokens); the plan is billed",
      });
    }
    if (r.code === 0 && validate(r.text) !== undefined) return r.text;
  }
  return undefined;
}

function askerFor(c: string): ((prompt: string, validate: (t: string) => unknown) => Promise<string | undefined>) | undefined {
  if (c === "codex") return codexAsk;
  const m = /^(?:vercel|batch):(.+)$/.exec(c);
  return m ? (p, v) => chatAsk(m[1]!, p, v) : undefined;
}

// ---- Batched structure: b records per call, the questions once ----
const BATCH_PROMPT = `You answer closed-choice questions about each of several records. Read every record's state and answer every
question for every record by picking exactly one of its options and giving a probability for every option (the
probabilities of one question sum to 1). Judge each record on its own state only.

Output only a JSON object, no prose: {"<record id>": {"<question id>": {"choice": "<option>", "probabilities": {"<option>": <0..1>, ...}}, ...}, ...}

Records (id → state):
%STATES%

Questions (ask each of them of every record):
%QUESTIONS%
`;
function batchPrompt(us: Unit[]): string {
  const states = us.map((u, i) => `"r${i + 1}": ${canonical(u.state)}`).join(",\n");
  const qs = Object.fromEntries(Object.entries(q).map(([id, x]) => [id, { instructions: x.instructions, options: x.options }]));
  return BATCH_PROMPT.replace("%STATES%", `{\n${states}\n}`).replace("%QUESTIONS%", JSON.stringify(qs, null, 1));
}
function parseBatch(t: string, n: number): Map<number, Record<string, Answer>> {
  const raw = firstObject(t) as Record<string, unknown> | undefined;
  const out = new Map<number, Record<string, Answer>>();
  if (!raw) return out;
  for (let i = 0; i < n; i++) {
    const r = raw[`r${i + 1}`];
    if (!r || typeof r !== "object") continue;
    const p = parseAll(JSON.stringify(r), q);
    if (p) out.set(i, p);
  }
  return out;
}

// ---- Plan, guard, run ----
const tok3 = (s: string) => Math.ceil(s.length / 3);
const isBatch = cand.startsWith("batch:");
const B = Number(a.batch);
const sysOne = cand === "jev" || cand === "clef" || cand === "subq";
let planIn = 0;
let planOut = 0;
if (isBatch) for (let i = 0; i < units.length; i += B) (planIn += tok3(batchPrompt(units.slice(i, i + B)))), (planOut += MAX_TOKENS * 2);
else for (const u of units) (planIn += tok3(sysOne ? JSON.stringify({ state: u.state, questions: q }) : chatPrompt(u.state, q))), (planOut += sysOne ? 0 : MAX_TOKENS);
const modelOf = cand.replace(/^(vercel|batch):/, "");
const price = cand === "jev" ? priceOf(prices, "jev", "jev-latest") : cand === "subq" ? priceOf(prices, "subq", "subq-snap-preview") : cand === "codex" ? priceOf(prices, "codex", "gpt-5.6-luna") : cand === "clef" ? { input: 0.038, output: 0, cached_input: null } as never : priceOf(prices, "vercel", modelOf);
const worst = price ? dollars(price, { input_tokens: planIn, cached_input_tokens: 0, output_tokens: planOut, reasoning_tokens: null }) : null;
console.log(`${runId}: ${units.length} units, worst case ${planIn} input + ${planOut} output tokens = ${worst === null ? "unknown" : `$${worst.toFixed(4)}`} (input chars/3, output = max_tokens per call)`);
if (a["dry-run"]) process.exit(0);
if (cand.startsWith("vercel:") || isBatch) {
  const mine = Object.values(spendByProvider(join(OUT4, "chat-usage.jsonl"))).reduce((s, x) => s + x.dollars, 0);
  const bal = await gatewayBalance();
  console.log(`gateway: this slice spent $${mine.toFixed(4)} of its $${GATEWAY_CAP}; live balance $${bal.toFixed(4)}`);
  if (mine >= GATEWAY_CAP || bal < 1.5) throw new Error("gateway budget exhausted");
}
if (cand === "jev") {
  const jevSpent = spendByProvider(USAGE).jev?.dollars ?? 0;
  if (jevSpent > Number(a["jev-cap"])) throw new Error(`jev slice spend $${jevSpent} > $${a["jev-cap"]}`);
}

const cache = new ClassifierCache(join(OUT4, "cache", runId, "cls"));
const answers: Record<string, Classification | null> = {};
const timing: Record<string, number> = {};
const t0 = Date.now();
let done = 0;
const tick = () => {
  if (++done % 25 === 0) console.log(`  ${done}/${units.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
};
const conc = Number(a.concurrency);
if (sysOne) {
  // SubQ Snap (eval/select/subq.ts) takes Jev's request and answer shape at its own endpoint.
  const cls = cand === "subq" ? new SubqClassifier({ step: `classify:${runId}`, onUsage: (u, d) => log("subq", "subq-snap-preview", u, d) }) : systemOne(cand as "jev" | "clef");
  await pool(units, conc, async (u) => {
    const s = Date.now();
    const hit = cache.get(cls, u.state, q);
    try {
      const r = hit ?? (await cls.classify(u.state, q));
      if (!hit) cache.put(cls, u.state, q, r);
      answers[u.uid] = r;
    } catch (e) {
      console.error(`${u.uid}: ${e instanceof Error ? e.message : String(e)}`);
      answers[u.uid] = null;
    }
    timing[u.uid] = Date.now() - s;
    tick();
  });
} else if (!isBatch) {
  const ask = askerFor(cand);
  if (!ask) throw new Error(`unknown candidate ${cand}`);
  const name = cand === "codex" ? "codex" : "vercel";
  const fake: Classifier = { name: "codex", model: `${name}:${modelOf}`, classify: async () => { throw new Error("unused"); } };
  await pool(units, conc, async (u) => {
    const s = Date.now();
    const hit = cache.get(fake, u.state, q);
    if (hit) answers[u.uid] = hit;
    else {
      const t = await ask(chatPrompt(u.state, q), (x) => parseAll(x, q));
      const p = t === undefined ? undefined : parseAll(t, q);
      answers[u.uid] = p ? { classifier: "codex", model: modelOf, answers: p } : null;
      if (answers[u.uid]) cache.put(fake, u.state, q, answers[u.uid]!);
    }
    timing[u.uid] = Date.now() - s;
    tick();
  });
} else {
  const ask = askerFor(cand)!;
  const groups: Unit[][] = [];
  for (let i = 0; i < units.length; i += B) groups.push(units.slice(i, i + B));
  let singles = 0;
  await pool(groups, conc, async (g) => {
    const s = Date.now();
    // A batch answer is accepted when it parses as an object; records missing from it are retried alone.
    const t = await ask(batchPrompt(g), (x) => (parseBatch(x, g.length).size ? x : undefined));
    const got = t === undefined ? new Map() : parseBatch(t, g.length);
    for (const [i, u] of g.entries()) {
      let p = got.get(i);
      if (!p) {
        singles++;
        const t1 = await ask(chatPrompt(u.state, q), (x) => parseAll(x, q));
        p = t1 === undefined ? undefined : parseAll(t1, q);
      }
      answers[u.uid] = p ? { classifier: "codex", model: modelOf, answers: p } : null;
      timing[u.uid] = (Date.now() - s) / g.length;
      tick();
    }
  });
  console.log(`batch: ${groups.length} calls of up to ${B}; ${singles} records retried alone`);
}

if (!sysOne && cand !== "codex") {
  const st = chat.stats;
  // Copy the chat client's exact per-run totals into this slice's log summary.
  meter.calls += st.calls;
  meter.input += st.input_tokens;
  meter.cached += st.cached_input_tokens;
  meter.output += st.output_tokens;
  meter.reasoning += st.reasoning_tokens;
  meter.dollars += st.dollars;
  meter.unpriced += st.unpriced_calls;
}
const answered = Object.values(answers).filter(Boolean).length;
const wall = (Date.now() - t0) / 1000;
const meta = { runId, cand, split, units: units.length, answered, parse_rate: answered / units.length, wall_s: wall, units_per_s: units.length / wall, concurrency: conc, ...meter, dollars_per_record: meter.dollars / units.length, calls_per_record: meter.calls / units.length, input_per_record: meter.input / units.length, output_per_record: meter.output / units.length, reasoning_per_record: meter.reasoning / units.length, timing_ms_median: Object.values(timing).sort((x, y) => x - y)[Math.floor(Object.keys(timing).length / 2)] };
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, "answers.json"), JSON.stringify(answers, null, 1) + "\n");
writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 1) + "\n");
console.log(JSON.stringify(meta, null, 1));
if (!existsSync(runDir)) process.exit(1);
