// Budget guard: a non-dry run is refused when its worst-case estimate exceeds what may still be spent with the
// provider. Defaults: the live AI Gateway balance minus a $1 reserve; $2 in all for the OpenAI API (disabled unless
// --allow-openai); `--budget` overrides. An unknown worst case (a price missing) is refused, never treated as $0.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keyFromEnvFile } from "../../central/src/pipeline/classify/adapter.ts";
import { OUT_DIR, PROVIDERS } from "./client.ts";

export const GATEWAY_RESERVE = 1;
export const OPENAI_CAP = 2;

/** The AI Gateway's remaining credit (GET /v1/credits, free). */
export async function gatewayBalance(f: typeof fetch = fetch, key = keyFromEnvFile(PROVIDERS.vercel!.keyFile, PROVIDERS.vercel!.keyVar)): Promise<number> {
  const res = await f("https://ai-gateway.vercel.sh/v1/credits", { headers: { Authorization: `Bearer ${key()}` } });
  if (!res.ok) throw new Error(`gateway credits: HTTP ${res.status}`);
  const j = (await res.json()) as { balance?: unknown };
  const b = Number(j.balance);
  if (!Number.isFinite(b)) throw new Error("gateway credits: no balance in the response");
  return b;
}

export interface Spend {
  calls: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  dollars: number;
  unpriced_calls: number;
  /** Codex only: the rendered prompts' own tokens (estimate), against the harness-inclusive input_tokens. */
  prompt_tokens_est: number;
}

/** Cumulative spend per provider from the usage log. */
export function spendByProvider(log = join(OUT_DIR, "usage.jsonl")): Record<string, Spend> {
  const out: Record<string, Spend> = {};
  if (!existsSync(log)) return out;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Record<string, unknown>;
    const p = String(e.provider);
    const s = (out[p] ??= { calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, dollars: 0, unpriced_calls: 0, prompt_tokens_est: 0 });
    s.calls++;
    s.input_tokens += Number(e.input_tokens) || 0;
    s.cached_input_tokens += Number(e.cached_input_tokens) || 0;
    s.output_tokens += Number(e.output_tokens) || 0;
    s.reasoning_tokens += Number(e.reasoning_tokens) || 0;
    s.prompt_tokens_est += Number(e.prompt_tokens_est) || 0;
    if (typeof e.dollars === "number") s.dollars += e.dollars;
    else s.unpriced_calls++;
  }
  return out;
}

export function printSpend(log?: string): void {
  const s = spendByProvider(log);
  if (!Object.keys(s).length) return console.log("cumulative spend: none logged");
  console.log("cumulative spend (usage.jsonl):");
  for (const [p, x] of Object.entries(s)) {
    const usd = `$${x.dollars.toFixed(4)}${x.unpriced_calls ? ` + ${x.unpriced_calls} calls price unknown` : ""}`;
    const codex = p === "codex" ? `, prompt-only ~${x.prompt_tokens_est} input tokens (harness included in input)` : "";
    console.log(`  ${p}: ${x.calls} calls, input ${x.input_tokens} (cached ${x.cached_input_tokens}), output ${x.output_tokens} (reasoning ${x.reasoning_tokens})${codex}, ${usd}`);
  }
}

/** The dollars a run on this provider may still spend; undefined = no dollar budget applies (Codex: subscription). */
export async function remainingBudget(provider: string, override: number | undefined, opts: { fetch?: typeof fetch; log?: string } = {}): Promise<number | undefined> {
  if (override !== undefined) return override;
  if (provider === "codex") return undefined;
  if (provider === "vercel") return (await gatewayBalance(opts.fetch)) - GATEWAY_RESERVE;
  if (provider === "openai") return OPENAI_CAP - (spendByProvider(opts.log).openai?.dollars ?? 0);
  // Jev, Cloudflare and anything else: no balance API wired, so a run needs an explicit --budget.
  return 0;
}

/** Refusal message, or undefined when the run may go ahead. */
export function checkBudget(worstCase: number | null, remaining: number | undefined): string | undefined {
  if (remaining === undefined) return undefined;
  if (worstCase === null) return "worst-case cost unknown (a price is missing from prices.json); refusing to run";
  if (worstCase > remaining) return `worst case $${worstCase.toFixed(4)} exceeds the remaining budget $${remaining.toFixed(4)}; lower --limit or pass --budget`;
  return undefined;
}
