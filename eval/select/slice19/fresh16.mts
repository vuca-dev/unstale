// Slice 19 part 2 (PREREG.md), step E fresh confirmation: slice 16's short-rules judge requests, rebuilt by replaying
// slice16/build.mts, rewritten to the arm's form (RULES_V3 questions for every candidate, the first K candidates kept,
// as judge2.mts's F arms) and answered by SubQ Snap 1.2 or gpt-6-luna chat (the provider matrix's prompt, effort low).
// Answers are keyed `<tech>|<request key>`. Scored by fresh16-score.mts.
//
//   cd central && npx tsx ../eval/select/slice19/fresh16.mts --cand subq|luna --arm F4|F8 [--dry-run]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CROSS_SOURCE_RULE, RULES_V3, kindOf, kindsOf, shortRulesApply } from "../../../central/src/pipeline/match.ts";
import { fill, judgeText } from "../../../central/src/pipeline/prompts.ts";
import { canonical, pool } from "../../../central/src/pipeline/util.ts";
import type { Answer, Classification, Questions } from "../../../central/src/pipeline/classify/adapter.ts";
import type { StoredRecord } from "../../../central/src/pipeline/store.ts";
import { ChatClient, PROVIDERS, logUsageLine } from "../client.ts";
import { spendByProvider } from "../budget.ts";
import { SubqClassifier } from "../subq.ts";

const { values: a } = parseArgs({ options: { cand: { type: "string" }, arm: { type: "string", default: "F4" }, "dry-run": { type: "boolean", default: false }, concurrency: { type: "string", default: "4" } } });
const TECHS = ["nx-808e5281", "langchain-core-a4216c71", "openvino-502d9770", "astro-71c9db18"];
const SELECT = join(import.meta.dirname, "..");
const OUT = join(SELECT, "out", "slice19");
const USAGE = join(OUT, "usage.jsonl");
const CAP = { subq: 0.45, vercel: 1.2 };
const K = Number(a.arm!.slice(1));
const cand = a.cand as "subq" | "luna";
const runId = `${cand === "subq" ? "subq-1.2" : "luna"}-${a.arm}`;
mkdirSync(join(OUT, "runs", runId), { recursive: true });

interface Req { key: string; tech: string; state: { incoming: unknown; candidates: Record<string, unknown> } & Record<string, unknown>; cands: StoredRecord[]; incoming: { kind?: "release_notes" | "upgrade_guide" } }

/** The request in the arm's form: matchRequest's long-rules branch for every candidate, then the first K. */
function form(r: Req): { state: Record<string, unknown>; questions: Questions } {
  const mixed = kindOf(r.incoming) !== "release_notes" || r.cands.some((c) => [...kindsOf(c)].some((k) => k !== "release_notes"));
  const rules = mixed ? `${RULES_V3}\n${CROSS_SOURCE_RULE}` : RULES_V3;
  const ids = r.cands.map((_, i) => `c${i + 1}`).slice(0, K);
  const questions: Questions = Object.fromEntries(ids.map((c) => [`same_${c}`, { instructions: fill(judgeText.question, { CANDIDATE: c, RULES: rules }), options: Object.fromEntries(judgeText.options.map((o) => [o.id, fill(o.text, { CANDIDATE: c })])) }]));
  return { state: { ...r.state, candidates: Object.fromEntries(ids.map((c) => [c, r.state.candidates[c]])) }, questions };
}

const reqs: Array<{ id: string } & ReturnType<typeof form>> = [];
for (const t of TECHS) {
  const all = JSON.parse(readFileSync(join(SELECT, "out", "slice16", `${t}-requests.json`), "utf8")) as Record<string, Req>;
  for (const r of Object.values(all)) if (shortRulesApply(r.incoming, r.cands) && r.cands.length) reqs.push({ id: `${t}|${r.key}`, ...form(r) });
}
const planIn = reqs.reduce((s, r) => s + Math.ceil(JSON.stringify(r).length / 3.5), 0);
console.log(`${runId}: ${reqs.length} requests, ~${planIn} input tokens (chars/3.5)`);
if (a["dry-run"]) process.exit(0);
const spent = spendByProvider(USAGE);
if ((spent.subq?.dollars ?? 0) > CAP.subq || (spent.vercel?.dollars ?? 0) > CAP.vercel) throw new Error(`slice 19 cap reached: ${JSON.stringify(spent)}`);

// gpt-6-luna chat: the provider matrix's chat prompt (slice 5's chat arms) and answer check.
const CHAT_PROMPT = `You answer closed-choice questions about a record. Read the state and answer every question by picking
exactly one of its options and giving a probability for every option (the probabilities of one question sum to 1).

Output only a JSON object, no prose: {"<question id>": {"choice": "<option>", "probabilities": {"<option>": <0..1>, ...}}, ...}

State:
%STATE%

Questions:
%QUESTIONS%
`;
const prompt = (s: Record<string, unknown>, q: Questions) => CHAT_PROMPT.replace("%STATE%", canonical(s)).replace("%QUESTIONS%", JSON.stringify(Object.fromEntries(Object.entries(q).map(([id, x]) => [id, { instructions: x.instructions, options: x.options }])), null, 1));
function parseAll(t: string, q: Questions): Record<string, Answer> | undefined {
  const m = /\{[\s\S]*\}/.exec(t.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  let raw: Record<string, { choice?: unknown; probabilities?: Record<string, unknown> }> | undefined;
  try { raw = m ? JSON.parse(m[0]) : undefined; } catch { return undefined; }
  if (!raw) return undefined;
  const out: Record<string, Answer> = {};
  for (const [id, qq] of Object.entries(q)) {
    const x = raw[id];
    if (!x || typeof x.choice !== "string" || !(x.choice in qq.options)) return undefined;
    const probabilities: Record<string, number> = {};
    for (const o of Object.keys(qq.options)) { const p = x.probabilities?.[o]; if (typeof p !== "number" || !Number.isFinite(p)) return undefined; probabilities[o] = p; }
    out[id] = { choice: x.choice, confidence: probabilities[x.choice]!, probabilities };
  }
  return out;
}

const subq = new SubqClassifier({ model: "subq-snap-1.2", step: `slice19:${runId}`, usageLog: USAGE });
const chat = new ChatClient({ provider: PROVIDERS.vercel!, cacheDir: join(OUT, "cache", runId), usageLog: USAGE, concurrency: Number(a.concurrency) });
const answers: Record<string, Classification | null> = {};
let done = 0;
await pool(reqs, Number(a.concurrency), async (r) => {
  try {
    if (cand === "subq") answers[r.id] = await subq.classify(r.state, r.questions);
    else {
      const c = await chat.complete({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: prompt(r.state, r.questions) }], max_tokens: 4000, reasoning_effort: "low" }, (t) => parseAll(t, r.questions), { step: `slice19:${runId}` });
      answers[r.id] = c.value ? { classifier: "chat", model: "openai/gpt-6-luna", answers: c.value } as Classification : null;
    }
  } catch (e) {
    console.error(`${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    answers[r.id] = null;
  }
  if (++done % 100 === 0) console.log(`  ${done}/${reqs.length}`);
});
writeFileSync(join(OUT, "runs", runId, "answers.json"), JSON.stringify(answers) + "\n");
const meta = { runId, requests: reqs.length, answered: Object.values(answers).filter(Boolean).length, spend: spendByProvider(USAGE) };
writeFileSync(join(OUT, "runs", runId, "meta.json"), JSON.stringify(meta, null, 1) + "\n");
console.log(JSON.stringify(meta));
void logUsageLine;
