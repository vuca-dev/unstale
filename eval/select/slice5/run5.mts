// Slice 5 runner: step E, the same-or-new judge (match.ts matchRequest), on the faithful judge requests of the three
// matching sets (states.ts). See PREREG.md.
//
//   cd central && npx tsx ../eval/select/slice5/run5.mts --units            # write out/slice5/units.json (no calls)
//   cd central && npx tsx ../eval/select/slice5/run5.mts --cand jev|codex|vercel:<model>|embed:<model>
//     --split smoke|dev|heldout [--tag T] [--dry-run] [--concurrency 4]
//
// Every request is the pipeline's own (byte-identical, proven by states.ts). Chat models get the pipeline's
// CodexClassifier prompt; an answer must parse in full (every same_cK with a probability) or it is retried (3 attempts).
// Embedding: cosine between the incoming brief and each candidate brief (the state's JSON objects), as p(same).
// Output: out/slice5/runs/<run>/answers.json ({request key: Classification | null}) and meta.json. Usage lines:
// out/slice5/usage.jsonl (this slice only). Each run has its own empty cache (out/slice5/cache/<run>/).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const OUT5 = join(SELECT, "out", "slice5");
process.env.UNSTALE_CENTRAL_DIR = join(OUT5, "central");
const { ChatClient, PROVIDERS, dollars, loadPrices, logUsageLine, priceOf, reportedCost } = await import("../client.ts");
const { ClassifierCache, CodexClassifier, Jev, keyFromEnvFile } = await import("../../../central/src/pipeline/classify/adapter.ts");
const { runCodex } = await import("../../../central/src/pipeline/codex.ts");
const { canonical, pool, sha256 } = await import("../../../central/src/pipeline/util.ts");
const { gatewayBalance, spendByProvider } = await import("../budget.ts");
const S = await import("../states.ts");
import type { Answer, Classification, Classifier, ChoiceQuestion, Questions } from "../../../central/src/pipeline/classify/adapter.ts";

const { values: a } = parseArgs({
  options: {
    units: { type: "boolean", default: false },
    cand: { type: "string" },
    split: { type: "string", default: "smoke" },
    tag: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    concurrency: { type: "string", default: "4" },
    "max-tokens": { type: "string", default: "2000" },
  },
});
const USAGE = join(OUT5, "usage.jsonl");
const UNITS = join(OUT5, "units.json");
const GATEWAY_CAP = 1.5; // this slice's total gateway spend
const CAND_CAP = 0.4; // abort a candidate projected above this

// ---- Units ----
export interface Req { key: string; set: string; state: Record<string, unknown>; questions: Questions; split: "dev" | "heldout" }
if (a.units) {
  const built = { within: await S.withinUnits(), guides: S.guideUnits(), nuxt: await S.nuxtUnits() };
  const splitOf = (set: string, tech: string): "dev" | "heldout" => (set === "nuxt" || (set === "guides" && tech === "next") ? "heldout" : "dev");
  const units = Object.values(built).flatMap((b) => b.units).map((u) => ({
    set: u.set, n: u.n, tech: u.tech, key: u.key, candidate: u.candidate, index: u.index, p_audit: u.p, verdict: u.verdict, cross: u.cross,
    split: splitOf(u.set, u.tech), req: sha256(canonical([u.state, u.questions])), cands: u.cands, guardInc: u.guardInc, ncands: u.cands.length,
  }));
  const reqs: Record<string, Req> = {};
  for (const b of Object.values(built)) for (const u of b.units) reqs[sha256(canonical([u.state, u.questions]))] = { key: sha256(canonical([u.state, u.questions])), set: u.set, state: u.state, questions: u.questions, split: splitOf(u.set, u.tech) };
  const excluded = Object.fromEntries(Object.entries(built).map(([k, b]) => [k, b.excluded]));
  mkdirSync(OUT5, { recursive: true });
  writeFileSync(UNITS, JSON.stringify({ units, reqs, excluded }) + "\n");
  for (const [k, b] of Object.entries(built)) console.log(`${k}: ${b.units.length} faithful pairs, ${b.excluded.length} excluded`);
  console.log(`requests: ${Object.keys(reqs).length} (dev ${Object.values(reqs).filter((r) => r.split === "dev").length}, heldout ${Object.values(reqs).filter((r) => r.split === "heldout").length})`);
  process.exit(0);
}

const cand = a.cand ?? "";
const split = a.split as "smoke" | "dev" | "heldout";
const prices = loadPrices();
const runId = [cand.replace(/[^\w.-]+/g, "_"), split, ...(a.tag ? [a.tag] : [])].join("-");
const runDir = join(OUT5, "runs", runId);
const all = JSON.parse(readFileSync(UNITS, "utf8")) as { reqs: Record<string, Req> };
let reqs = Object.values(all.reqs).filter((r) => (split === "heldout" ? r.split === "heldout" : r.split === "dev"));
if (split === "smoke") reqs = [...reqs].sort((x, y) => sha256(`slice5:${x.key}`).localeCompare(sha256(`slice5:${y.key}`))).slice(0, 5);

// ---- Answer checking (as adapter.ts checkAnswer) ----
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

// ---- Metering ----
const meter = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, dollars: 0, unpriced: 0 };
function log(provider: string, model: string, u: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number | null }, d: number | null, extra: Record<string, unknown> = {}) {
  meter.calls++;
  meter.input += u.input_tokens;
  meter.cached += u.cached_input_tokens;
  meter.output += u.output_tokens;
  meter.reasoning += u.reasoning_tokens ?? 0;
  if (d === null) meter.unpriced++;
  else meter.dollars += d;
  logUsageLine(USAGE, { step: `judge:${runId}`, provider, model, ...u, dollars: d, ...extra });
}

// ---- Candidates ----
function jev(): Classifier {
  const f: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    if (res.ok) {
      const j = (await res.clone().json().catch(() => undefined)) as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
      const u = { input_tokens: j?.usage?.input_tokens ?? 0, cached_input_tokens: 0, output_tokens: j?.usage?.output_tokens ?? 0, reasoning_tokens: null };
      log("jev", "jev-latest", u, dollars(priceOf(prices, "jev", "jev-latest"), u));
    }
    return res;
  };
  return new Jev({ model: "jev-latest", fetch: f });
}

const EXTRA: Record<string, Record<string, unknown>> = {
  "openai/gpt-oss-20b": { reasoning_effort: "low" },
  "alibaba/qwen3.8-flash": { reasoning_effort: "none" },
  "deepseek/deepseek-v4-flash": { reasoning_effort: "none" },
  "google/gemini-3.1-flash-lite": { reasoning_effort: "none" },
};
const MAX_TOKENS = Number(a["max-tokens"]);
const chat = new ChatClient({ provider: PROVIDERS.vercel!, cacheDir: join(OUT5, "cache", runId, "chat"), usageLog: join(OUT5, "chat-usage.jsonl"), concurrency: Number(a.concurrency) });
const codexPrompt = new CodexClassifier({ run: async () => ({ text: "", code: 1 }) });

async function chatAsk(model: string, prompt: string, validate: (t: string) => unknown): Promise<string | undefined> {
  const c = await chat.complete({ model, messages: [{ role: "user", content: prompt }], max_tokens: MAX_TOKENS, ...(EXTRA[model] ?? {}) }, (t) => (validate(t) === undefined ? undefined : t), { step: `judge:${runId}` });
  return c.value;
}
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

// Embedding: one input per brief; cosine as p(same) for every candidate. Uses the gateway's /v1/embeddings.
const embCache = new Map<string, number[]>();
async function embed(model: string, texts: string[]): Promise<number[][]> {
  const todo = [...new Set(texts.filter((t) => !embCache.has(t)))];
  if (todo.length) {
    const key = keyFromEnvFile(PROVIDERS.vercel!.keyFile, PROVIDERS.vercel!.keyVar)();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch("https://ai-gateway.vercel.sh/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: todo }) });
      if (!res.ok) {
        if (attempt < 2) continue;
        throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const j = (await res.json()) as { data: Array<{ embedding: number[]; index: number }>; usage?: { prompt_tokens?: number; total_tokens?: number } };
      for (const d of j.data) embCache.set(todo[d.index]!, d.embedding);
      const inTok = j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? 0;
      const rc = reportedCost(j);
      log("vercel", model, { input_tokens: inTok, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: null }, rc ?? (inTok * 0.01) / 1e6, { cost_source: rc === undefined ? "list $0.01/M (gateway /v1/models)" : "provider", texts: todo.length });
      break;
    }
  }
  return texts.map((t) => embCache.get(t)!);
}
const cos = (x: number[], y: number[]) => {
  let d = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) (d += x[i]! * y[i]!), (nx += x[i]! * x[i]!), (ny += y[i]! * y[i]!);
  return d / Math.sqrt(nx * ny);
};

// ---- Plan, guard, run ----
const tok3 = (s: string) => Math.ceil(s.length / 3);
const modelOf = cand.replace(/^(vercel|embed):/, "");
const isEmbed = cand.startsWith("embed:");
let planIn = 0, planOut = 0;
for (const r of reqs) {
  if (cand === "jev") planIn += tok3(JSON.stringify({ state: r.state, questions: r.questions }));
  else if (isEmbed) planIn += tok3(JSON.stringify(r.state));
  else (planIn += tok3(codexPrompt.prompt(r.state, r.questions))), (planOut += MAX_TOKENS);
}
const price = cand === "cache" ? ({ input: 0, output: 0, cached_input: null } as never) : cand === "jev" ? priceOf(prices, "jev", "jev-latest") : cand === "codex" ? priceOf(prices, "codex", "gpt-5.6-luna") : isEmbed ? ({ input: 0.01, output: 0, cached_input: null } as never) : priceOf(prices, "vercel", modelOf);
const worst = price ? dollars(price, { input_tokens: planIn, cached_input_tokens: 0, output_tokens: planOut, reasoning_tokens: null }) : null;
console.log(`${runId}: ${reqs.length} requests, worst case ${planIn} input + ${planOut} output tokens = ${worst === null ? "unknown" : `$${worst.toFixed(4)}`} (input chars/3, output = max_tokens per call)`);
if (a["dry-run"]) process.exit(0);
if (cand.startsWith("vercel:") || isEmbed) {
  const mine = Object.values(spendByProvider(join(OUT5, "chat-usage.jsonl"))).reduce((s, x) => s + x.dollars, 0) + (spendByProvider(USAGE).vercel?.dollars ?? 0);
  const bal = await gatewayBalance();
  console.log(`gateway: this slice spent $${mine.toFixed(4)} of its $${GATEWAY_CAP}; live balance $${bal.toFixed(4)}`);
  if (mine >= GATEWAY_CAP || bal < 1.5) throw new Error("gateway budget exhausted");
}
if (cand === "jev" && (spendByProvider(USAGE).jev?.dollars ?? 0) > 0.3) throw new Error("jev slice spend above $0.30");

const cache = new ClassifierCache(join(OUT5, "cache", runId, "cls"));
const answers: Record<string, Classification | null> = {};
const timing: number[] = [];
const t0 = Date.now();
let done = 0;
const tick = () => {
  if (++done % 25 === 0) console.log(`  ${done}/${reqs.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
};
const conc = Number(a.concurrency);
if (cand === "cache") {
  const dirs: Record<string, string | string[]> = { within: join(S.STORE, "central-v1", "cache", "classifier"), guides: S.GUIDE_CACHES, nuxt: join(S.STORE, "central-trust-nuxt", "cache", "classifier") };
  for (const r of reqs) answers[r.key] = S.cached(dirs[r.set]!, r.state, r.questions) ?? null;
} else if (cand === "jev") {
  const cls = jev();
  await pool(reqs, conc, async (r) => {
    const s = Date.now();
    const hit = cache.get(cls, r.state, r.questions);
    try {
      const x = hit ?? (await cls.classify(r.state, r.questions));
      if (!hit) cache.put(cls, r.state, r.questions, x);
      answers[r.key] = x;
    } catch (e) {
      console.error(`${r.key}: ${e instanceof Error ? e.message : String(e)}`);
      answers[r.key] = null;
    }
    timing.push(Date.now() - s);
    tick();
  });
} else if (isEmbed) {
  await pool(reqs, conc, async (r) => {
    const s = Date.now();
    const st = r.state as { incoming: unknown; candidates: Record<string, unknown> };
    const ids = Object.keys(r.questions).map((q) => q.replace("same_", ""));
    const texts = [canonical(st.incoming), ...ids.map((c) => canonical(st.candidates[c]))];
    const v = await embed(modelOf, texts);
    const ans: Record<string, Answer> = {};
    ids.forEach((c, i) => {
      const p = Math.max(0, Math.min(1, cos(v[0]!, v[i + 1]!)));
      ans[`same_${c}`] = { choice: p >= 0.5 ? "yes" : "no", confidence: Math.max(p, 1 - p), probabilities: { yes: p, no: 1 - p } };
    });
    answers[r.key] = { classifier: "codex", model: modelOf, answers: ans };
    timing.push(Date.now() - s);
    tick();
  });
} else {
  const ask = cand === "codex" ? codexAsk : (p: string, v: (t: string) => unknown) => chatAsk(modelOf, p, v);
  const fake: Classifier = { name: "codex", model: cand, classify: async () => { throw new Error("unused"); } };
  await pool(reqs, conc, async (r) => {
    const s = Date.now();
    const hit = cache.get(fake, r.state, r.questions);
    if (hit) answers[r.key] = hit;
    else {
      const t = await ask(codexPrompt.prompt(r.state, r.questions), (x) => parseAll(x, r.questions));
      const p = t === undefined ? undefined : parseAll(t, r.questions);
      answers[r.key] = p ? { classifier: "codex", model: modelOf, answers: p } : null;
      if (answers[r.key]) cache.put(fake, r.state, r.questions, answers[r.key]!);
    }
    timing.push(Date.now() - s);
    tick();
  });
  if (cand !== "codex") {
    const st = chat.stats;
    meter.calls += st.calls;
    meter.input += st.input_tokens;
    meter.cached += st.cached_input_tokens;
    meter.output += st.output_tokens;
    meter.reasoning += st.reasoning_tokens;
    meter.dollars += st.dollars;
    meter.unpriced += st.unpriced_calls;
  }
}
const answered = Object.values(answers).filter(Boolean).length;
const wall = (Date.now() - t0) / 1000;
const n = reqs.length;
const meta = { runId, cand, split, requests: n, answered, parse_rate: answered / n, wall_s: wall, concurrency: conc, ...meter, dollars_per_request: meter.dollars / n, calls_per_request: meter.calls / n, input_per_request: meter.input / n, output_per_request: meter.output / n, reasoning_per_request: meter.reasoning / n, timing_ms_median: timing.sort((x, y) => x - y)[Math.floor(timing.length / 2)] };
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, "answers.json"), JSON.stringify(answers, null, 1) + "\n");
writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 1) + "\n");
console.log(JSON.stringify(meta, null, 1));
if (!existsSync(runDir)) process.exit(1);
