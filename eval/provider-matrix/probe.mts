// Reachability probes before pre-registration (no eval-set text): the gateway balance, the OpenAI Decisions API's
// request and answer shape on a made-up state, and one-word chat probes for the gateway candidates' reasoning settings.
//   cd central && npx tsx ../eval/provider-matrix/probe.mts
import { join } from "node:path";
const SELECT = join(import.meta.dirname, "..", "select");
const { PROVIDERS, baseUrlOf } = await import(join(SELECT, "client.ts"));
const { gatewayBalance } = await import(join(SELECT, "budget.ts"));
const { keyFromEnvFile } = await import("../../central/src/pipeline/classify/adapter.ts");

console.log("gateway balance $", (await gatewayBalance()).toFixed(4));

const state = { record: { summary: "The `foo()` function was removed; use `bar()` instead.", version: "2.0.0" } };
const openaiKey = keyFromEnvFile(PROVIDERS.openai.keyFile, PROVIDERS.openai.keyVar);
const dbody = {
  model: "gpt-6-luna",
  input: JSON.stringify(state),
  questions: [{ type: "choice", name: "breaking", instructions: "Does upgrading break existing code that uses this?", choices: [{ value: "yes", description: "Breaks existing code." }, { value: "no", description: "Does not." }] }],
};
const dr = await fetch("https://api.openai.com/v1/decisions", { method: "POST", headers: { Authorization: `Bearer ${openaiKey()}`, "Content-Type": "application/json" }, body: JSON.stringify(dbody) });
console.log("decisions HTTP", dr.status, (await dr.text()).slice(0, 800));

const gkey = keyFromEnvFile(PROVIDERS.vercel.keyFile, PROVIDERS.vercel.keyVar);
for (const [model, extra] of [["anthropic/claude-haiku-5.5", {}], ["anthropic/claude-haiku-5.5", { reasoning_effort: "low" }], ["openai/gpt-6-luna", { reasoning_effort: "low" }]] as const) {
  const r = await fetch(`${baseUrlOf(PROVIDERS.vercel)}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${gkey()}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 50, ...extra }) });
  const j = await r.json().catch(() => ({}));
  console.log(model, JSON.stringify(extra), "HTTP", r.status, JSON.stringify(j.choices?.[0]?.message?.content ?? j.error ?? j).slice(0, 200), JSON.stringify(j.usage ?? {}).slice(0, 300));
}
const o = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${openaiKey()}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-6-luna", messages: [{ role: "user", content: "Reply with the single word: ok" }], max_completion_tokens: 200, reasoning_effort: "low" }) });
const oj = await o.json().catch(() => ({}));
console.log("openai direct gpt-6-luna HTTP", o.status, JSON.stringify(oj.choices?.[0]?.message?.content ?? oj.error ?? oj).slice(0, 200));
