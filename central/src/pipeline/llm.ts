// OpenAI-compatible chat-completions calls, and the extraction model switch (steps A+B; vault: Inference Costs,
// "Model selection"). UNSTALE_EXTRACT_MODEL is `provider:model`: `codex:gpt-5.6-luna` (the default, via `codex exec`)
// or a chat-completions provider such as `vercel:openai/gpt-6-luna` (slice 3b's pick, reasoning `low`).
// UNSTALE_EXTRACT_EFFORT sets reasoning_effort (default low). UNSTALE_EXTRACT_SERVICE_TIER (default flex on the gateway)
// asks for the provider's flex tier: the same model at 50% of list price, slower (verified 16 October 2026 on
// openai/gpt-6-luna: billed at 0.50×); a flex call the provider refuses for capacity is retried once at the default
// tier, and the tier is not part of the cache key (same model, same answer distribution). Answers are cached by sha256(provider + request body),
// only when they parse (as codex.ts); a truncated answer counts as a failed attempt.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromEnvFile } from "./classify/adapter.ts";
import { codex, codexCachePath } from "./codex.ts";
import { centralDir } from "./paths.ts";
import { canonical, logUsage, readJson, sha256, sleep, writeAtomic } from "./util.ts";

const keyDir = join(homedir(), ".config", "ati");

export interface Provider {
  name: string;
  /** `{VAR}` is filled from the key file (Cloudflare's account id). */
  baseUrl: string;
  keyFile: string;
  keyVar: string;
}

export const PROVIDERS: Record<string, Provider> = {
  openai: { name: "openai", baseUrl: "https://api.openai.com/v1", keyFile: join(keyDir, "openai.env"), keyVar: "OPENAI_API_KEY" },
  vercel: { name: "vercel", baseUrl: "https://ai-gateway.vercel.sh/v1", keyFile: join(keyDir, "vercel.env"), keyVar: "AI_GATEWAY_API_KEY" },
  cloudflare: {
    name: "cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    keyFile: join(keyDir, "cloudflare.env"),
    keyVar: "CLOUDFLARE_API_TOKEN",
  },
};

export function baseUrlOf(p: Provider): string {
  return p.baseUrl.replace(/\{([A-Z_]+)\}/g, (_, v: string) => keyFromEnvFile(p.keyFile, v)());
}

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  /** Included in output_tokens (completion_tokens counts them); null when the API does not report them. */
  reasoning_tokens: number | null;
}

/** Usage from a chat-completions response (`prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`). */
export function parseUsage(u: unknown): Usage | undefined {
  const x = u as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
  } | null | undefined;
  if (!x || typeof x.prompt_tokens !== "number") return undefined;
  const reasoning = x.completion_tokens_details?.reasoning_tokens;
  return {
    input_tokens: x.prompt_tokens,
    cached_input_tokens: x.prompt_tokens_details?.cached_tokens ?? 0,
    output_tokens: x.completion_tokens ?? 0,
    reasoning_tokens: typeof reasoning === "number" ? reasoning : null,
  };
}

/** The provider's own charge for a call, when the response reports one (gateway `usage.cost` or provider metadata). */
export function reportedCost(j: unknown): number | undefined {
  const x = j as { usage?: { cost?: unknown }; providerMetadata?: { gateway?: { cost?: unknown } }; provider_metadata?: { gateway?: { cost?: unknown } } } | undefined;
  for (const v of [x?.usage?.cost, x?.providerMetadata?.gateway?.cost, x?.provider_metadata?.gateway?.cost]) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return undefined;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export type ChatBody = { model: string; messages: Array<{ role: string; content: string }> } & Record<string, unknown>;

export interface Answer {
  text: string;
  usage?: Usage;
  cost?: number;
  finish?: string;
}

export interface PostOptions {
  fetch?: typeof fetch;
  apiKey: () => string;
  backoffMs: number;
  timeoutMs: number;
  /** Retries on 429, 5xx and network errors. */
  retries: number;
}

/** One chat-completions round trip with timeout and retries on 429/5xx/network; another 4xx fails at once. */
export async function postChat(p: Provider, body: ChatBody, o: PostOptions): Promise<Answer> {
  const key = o.apiKey();
  const base = baseUrlOf(p);
  const f = o.fetch ?? fetch;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    let res: Response;
    try {
      res = await f(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < o.retries) {
        await sleep(o.backoffMs * 2 ** attempt);
        continue;
      }
      throw new HttpError(0, ctrl.signal.aborted ? `no answer within ${o.timeoutMs} ms` : String(e));
    }
    clearTimeout(timer);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < o.retries) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : o.backoffMs * 2 ** attempt);
        continue;
      }
      throw new HttpError(res.status, `HTTP ${res.status} after ${o.retries} retries`);
    }
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>; usage?: unknown };
    const usage = parseUsage(j.usage);
    const cost = reportedCost(j);
    const finish = j.choices?.[0]?.finish_reason;
    return {
      text: j.choices?.[0]?.message?.content ?? "",
      ...(usage ? { usage } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(finish ? { finish } : {}),
    };
  }
}

export interface ExtractModel {
  provider: string;
  model: string;
  effort: string;
  /** Gateway service tier (`flex`, `default`); applies to chat-completions providers that support it. */
  tier: string;
}

export function extractModel(env: NodeJS.ProcessEnv = process.env): ExtractModel {
  const spec = env.UNSTALE_EXTRACT_MODEL ?? "codex:gpt-5.6-luna";
  const i = spec.indexOf(":");
  if (i <= 0) throw new Error(`UNSTALE_EXTRACT_MODEL must be provider:model, got ${spec}`);
  const provider = spec.slice(0, i);
  if (provider !== "codex" && !PROVIDERS[provider]) throw new Error(`UNSTALE_EXTRACT_MODEL: unknown provider ${provider}`);
  return { provider, model: spec.slice(i + 1), effort: env.UNSTALE_EXTRACT_EFFORT ?? "low", tier: env.UNSTALE_EXTRACT_SERVICE_TIER ?? (provider === "vercel" ? "flex" : "default") };
}

export const llmStats = { calls: 0, cached: 0, failed: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, dollars: 0 };

const MAX_TOKENS = 16_000;
const chatLimit = new Limiter(5);

/** Runs an extraction or label prompt on the configured model; the parsed answer, or undefined after three failed attempts. */
/** `responseFormat` (a chat-completions `response_format`) is sent to chat providers only; Codex gets the prompt alone. */
export interface CallOptions {
  responseFormat?: unknown;
  maxTokens?: number;
}

function chatRequest(m: ExtractModel, prompt: string, o: CallOptions): { body: ChatBody; path: string } {
  const p = PROVIDERS[m.provider]!;
  const body: ChatBody = { model: m.model, messages: [{ role: "user", content: prompt }], max_tokens: o.maxTokens ?? MAX_TOKENS, reasoning_effort: m.effort };
  if (o.responseFormat) body.response_format = o.responseFormat;
  const key = sha256(`${p.name}\n${canonical(body)}`);
  return { body, path: join(centralDir(), "cache", "llm", key.slice(0, 2), `${key}.json`) };
}

/** Whether the configured model already has a parsed answer to this prompt cached (a call would be free). */
export function extractCached(prompt: string, o: CallOptions = {}): boolean {
  const m = extractModel();
  return existsSync(m.provider === "codex" ? codexCachePath(prompt, m.model) : chatRequest(m, prompt, o).path);
}

export async function extractLlm<T>(prompt: string, parse: (text: string) => T | undefined, o: { fetch?: typeof fetch; backoffMs?: number } & CallOptions = {}): Promise<T | undefined> {
  const m = extractModel();
  if (m.provider === "codex") return codex(prompt, parse, m.model);
  const p = PROVIDERS[m.provider]!;
  const { body, path } = chatRequest(m, prompt, o);
  const hit = readJson<{ text: string }>(path);
  if (hit) {
    const v = parse(hit.text);
    if (v !== undefined) {
      llmStats.cached++;
      return v;
    }
  }
  const backoffMs = o.backoffMs ?? 2000;
  return chatLimit.run(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r: Answer;
      try {
        const post = (b: ChatBody) => postChat(p, b, { apiKey: keyFromEnvFile(p.keyFile, p.keyVar), backoffMs, timeoutMs: 10 * 60 * 1000, retries: 4, ...(o.fetch ? { fetch: o.fetch } : {}) });
        if (m.tier === "default") r = await post(body);
        else {
          try {
            r = await post({ ...body, providerOptions: { gateway: { serviceTier: m.tier } } });
          } catch (e) {
            if (!(e instanceof HttpError) || (e.status !== 429 && e.status < 500)) throw e;
            console.error(`${p.name}/${m.model}: ${m.tier} tier unavailable (${e.message}); retrying at the default tier`);
            r = await post(body);
          }
        }
      } catch (e) {
        console.error(`${p.name}/${m.model}: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      if (r.usage) {
        llmStats.calls++;
        llmStats.input_tokens += r.usage.input_tokens;
        llmStats.cached_input_tokens += r.usage.cached_input_tokens;
        llmStats.output_tokens += r.usage.output_tokens;
        llmStats.reasoning_tokens += r.usage.reasoning_tokens ?? 0;
        llmStats.dollars += r.cost ?? 0;
        logUsage({ api: p.name, model: m.model, effort: m.effort, tier: m.tier, ...r.usage, ...(r.cost !== undefined ? { dollars: r.cost } : {}), finish: r.finish });
      }
      const v = r.finish === "length" ? undefined : parse(r.text);
      if (v !== undefined) {
        writeAtomic(path, JSON.stringify({ provider: p.name, model: m.model, text: r.text, usage: r.usage }) + "\n");
        return v;
      }
      console.error(`${p.name}/${m.model}: attempt ${attempt + 1} ${r.finish === "length" ? "truncated" : "unparseable"}`);
      await sleep(backoffMs * (attempt + 1));
    }
    llmStats.failed++;
    return undefined;
  });
}
