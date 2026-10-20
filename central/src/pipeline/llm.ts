// OpenAI-compatible chat-completions calls, and the extraction models (steps A+B). UNSTALE_EXTRACT_MODEL is the primary,
// `provider:model`, default `vercel:minimax/minimax-m3.1-flash` (free on the AI gateway; eval/select/slice11, with its
// own extract prompt, extract.ts extractPromptFor). UNSTALE_EXTRACT_FALLBACK (default `vercel:openai/gpt-6-luna`, slice
// 3b's pick; `none` for no fallback) answers when the primary fails: an HTTP error or exhausted 429s, a truncated
// answer, or no parseable answer. The fallback also answers the classifier's chat fallback (classify/adapter.ts,
// ChatClassifier). `openai:<model>` calls the OpenAI API directly. No step calls the Codex CLI. UNSTALE_EXTRACT_EFFORT
// sets reasoning_effort (default low). UNSTALE_EXTRACT_SERVICE_TIER (default flex on the gateway) asks for the
// provider's flex tier: the same model at 50% of list price, slower (verified 16 October 2026 on openai/gpt-6-luna:
// billed at 0.50x; a model without a flex tier ignores it). A flex call the provider refuses for capacity is retried
// once at the default tier, and the tier is not part of the cache key (same model, same answer distribution). Answers
// are cached by sha256(provider + request body). The body names the model, so each model's answers keep their own keys
// and a change of primary leaves every cached answer valid: a lookup reads every model's key before any call. Answers
// are cached only when they parse, so a failed or unparseable call is retried on the next run. A truncated answer
// (finish_reason `length`) is not retried: the same request would run out of room again. It is recorded beside the
// answers (`<key>.length`), so a later run does not pay for it again, and the caller is told (`onLength`): extraction
// splits the chunk (extract.ts). The cache entry and the usage log name the model that answered.
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromEnvFile } from "./classify/adapter.ts";
import { hashedPacks } from "./packs.ts";
import { centralDir } from "./paths.ts";
import { canonical, logUsage, sha256, sleep } from "./util.ts";

const keyDir = join(homedir(), ".config", "ati");

/** The first JSON value of the expected kind in a model answer (fenced or not); undefined when none parses. */
export function parseJson(text: string, kind: "array" | "object"): unknown {
  const re = kind === "array" ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const m = re.exec(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}

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

export const DEFAULT_EXTRACT_MODEL = "vercel:minimax/minimax-m3.1-flash";
export const DEFAULT_EXTRACT_FALLBACK = "vercel:openai/gpt-6-luna";

function parseSpec(spec: string, name: string, env: NodeJS.ProcessEnv): ExtractModel {
  const i = spec.indexOf(":");
  if (i <= 0) throw new Error(`${name} must be provider:model, got ${spec}`);
  const provider = spec.slice(0, i);
  if (!PROVIDERS[provider]) throw new Error(`${name}: unknown provider ${provider}`);
  return { provider, model: spec.slice(i + 1), effort: env.UNSTALE_EXTRACT_EFFORT ?? "low", tier: env.UNSTALE_EXTRACT_SERVICE_TIER ?? (provider === "vercel" ? "flex" : "default") };
}

/** The primary extraction model (UNSTALE_EXTRACT_MODEL). */
export function extractModel(env: NodeJS.ProcessEnv = process.env): ExtractModel {
  return parseSpec(env.UNSTALE_EXTRACT_MODEL ?? DEFAULT_EXTRACT_MODEL, "UNSTALE_EXTRACT_MODEL", env);
}

/** The fallback extraction model (UNSTALE_EXTRACT_FALLBACK; `none`, or the primary itself, means no fallback). */
export function fallbackModel(env: NodeJS.ProcessEnv = process.env): ExtractModel | undefined {
  const spec = env.UNSTALE_EXTRACT_FALLBACK ?? DEFAULT_EXTRACT_FALLBACK;
  if (spec === "none") return undefined;
  const m = parseSpec(spec, "UNSTALE_EXTRACT_FALLBACK", env);
  const p = extractModel(env);
  return m.provider === p.provider && m.model === p.model ? undefined : m;
}

/** The models an extraction call tries, in order: the primary, then the fallback. */
export function extractModels(env: NodeJS.ProcessEnv = process.env): ExtractModel[] {
  const f = fallbackModel(env);
  return f ? [extractModel(env), f] : [extractModel(env)];
}

/** The classifier's chat fallback (classify/adapter.ts): the extraction fallback when there is one (gpt-6-luna), so its
 * answers and cache keys do not move with the primary extraction model. */
export function classifierModel(env: NodeJS.ProcessEnv = process.env): ExtractModel {
  return fallbackModel(env) ?? extractModel(env);
}

export const llmStats = {
  calls: 0,
  cached: 0,
  failed: 0,
  truncated: 0,
  /** Calls handed to the next model after the previous one failed (HTTP error, exhausted 429s, truncation, unparseable). */
  fallbacks: 0,
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  dollars: 0,
  /** Answers per model (`provider:model`), called or cached. */
  answered_by: {} as Record<string, number>,
};

const MAX_TOKENS = 16_000;
const limiters = new Map<string, Limiter>();
/** Calls in flight per model: UNSTALE_EXTRACT_CONCURRENCY (default 5) for the primary, 5 for any other model. */
function limiterOf(m: ExtractModel, primary: boolean): Limiter {
  const id = `${m.provider}:${m.model}`;
  let l = limiters.get(id);
  if (!l) limiters.set(id, (l = new Limiter(primary ? Math.max(1, Number(process.env.UNSTALE_EXTRACT_CONCURRENCY) || 5) : 5)));
  return l;
}

/** `responseFormat` is a chat-completions `response_format`. */
export interface CallOptions {
  responseFormat?: unknown;
  maxTokens?: number;
  /** The prompt a given model is asked (extract.ts extractPromptFor); default: the prompt as given, for every model. */
  promptFor?: (m: ExtractModel) => string;
  /** The models to try, in order (default extractModels()). */
  models?: ExtractModel[];
}

/** The model cache: an answer under its request's key, a truncated answer's usage under `<key>.length` (packs.ts). */
const llmCache = () => hashedPacks(join(centralDir(), "cache", "llm"), 3);

function chatRequest(m: ExtractModel, prompt: string, o: CallOptions): { body: ChatBody; key: string } {
  const p = PROVIDERS[m.provider]!;
  const body: ChatBody = { model: m.model, messages: [{ role: "user", content: o.promptFor ? o.promptFor(m) : prompt }], max_tokens: o.maxTokens ?? MAX_TOKENS, reasoning_effort: m.effort };
  if (o.responseFormat) body.response_format = o.responseFormat;
  const key = sha256(`${p.name}\n${canonical(body)}`);
  return { body, key };
}

/** Each model's request and cache key for this prompt, in the order they are tried. Every model keeps its own keys, so
 * answers cached under one model stay valid when the primary changes. */
function requests(prompt: string, o: CallOptions): Array<{ m: ExtractModel; body: ChatBody; key: string }> {
  return (o.models ?? extractModels()).map((m) => ({ m, ...chatRequest(m, prompt, o) }));
}

/** The key the primary model's answer to this prompt is cached under. */
export function extractCacheKey(prompt: string, o: CallOptions = {}): string {
  return requests(prompt, o)[0]!.key;
}

/** Caches an answer for the primary model, or for `o.models[0]` (tests). */
export function putExtractCache(prompt: string, text: string, o: CallOptions = {}): void {
  llmCache().put(extractCacheKey(prompt, o), JSON.stringify({ text }));
}

/** Whether any model of the chain already has a parsed answer to this prompt cached (a call would be free). */
export function extractCached(prompt: string, o: CallOptions = {}): boolean {
  const cache = llmCache();
  return requests(prompt, o).some((r) => cache.has(r.key));
}

/** Whether an answer to this prompt was truncated (finish_reason `length`) and none is cached: extractLlm will not ask again. */
export function extractTruncated(prompt: string, o: CallOptions = {}): boolean {
  const cache = llmCache();
  const rs = requests(prompt, o);
  return !rs.some((r) => cache.has(r.key)) && rs.some((r) => cache.has(`${r.key}.length`));
}

type Outcome<T> = { value: T } | { why: "http" | "truncated" | "unparseable"; detail?: string };

/**
 * Asks the models in order (default: the primary, then the fallback) and returns the first parsed answer. Before any
 * call, every model's cache is read (the primary's first), so a prompt some model already answered is never asked
 * again. A recorded truncation of any model means the request ran out of room: no model is asked, the caller is told
 * (`onLength`) and splits the chunk. Otherwise each model is called in turn: one that fails (HTTP error or exhausted
 * 429s, a truncated answer, no parseable answer within its attempts) hands the request to the next. Only the last
 * model's truncation reaches `onLength`. The primary gets 1 retry on 429/5xx and 2 attempts at a parseable answer
 * when a fallback follows, and no retry at the default tier after a flex refusal (so a rate-limited free model gives
 * way quickly); the last model gets 4 and 3.
 */
export async function extractLlm<T>(
  prompt: string,
  parse: (text: string) => T | undefined,
  o: { fetch?: typeof fetch; backoffMs?: number; onLength?: () => void } & CallOptions = {},
): Promise<T | undefined> {
  const rs = requests(prompt, o);
  const cache = llmCache();
  for (const r of rs) {
    const cached = cache.get(r.key);
    const hit = cached && (JSON.parse(cached.toString("utf8")) as { text: string });
    if (!hit) continue;
    const v = parse(hit.text);
    if (v !== undefined) {
      llmStats.cached++;
      const id = `${r.m.provider}:${r.m.model}`;
      llmStats.answered_by[id] = (llmStats.answered_by[id] ?? 0) + 1;
      return v;
    }
  }
  if (rs.some((r) => cache.has(`${r.key}.length`))) {
    llmStats.truncated++;
    o.onLength?.();
    return undefined;
  }
  const backoffMs = o.backoffMs ?? 2000;
  for (const [i, r] of rs.entries()) {
    const last = i === rs.length - 1;
    const role = i === 0 ? "primary" : "fallback";
    const out: Outcome<T> = await limiterOf(r.m, i === 0).run(() => callModel(r, parse, { ...o, backoffMs }, role, last ? { retries: 4, attempts: 3, last } : { retries: 1, attempts: 2, last }));
    if ("value" in out) return out.value;
    if (last) {
      llmStats.failed++;
      if (out.why === "truncated") o.onLength?.();
      return undefined;
    }
    llmStats.fallbacks++;
    const next = rs[i + 1]!.m;
    console.error(`${r.m.provider}/${r.m.model}: ${out.why}${out.detail ? ` (${out.detail})` : ""}; falling back to ${next.provider}/${next.model}`);
    logUsage({ event: "extract-fallback", api: r.m.provider, model: r.m.model, to: `${next.provider}:${next.model}`, reason: out.why });
  }
  return undefined;
}

async function callModel<T>(
  r: { m: ExtractModel; body: ChatBody; key: string },
  parse: (text: string) => T | undefined,
  o: { fetch?: typeof fetch; backoffMs: number },
  role: "primary" | "fallback",
  limits: { retries: number; attempts: number; last: boolean },
): Promise<Outcome<T>> {
  const { m, body, key } = r;
  const p = PROVIDERS[m.provider]!;
  const cache = llmCache();
  const id = `${m.provider}:${m.model}`;
  for (let attempt = 0; attempt < limits.attempts; attempt++) {
    let a: Answer;
    try {
      const post = (b: ChatBody) => postChat(p, b, { apiKey: keyFromEnvFile(p.keyFile, p.keyVar), backoffMs: o.backoffMs, timeoutMs: 10 * 60 * 1000, retries: limits.retries, ...(o.fetch ? { fetch: o.fetch } : {}) });
      if (m.tier === "default") a = await post(body);
      else {
        try {
          a = await post({ ...body, providerOptions: { gateway: { serviceTier: m.tier } } });
        } catch (e) {
          // A model with a fallback after it gives way instead of retrying at the default tier.
          if (!(e instanceof HttpError) || (e.status !== 429 && e.status < 500) || !limits.last) throw e;
          console.error(`${p.name}/${m.model}: ${m.tier} tier unavailable (${e.message}); retrying at the default tier`);
          a = await post(body);
        }
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`${p.name}/${m.model}: ${detail}`);
      return { why: "http", detail };
    }
    if (a.usage) {
      llmStats.calls++;
      llmStats.input_tokens += a.usage.input_tokens;
      llmStats.cached_input_tokens += a.usage.cached_input_tokens;
      llmStats.output_tokens += a.usage.output_tokens;
      llmStats.reasoning_tokens += a.usage.reasoning_tokens ?? 0;
      llmStats.dollars += a.cost ?? 0;
      logUsage({ api: p.name, model: m.model, role, effort: m.effort, tier: m.tier, ...a.usage, ...(a.cost !== undefined ? { dollars: a.cost } : {}), finish: a.finish });
    }
    if (a.finish === "length") {
      console.error(`${p.name}/${m.model}: attempt ${attempt + 1} truncated; not retried`);
      cache.put(`${key}.length`, JSON.stringify({ provider: p.name, model: m.model, finish: a.finish, usage: a.usage }) + "\n");
      llmStats.truncated++;
      return { why: "truncated" };
    }
    const v = parse(a.text);
    if (v !== undefined) {
      cache.put(key, JSON.stringify({ provider: p.name, model: m.model, text: a.text, usage: a.usage }) + "\n");
      llmStats.answered_by[id] = (llmStats.answered_by[id] ?? 0) + 1;
      return { value: v };
    }
    console.error(`${p.name}/${m.model}: attempt ${attempt + 1} unparseable`);
    if (attempt + 1 < limits.attempts) await sleep(o.backoffMs * (attempt + 1));
  }
  return { why: "unparseable" };
}
