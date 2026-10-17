// The extraction model switch (UNSTALE_EXTRACT_MODEL): provider:model parsing, and the chat-completions path's cache,
// truncation and usage logging.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { extractLlm, extractModel, llmStats } from "../src/pipeline/llm.ts";

const prev = { ...process.env };
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-llm-"));
  process.env.AI_GATEWAY_API_KEY = "test-key";
  process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
});
afterAll(() => {
  for (const k of ["UNSTALE_CENTRAL_DIR", "AI_GATEWAY_API_KEY", "UNSTALE_EXTRACT_MODEL"]) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
});

const answer = (content: string, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } }), { status: 200 });

describe("extractModel", () => {
  test("defaults to Luna on Codex at low effort", () => {
    expect(extractModel({})).toEqual({ provider: "codex", model: "gpt-5.6-luna", effort: "low", tier: "default" });
  });
  test("parses provider:model and keeps slashes in the model", () => {
    expect(extractModel({ UNSTALE_EXTRACT_MODEL: "vercel:openai/gpt-6-luna", UNSTALE_EXTRACT_EFFORT: "medium" })).toEqual({ provider: "vercel", model: "openai/gpt-6-luna", effort: "medium", tier: "flex" });
    expect(extractModel({ UNSTALE_EXTRACT_MODEL: "vercel:openai/gpt-6-luna", UNSTALE_EXTRACT_SERVICE_TIER: "default" }).tier).toBe("default");
  });
  test("rejects an unknown provider or a bare model", () => {
    expect(() => extractModel({ UNSTALE_EXTRACT_MODEL: "nope:x" })).toThrow(/unknown provider/);
    expect(() => extractModel({ UNSTALE_EXTRACT_MODEL: "gpt-6-luna" })).toThrow(/provider:model/);
  });
});

describe("extractLlm on chat completions", () => {
  test("sends model, effort and max_tokens; caches a parsed answer", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return answer("[1,2]");
    }) as unknown as typeof fetch;
    const parse = (t: string) => JSON.parse(t) as number[];
    expect(await extractLlm("prompt one", parse, { fetch: f, backoffMs: 1 })).toEqual([1, 2]);
    expect(bodies[0]).toMatchObject({ model: "openai/gpt-6-luna", reasoning_effort: "low", max_tokens: 16000 });
    expect(await extractLlm("prompt one", parse, { fetch: f, backoffMs: 1 })).toEqual([1, 2]);
    expect(bodies).toHaveLength(1);
    expect(llmStats.cached).toBe(1);
    const log = readFileSync(join(process.env.UNSTALE_CENTRAL_DIR!, "usage.jsonl"), "utf8");
    expect(log).toContain("\"dollars\":0.001");
  });
  test("the gateway asks for flex, outside the cache key; a capacity refusal is retried once at the default tier", async () => {
    const tiers: unknown[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { providerOptions?: { gateway?: { serviceTier?: string } } };
      tiers.push(b.providerOptions?.gateway?.serviceTier);
      return b.providerOptions ? new Response("no flex capacity", { status: 429 }) : answer("[7]");
    }) as unknown as typeof fetch;
    expect(await extractLlm("prompt flex", (t) => JSON.parse(t) as number[], { fetch: f, backoffMs: 1 })).toEqual([7]);
    expect(tiers.at(0)).toBe("flex");
    expect(tiers.at(-1)).toBeUndefined();
    const before = tiers.length;
    expect(await extractLlm("prompt flex", (t) => JSON.parse(t) as number[], { fetch: f, backoffMs: 1 })).toEqual([7]);
    expect(tiers).toHaveLength(before); // cached under the tier-free key
  });
  test("a truncated answer is retried, never parsed", async () => {
    let n = 0;
    const f = (async () => (++n === 1 ? answer("[1", "length") : answer("[3]"))) as unknown as typeof fetch;
    const seen: string[] = [];
    const v = await extractLlm("prompt two", (t) => {
      seen.push(t);
      return JSON.parse(t) as number[];
    }, { fetch: f, backoffMs: 1 });
    expect(v).toEqual([3]);
    expect(seen).toEqual(["[3]"]);
  });
  test("undefined after three unparseable answers", async () => {
    const f = (async () => answer("not json")) as unknown as typeof fetch;
    const before = llmStats.failed;
    expect(await extractLlm("prompt three", () => undefined, { fetch: f, backoffMs: 1 })).toBeUndefined();
    expect(llmStats.failed).toBe(before + 1);
  });
});
