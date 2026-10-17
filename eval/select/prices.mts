// Refreshes the AI Gateway rows of prices.json from GET https://ai-gateway.vercel.sh/v1/models (free; it lists
// per-token prices per model). Hand-entered rows of other providers are kept. The Codex row (Luna through the user's
// plan) is costed at the gateway's list price for openai/gpt-5.6-luna, so Luna can be compared without the harness.
//
//   cd central && npx tsx ../eval/select/prices.mts [models.json]   (a saved response instead of the live GET)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SELECT_DIR, type Price } from "./client.ts";

interface GatewayModel {
  id: string;
  type?: string;
  max_tokens?: number;
  pricing?: { input?: string; output?: string; input_cache_read?: string; input_tiers?: unknown; varies_by_provider?: boolean };
}

const perM = (s: string | undefined): number | null => (s === undefined || !Number.isFinite(Number(s)) ? null : Math.round(Number(s) * 1e6 * 1e6) / 1e6);

const src = process.argv[2];
const models = (src ? JSON.parse(readFileSync(src, "utf8")) : await (await fetch("https://ai-gateway.vercel.sh/v1/models")).json()) as { data: GatewayModel[] };
const today = new Date().toISOString().slice(0, 10);
const path = join(SELECT_DIR, "prices.json");
const file = JSON.parse(readFileSync(path, "utf8")) as { _note: string; models: Array<Price & Record<string, unknown>> };
const kept = file.models.filter((m) => m.provider !== "vercel" && m.provider !== "codex");
const gateway = models.data
  .filter((m) => m.type === "language" && m.pricing?.input !== undefined && m.pricing?.output !== undefined)
  .map((m) => ({
    provider: "vercel",
    model: m.id,
    input: perM(m.pricing!.input),
    cached_input: perM(m.pricing!.input_cache_read),
    output: perM(m.pricing!.output),
    ...(m.pricing!.input_tiers ? { tiered: "base tier (prompts under 272k tokens)" } : {}),
    ...(m.pricing!.varies_by_provider ? { varies_by_provider: true } : {}),
    ...(m.max_tokens ? { max_output: m.max_tokens } : {}),
    source: "GET https://ai-gateway.vercel.sh/v1/models",
    checked: today,
  }));
const luna = gateway.find((g) => g.model === "openai/gpt-5.6-luna");
const codex = {
  provider: "codex",
  model: "gpt-5.6-luna",
  input: luna?.input ?? null,
  cached_input: luna?.cached_input ?? null,
  output: luna?.output ?? null,
  source: "API list price of openai/gpt-5.6-luna on the AI Gateway; the Codex path itself bills the user's plan, not per call",
  checked: luna ? today : null,
};
file.models = [...kept, codex, ...gateway.sort((a, b) => a.model.localeCompare(b.model))];
writeFileSync(path, JSON.stringify(file, null, 1) + "\n");
console.log(`prices.json: ${gateway.length} gateway models, ${kept.length} hand rows kept, codex ${luna ? "priced" : "price unknown"}`);
