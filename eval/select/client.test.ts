// Mocked-fetch tests for the model-selection client, the Jev usage path and the budget guard (no network).
//   cd central && npx vitest run --root ../eval/select
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { labelQuestions } from "../../central/src/pipeline/classify/labels.ts";
import { checkBudget, gatewayBalance, spendByProvider } from "./budget.ts";
import { ChatClient, dollars, parseUsage, PROVIDERS, type Price } from "./client.ts";
import { chatClassifier, jevClassifier } from "./jev.ts";
import { ONE_CALL_PROMPT } from "./prompts.ts";

const PRICES: Price[] = [
  { provider: "vercel", model: "m", input: 1, cached_input: 0.1, output: 2, source: "test", checked: "2026-10-16" },
  { provider: "vercel", model: "unpriced", input: null, cached_input: null, output: null, source: "test", checked: null },
  { provider: "jev", model: "jev-latest", input: 0.042, cached_input: null, output: 0, source: "test", checked: "2026-10-16" },
];

const completion = (content: string, usage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 120 } }, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage, ...extra }), { status: 200, headers: { "Content-Type": "application/json" } });

function setup(responses: Array<Response | Error>) {
  const dir = mkdtempSync(join(tmpdir(), "select-test-"));
  const calls: Array<{ url: string; body: unknown }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = responses.shift();
    if (!r) throw new Error("no more mocked responses");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const client = new ChatClient({ provider: PROVIDERS.vercel!, fetch: f, apiKey: () => "k", backoffMs: 0, cacheDir: join(dir, "cache"), usageLog: join(dir, "usage.jsonl"), prices: PRICES });
  return { dir, calls, client, log: () => readFileSync(join(dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const json = (t: string) => {
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
};

describe("usage parsing", () => {
  it("reads input, cached input, output and reasoning tokens", () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } })).toEqual({
      input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_tokens: 3,
    });
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_tokens: null });
    expect(parseUsage(undefined)).toBeUndefined();
  });

  it("prices cached input at its own rate and never turns an unknown price into $0", () => {
    const u = { input_tokens: 1e6, cached_input_tokens: 4e5, output_tokens: 5e5, reasoning_tokens: 1e5 };
    expect(dollars(PRICES[0], u)).toBeCloseTo(0.6 * 1 + 0.4 * 0.1 + 0.5 * 2);
    expect(dollars(PRICES[1], u)).toBeNull();
    expect(dollars(undefined, u)).toBeNull();
  });
});

describe("ChatClient", () => {
  it("logs one usage line per real call with tokens and dollars, then serves the cache", async () => {
    const t = setup([completion('{"a":1}')]);
    const body = { model: "m", messages: [{ role: "user", content: "q" }] };
    const r1 = await t.client.complete(body, json, { step: "test" });
    expect(r1).toMatchObject({ value: { a: 1 }, cached: false, usage: { reasoning_tokens: 120, cached_input_tokens: 400 } });
    const r2 = await t.client.complete(body, json, { step: "test" });
    expect(r2).toMatchObject({ value: { a: 1 }, cached: true });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    const log = t.log();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ provider: "vercel", model: "m", step: "test", input_tokens: 1000, cached_input_tokens: 400, output_tokens: 300, reasoning_tokens: 120, cost_source: "prices.json" });
    expect(log[0]!.dollars as number).toBeCloseTo((600 * 1 + 400 * 0.1 + 300 * 2) / 1e6);
  });

  it("uses the provider's reported cost when the response has one", async () => {
    const t = setup([completion('{"a":1}', undefined, { usage: { prompt_tokens: 10, completion_tokens: 2, cost: "0.000123" } })]);
    await t.client.complete({ model: "m", messages: [{ role: "user", content: "q" }] }, json, { step: "test" });
    expect(t.log()[0]).toMatchObject({ dollars: 0.000123, cost_source: "provider" });
  });

  it("logs an unknown price as null", async () => {
    const t = setup([completion('{"a":1}')]);
    await t.client.complete({ model: "unpriced", messages: [{ role: "user", content: "q" }] }, json, { step: "test" });
    expect(t.log()[0]).toMatchObject({ dollars: null, cost_source: "unknown" });
    expect(t.client.stats.unpriced_calls).toBe(1);
  });

  it("retries 429, 5xx and network errors, then succeeds", async () => {
    const t = setup([new Response("slow down", { status: 429 }), new Response("oops", { status: 503 }), new Error("ECONNRESET"), completion('{"ok":true}')]);
    const r = await t.client.complete({ model: "m", messages: [{ role: "user", content: "q" }] }, json, { step: "test" });
    expect(r.value).toEqual({ ok: true });
    expect(t.calls).toHaveLength(4);
    expect(t.log()).toHaveLength(1);
  });

  it("fails at once on 401 and caches nothing", async () => {
    const t = setup([new Response("no", { status: 401 }), completion('{"a":1}')]);
    const r = await t.client.complete({ model: "m", messages: [{ role: "user", content: "q" }] }, json, { step: "test" });
    expect(r.value).toBeUndefined();
    expect(t.calls).toHaveLength(1);
  });

  it("caches only answers that parse: an unparseable answer is retried and never stored", async () => {
    const t = setup([completion("not json"), completion('{"b":2}')]);
    const body = { model: "m", messages: [{ role: "user", content: "q2" }] };
    expect((await t.client.complete(body, json, { step: "test" })).value).toEqual({ b: 2 });
    expect(t.log()).toHaveLength(2);
    const t2 = setup([completion("still not json"), completion("no"), completion("nope")]);
    expect((await t2.client.complete(body, json, { step: "test" })).value).toBeUndefined();
    const t3 = new ChatClient({ provider: PROVIDERS.vercel!, fetch: (async () => completion('{"c":3}')) as unknown as typeof fetch, apiKey: () => "k", cacheDir: join(t2.dir, "cache"), usageLog: join(t2.dir, "u.jsonl"), prices: PRICES });
    expect(await t3.complete(body, json, { step: "test" })).toMatchObject({ value: { c: 3 }, cached: false });
  });

  it("keys the cache on provider, model and the full body", () => {
    const t = setup([]);
    const a = t.client.cacheKey({ model: "m", messages: [{ role: "user", content: "q" }] });
    expect(t.client.cacheKey({ model: "m", messages: [{ role: "user", content: "q" }], max_tokens: 5 })).not.toBe(a);
    expect(t.client.cacheKey({ model: "n", messages: [{ role: "user", content: "q" }] })).not.toBe(a);
  });
});

describe("classifier candidates", () => {
  it("Jev usage goes to the same log, priced as input only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "select-jev-"));
    process.env.UNSTALE_CENTRAL_DIR = join(dir, "central");
    const q = labelQuestions();
    const answers = Object.fromEntries(Object.entries(q).map(([id, x]) => [id, { choice: Object.keys(x.options)[0], confidence: 0.9, probabilities: Object.fromEntries(Object.keys(x.options).map((o, i) => [o, i === 0 ? 0.9 : 0.1 / (Object.keys(x.options).length - 1)])) }]));
    const f = (async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 2000, output_tokens: 50 } }), { status: 200 })) as unknown as typeof fetch;
    const jev = jevClassifier({ step: "classify", fetch: f, apiKey: () => "k", backoffMs: 0, usageLog: join(dir, "usage.jsonl"), prices: PRICES });
    const r = await jev.classify({ subject: "x" }, q);
    expect(r.classifier).toBe("jev");
    const log = readFileSync(join(dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ provider: "jev", model: "jev-latest", served_model: "jev-1.13.0", input_tokens: 2000, output_tokens: 50, step: "classify" });
    expect(log[0]!.dollars as number).toBeCloseTo((2000 * 0.042) / 1e6);
  });

  it("a chat model answers the classifier's questions through the pipeline's chat prompt, as a hard choice", async () => {
    const q = { breaking: { instructions: "Breaking?", options: { yes: "y", no: "n" } } };
    const t = setup([completion('{"breaking": {"choice": "yes", "probabilities": {"yes": 0.8, "no": 0.2}}}')]);
    const r = await chatClassifier(t.client, "m", "classify").classify({ subject: "x" }, q);
    expect(r.answers.breaking).toEqual({ choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } });
    expect(String((t.calls[0]!.body as { messages: Array<{ content: string }> }).messages[0]!.content)).toContain("closed-choice questions");
  });
});

describe("budget guard", () => {
  it("reads the gateway balance and refuses over-budget or unpriced runs", async () => {
    const f = (async () => new Response(JSON.stringify({ balance: "9.743642106", total_used: "20.25" }), { status: 200 })) as unknown as typeof fetch;
    expect(await gatewayBalance(f, () => "k")).toBeCloseTo(9.7436);
    expect(checkBudget(0.5, 8.74)).toBeUndefined();
    expect(checkBudget(9, 8.74)).toMatch(/exceeds/);
    expect(checkBudget(null, 8.74)).toMatch(/unknown/);
    expect(checkBudget(1e9, undefined)).toBeUndefined();
  });

  it("sums spend per provider from the usage log", () => {
    const t = setup([]);
    expect(spendByProvider(join(t.dir, "none.jsonl"))).toEqual({});
  });
});

describe("one-call prompt", () => {
  it("is the extraction prompt with the five label fields and the label rules", () => {
    expect(ONE_CALL_PROMPT).toContain('"terms": [search terms, rules below]');
    expect(ONE_CALL_PROMPT).toContain('Rules for "terms"');
    expect(ONE_CALL_PROMPT).toContain('"prerequisites" (usually [])');
    expect(ONE_CALL_PROMPT).toContain("%NOTES%");
    expect(ONE_CALL_PROMPT).not.toContain("%RECORDS%");
  });
});

describe("service tier", () => {
  it("the gateway asks for flex, keeping other provider options; the cache key is the request without it", async () => {
    const { calls, client } = setup([completion('{"a":1}')]);
    const body = { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "x" }], providerOptions: { gateway: { only: ["openai"] } } };
    const r = await client.complete(body, json, { step: "t" });
    expect(r.value).toEqual({ a: 1 });
    expect((calls[0]!.body as { providerOptions: unknown }).providerOptions).toEqual({ gateway: { only: ["openai"], serviceTier: "flex" } });
    expect((await client.complete(body, json, { step: "t" })).cached).toBe(true);
  });
  it("a refused flex request is retried once at the default tier", async () => {
    const { calls, client } = setup([new Response("busy", { status: 429 }), new Response("busy", { status: 429 }), new Response("busy", { status: 429 }), new Response("busy", { status: 429 }), new Response("busy", { status: 429 }), completion('{"b":2}')]);
    const r = await client.complete({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: "y" }] }, json, { step: "t" });
    expect(r.value).toEqual({ b: 2 });
    expect((calls.at(-1)!.body as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });
});
