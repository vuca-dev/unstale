// Diagnosis pass (PREREGISTRATION.md, stopping rule): one judge request the client could not read, sent once more
// exactly as the client sends it, to see the raw answer. One paid call per item named.
//
//   cd central && AI_GATEWAY_API_KEY=... npx tsx ../eval/edge-port/diagnose_request.mts 'UID' ['UID' ...]
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { ChatClassifier } = await import("../../central/src/pipeline/classify/adapter.ts");
const { matchRequest, retrieve } = await import("../../central/src/pipeline/match.ts");
const key = process.env.AI_GATEWAY_API_KEY;
if (!key) throw new Error("no gateway key in the environment");
const HERE = import.meta.dirname;
const D = JSON.parse(readFileSync(join(HERE, "..", "select", "out", "slice5", "units.json"), "utf8")) as { units: Array<{ set: string; key: string; cands: never[]; guardInc: { breaking: boolean } }> };
const inputs = new Map(readFileSync(join(HERE, "out", "inputs", "match-heldout.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.uid as string, j] as const; }));
const chat = new ChatClassifier({ model: "openai/gpt-6-luna", run: async () => undefined });
for (const uid of process.argv.slice(2)) {
  const u = D.units.find((x) => `${x.set}|${x.key}` === uid)!;
  const it = inputs.get(uid)!;
  const got = retrieve(it.incoming, u.cands);
  const req = matchRequest(it.name, it.incoming, u.guardInc.breaking, u.cands, got.map((c: { score: number }) => c.score));
  const body = { model: "openai/gpt-6-luna", messages: [{ role: "user", content: chat.prompt(req.state, req.questions) }], max_tokens: 16000, reasoning_effort: "low", providerOptions: { gateway: { serviceTier: "flex" } } };
  const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json()) as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; usage?: unknown };
  console.log(JSON.stringify({ uid, status: res.status, asked: Object.keys(req.questions), finish: j.choices?.[0]?.finish_reason, answer: j.choices?.[0]?.message?.content, usage: j.usage }));
}
