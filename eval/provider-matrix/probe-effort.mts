// Which reasoning settings the gateway's claude-haiku-5.5 accepts, and what each costs in reasoning tokens, on a
// made-up arithmetic question (no eval-set text). Run before PREREG.md.
//   cd central && npx tsx ../eval/provider-matrix/probe-effort.mts
import { join } from "node:path";
const SELECT = join(import.meta.dirname, "..", "select");
const { PROVIDERS, baseUrlOf } = await import(join(SELECT, "client.ts"));
const { keyFromEnvFile } = await import("../../central/src/pipeline/classify/adapter.ts");
const key = keyFromEnvFile(PROVIDERS.vercel.keyFile, PROVIDERS.vercel.keyVar);
const settings: Record<string, unknown>[] = [{}, { reasoning_effort: "none" }, { reasoning_effort: "minimal" }, { reasoning_effort: "low" }, { reasoning: { enabled: false } }, { providerOptions: { anthropic: { thinking: { type: "disabled" } } } }];
for (const extra of settings) {
  const r = await fetch(`${baseUrlOf(PROVIDERS.vercel)}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "anthropic/claude-haiku-5.5", messages: [{ role: "user", content: "A list has 17 items; 5 are removed and 9 added, then half are removed. How many remain? Answer with the number only." }], max_tokens: 2000, ...extra }) });
  const j = await r.json().catch(() => ({}));
  console.log(JSON.stringify(extra), "HTTP", r.status, JSON.stringify(j.choices?.[0]?.message?.content ?? j.error ?? "").slice(0, 80), "completion", j.usage?.completion_tokens, "reasoning", j.usage?.completion_tokens_details?.reasoning_tokens);
}
