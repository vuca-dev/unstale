#!/usr/bin/env node
// Slice 3 gate rebuild: a stand-in for the `codex` binary (UNSTALE_CODEX_BIN), so the unmodified pipeline extracts and
// labels with a gateway model. Only prompts that start as EXTRACT_PROMPT, LABEL_PROMPT or ONE_CALL_PROMPT go to the
// gateway (SHIM_MODEL); anything else (classifier fallback) is passed to the real codex. Output mimics `codex exec
// --json`: an agent_message item and a turn.completed usage line. A truncated answer exits 1 with no text (the
// pipeline's failure path). Usage goes to eval/select/out/slice3/usage.jsonl; every call is refused at the $4 cap.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const MODEL = process.env.SHIM_MODEL ?? "alibaba/qwen3.8-flash";
const EXTRA = { "openai/gpt-oss-20b": { reasoning_effort: "low" }, "openai/gpt-oss-120b": { reasoning_effort: "low" }, "alibaba/qwen3.8-flash": { reasoning_effort: "none" }, "deepseek/deepseek-v4-flash": { reasoning_effort: "none" },
  "openai/gpt-6-luna": { reasoning_effort: "low" }, "openai/gpt-5-nano": { reasoning_effort: "minimal" }, "nvidia/nemotron-3.5-lightning": { reasoning_effort: "none" }, "alibaba/qwen3.7-flash": { reasoning_effort: "none" }, "zai/glm-4.7-flash": { reasoning_effort: "none" } };
// Slice 3b: SHIM_OUT=slice3b SHIM_CAP=2.5 (defaults: slice 3's log and $4 cap).
const USAGE = join(import.meta.dirname, "..", "out", process.env.SHIM_OUT ?? "slice3", "usage.jsonl");
const CAP = Number(process.env.SHIM_CAP ?? 4.0);
const ours = /^You extract change records|^You write search terms/.test(prompt);
if (!ours) {
  const p = spawn("/opt/homebrew/bin/codex", args, { stdio: "inherit" });
  p.on("close", (c) => process.exit(c ?? 1));
} else {
  let spent = 0;
  if (existsSync(USAGE)) for (const l of readFileSync(USAGE, "utf8").split("\n")) if (l.trim()) { const e = JSON.parse(l); if (e.provider === "vercel" && typeof e.dollars === "number") spent += e.dollars; }
  if (spent >= CAP) { console.error("shim: slice cap reached"); process.exit(1); }
  const env = readFileSync(join(homedir(), ".config", "ati", "vercel.env"), "utf8");
  const key = /AI_GATEWAY_API_KEY=["']?([^"'\n]+)/.exec(env)[1];
  const step = prompt.startsWith("You write") ? "label" : "extract";
  const body = { model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 16000, ...(EXTRA[MODEL] ?? {}) };
  let j;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
      if (!res.ok) { console.error(`shim: HTTP ${res.status}`); process.exit(1); }
      j = await res.json();
      break;
    } catch (e) {
      if (attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
      console.error(`shim: ${e}`); process.exit(1);
    }
  }
  const u = j.usage ?? {};
  const cost = Number(u.cost ?? j.providerMetadata?.gateway?.cost ?? j.provider_metadata?.gateway?.cost);
  const ch = j.choices?.[0] ?? {};
  appendFileSync(USAGE, JSON.stringify({ run: process.env.SHIM_RUN ?? "slice3-gate", step, provider: "vercel", model: MODEL, input_tokens: u.prompt_tokens ?? 0, cached_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? null, dollars: Number.isFinite(cost) ? cost : ((u.prompt_tokens ?? 0) * 0.15 + (u.completion_tokens ?? 0) * 0.47) / 1e6, finish: ch.finish_reason, at: new Date().toISOString() }) + "\n");
  if (ch.finish_reason === "length") { console.error("shim: truncated"); process.exit(1); }
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ch.message?.content ?? "" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: u.prompt_tokens ?? 0, cached_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 } }));
  process.exit(0);
}
