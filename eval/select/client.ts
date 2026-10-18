// One OpenAI-compatible chat-completions client for model selection (the HTTP call is central's llm.ts). Provider =
// base URL + key file; model and body come from the caller. Answers are cached on disk by sha256(provider + model +
// full request body), and only answers that parse are cached (as codex.ts). Every real call appends one line to the
// usage log with tokens and dollars from prices.json; an unknown price is logged as null.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFromEnvFile } from "../../central/src/pipeline/classify/adapter.ts";
import { type Answer, type ChatBody, HttpError, Limiter, PROVIDERS as CHAT_PROVIDERS, postChat, type Provider, type Usage } from "../../central/src/pipeline/llm.ts";
import { canonical, readJson, sha256, writeAtomic } from "../../central/src/pipeline/util.ts";

export { baseUrlOf, type ChatBody, HttpError, Limiter, parseUsage, type Provider, reportedCost, type Usage } from "../../central/src/pipeline/llm.ts";

export const SELECT_DIR = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = process.env.UNSTALE_SELECT_OUT ?? join(SELECT_DIR, "out");
const keyDir = join(homedir(), ".config", "ati");

/** Chat-completions providers live in central's llm.ts; Jev (jev.ts) and Codex (codex.ts via run.mts) are listed here for
 * their key and price lookup only. The OpenAI API is disabled in run.mts unless `--allow-openai` is passed. */
export const PROVIDERS: Record<string, Provider> = {
  ...CHAT_PROVIDERS,
  jev: { name: "jev", baseUrl: "https://api.typesafe.ai/v1", keyFile: join(keyDir, "jev.env"), keyVar: "JEV_API_KEY" },
  subq: { name: "subq", baseUrl: "https://api.subq.ai/v1", keyFile: join(keyDir, "subq.env"), keyVar: "SUBQ_API_KEY" },
  codex: { name: "codex", baseUrl: "", keyFile: "", keyVar: "" },
};

export interface Price {
  provider: string;
  model: string;
  input: number | null;
  cached_input: number | null;
  output: number | null;
  /** The model's output-token ceiling, where the listing gives one (max_tokens above it is rejected). */
  max_output?: number;
  source: string;
  checked: string | null;
}

export function loadPrices(path = join(SELECT_DIR, "prices.json")): Price[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { models: Price[] }).models;
}

export const priceOf = (prices: Price[], provider: string, model: string): Price | undefined =>
  prices.find((p) => p.provider === provider && p.model === model);

/** Dollars for one call's usage, or null when any price it needs is unknown (never a silent $0). */
export function dollars(p: Price | undefined, u: Usage): number | null {
  if (!p || p.input === null || p.output === null) return null;
  const cachedRate = p.cached_input ?? p.input;
  return ((u.input_tokens - u.cached_input_tokens) * p.input + u.cached_input_tokens * cachedRate + u.output_tokens * p.output) / 1e6;
}

export interface UsageLine {
  provider: string;
  model: string;
  step: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number | null;
  dollars: number | null;
  [k: string]: unknown;
}

export function logUsageLine(path: string, line: UsageLine): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ...line, at: new Date().toISOString() }) + "\n");
}

export interface ClientOptions {
  provider: Provider;
  fetch?: typeof fetch;
  apiKey?: () => string;
  backoffMs?: number;
  timeoutMs?: number;
  /** Retries on 429, 5xx and network errors. */
  retries?: number;
  /** Attempts for an answer that does not parse. */
  attempts?: number;
  concurrency?: number;
  /** Gateway service tier; default `flex` on the gateway (50% of list, billed at the tier served; outside the cache key). */
  serviceTier?: string;
  cacheDir?: string;
  usageLog?: string;
  prices?: Price[];
}

export interface Completion<T> {
  value: T | undefined;
  text: string;
  usage?: Usage;
  cached: boolean;
}

export class ChatClient {
  readonly provider: Provider;
  readonly stats = { calls: 0, cached: 0, failed: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, dollars: 0, unpriced_calls: 0 };
  private readonly o: Required<Omit<ClientOptions, "provider" | "apiKey">>;
  private readonly apiKey: () => string;
  private readonly limit: Limiter;
  constructor(o: ClientOptions) {
    this.provider = o.provider;
    this.apiKey = o.apiKey ?? keyFromEnvFile(o.provider.keyFile, o.provider.keyVar);
    this.o = {
      fetch: o.fetch ?? fetch,
      backoffMs: o.backoffMs ?? 2000,
      timeoutMs: o.timeoutMs ?? 10 * 60 * 1000,
      retries: o.retries ?? 4,
      attempts: o.attempts ?? 3,
      concurrency: o.concurrency ?? 4,
      cacheDir: o.cacheDir ?? join(OUT_DIR, "cache", "chat"),
      usageLog: o.usageLog ?? join(OUT_DIR, "usage.jsonl"),
      prices: o.prices ?? loadPrices(),
      serviceTier: o.serviceTier ?? (o.provider.name === "vercel" ? "flex" : "default"),
    };
    this.limit = new Limiter(this.o.concurrency);
  }

  cacheKey(body: ChatBody): string {
    return sha256(`${this.provider.name}\n${body.model}\n${canonical(body)}`);
  }
  private cachePath(k: string): string {
    return join(this.o.cacheDir, k.slice(0, 2), `${k}.json`);
  }

  /** One round trip; on the gateway at the configured tier, retried once at the default tier if the tier is refused. */
  private async post(body: ChatBody): Promise<Answer> {
    const send = (b: ChatBody) => postChat(this.provider, b, { fetch: this.o.fetch, apiKey: this.apiKey, backoffMs: this.o.backoffMs, timeoutMs: this.o.timeoutMs, retries: this.o.retries });
    const tier = this.o.serviceTier;
    if (tier === "default") return send(body);
    const po = (body.providerOptions ?? {}) as { gateway?: Record<string, unknown> };
    try {
      return await send({ ...body, providerOptions: { ...po, gateway: { ...po.gateway, serviceTier: tier } } });
    } catch (e) {
      if (!(e instanceof HttpError) || (e.status !== 429 && e.status < 500)) throw e;
      return send(body);
    }
  }

  /** The parsed answer, from the cache or a call; undefined after `attempts` unparseable answers or an HTTP failure. */
  async complete<T>(body: ChatBody, parse: (text: string) => T | undefined, meta: { step: string } & Record<string, unknown>): Promise<Completion<T>> {
    const k = this.cacheKey(body);
    const hit = readJson<{ text: string; usage?: Usage }>(this.cachePath(k));
    if (hit) {
      const v = parse(hit.text);
      if (v !== undefined) {
        this.stats.cached++;
        return { value: v, text: hit.text, ...(hit.usage ? { usage: hit.usage } : {}), cached: true };
      }
    }
    return this.limit.run(async () => {
      let last = "";
      for (let attempt = 0; attempt < this.o.attempts; attempt++) {
        let r: Answer;
        try {
          r = await this.post(body);
        } catch (e) {
          this.stats.failed++;
          console.error(`${this.provider.name}/${body.model}: ${e instanceof Error ? e.message : String(e)}`);
          return { value: undefined, text: "", cached: false };
        }
        last = r.text;
        if (r.usage) this.record(body.model, meta, r.usage, r.cost);
        const v = parse(r.text);
        if (v !== undefined) {
          writeAtomic(this.cachePath(k), JSON.stringify({ provider: this.provider.name, model: body.model, text: r.text, usage: r.usage }) + "\n");
          return { value: v, text: r.text, ...(r.usage ? { usage: r.usage } : {}), cached: false };
        }
        console.error(`${this.provider.name}/${body.model}: attempt ${attempt + 1} unparseable`);
      }
      this.stats.failed++;
      return { value: undefined, text: last, cached: false };
    });
  }

  private record(model: string, meta: { step: string } & Record<string, unknown>, u: Usage, cost?: number): void {
    const d = cost ?? dollars(priceOf(this.o.prices, this.provider.name, model), u);
    this.stats.calls++;
    this.stats.input_tokens += u.input_tokens;
    this.stats.cached_input_tokens += u.cached_input_tokens;
    this.stats.output_tokens += u.output_tokens;
    this.stats.reasoning_tokens += u.reasoning_tokens ?? 0;
    if (d === null) this.stats.unpriced_calls++;
    else this.stats.dollars += d;
    logUsageLine(this.o.usageLog, { ...meta, provider: this.provider.name, model, ...u, dollars: d, cost_source: cost !== undefined ? "provider" : d === null ? "unknown" : "prices.json" });
  }
}
