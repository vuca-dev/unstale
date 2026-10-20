// The release notes' chain (llm.ts releaseModels, extract.ts): MiniMax first with its own extract prompt, gpt-6-luna
// after it on an HTTP error, exhausted 429s, a truncated or an unparseable answer; upgrade guides and docs notes on
// gpt-6-luna alone; every model's cache read before any call, so answers cached under gpt-6-luna before the switch are
// not asked again; the answering model and its role in the cache entry and the usage log.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { extractCached, extractLlm, extractModel, extractTruncated, llmStats, putExtractCache, releaseModel, releaseModels } from "../src/pipeline/llm.ts";
import { EVIDENCE_FIELD, EXTRACT_PROMPT, extractPromptFor, extractRelease, fill, LINK_RULE, releaseCached, STATEMENT_EVIDENCE } from "../src/pipeline/extract.ts";
import type { GuideNote, ReleaseNote } from "../src/pipeline/fetch.ts";
import type { Technology } from "../src/pipeline/technologies.ts";
import { sha256 } from "../src/pipeline/util.ts";

const OWN = ["UNSTALE_CENTRAL_DIR", "AI_GATEWAY_API_KEY", "UNSTALE_EXTRACT_MODEL", "UNSTALE_RELEASE_MODEL"];
const prev = Object.fromEntries(OWN.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-llm-chain-"));
  process.env.AI_GATEWAY_API_KEY = "test-key";
  delete process.env.UNSTALE_EXTRACT_MODEL;
  delete process.env.UNSTALE_RELEASE_MODEL;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  for (const k of OWN) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
});

const MM = "minimax/minimax-m3.1-flash";
const LUNA = "openai/gpt-6-luna";
const answer = (content: string, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 } }), { status: 200 });
/** A gateway stub: `by[model]` answers each call to that model in turn (the last one repeats). */
function gateway(by: Record<string, Array<() => Response>>) {
  const calls: Array<{ model: string; prompt: string }> = [];
  const n: Record<string, number> = {};
  const f = (async (_url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as { model: string; messages: Array<{ content: string }> };
    calls.push({ model: b.model, prompt: b.messages[0]!.content });
    const xs = by[b.model]!;
    const i = Math.min((n[b.model] = (n[b.model] ?? 0) + 1) - 1, xs.length - 1);
    return xs[i]!();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const nums = (t: string) => {
  try {
    const v = JSON.parse(t) as unknown;
    return Array.isArray(v) ? (v as number[]) : undefined;
  } catch {
    return undefined;
  }
};
const usage = () => readFileSync(join(process.env.UNSTALE_CENTRAL_DIR!, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("the extraction models", () => {
  test("gpt-6-luna extracts; release notes go to MiniMax first; `none` or the extraction model itself means no release model", () => {
    expect(extractModel({}).model).toBe(LUNA);
    expect(releaseModels({}).map((m) => m.model)).toEqual([MM, LUNA]);
    expect(releaseModel({ UNSTALE_RELEASE_MODEL: "none" })).toBeUndefined();
    expect(releaseModels({ UNSTALE_RELEASE_MODEL: "none" }).map((m) => m.model)).toEqual([LUNA]);
    expect(releaseModel({ UNSTALE_RELEASE_MODEL: `vercel:${LUNA}` })).toBeUndefined();
    expect(releaseModels({ UNSTALE_EXTRACT_MODEL: `vercel:${MM}` }).map((m) => m.model)).toEqual([MM]);
    expect(() => releaseModel({ UNSTALE_RELEASE_MODEL: "x" })).toThrow(/UNSTALE_RELEASE_MODEL must be provider:model/);
  });
});

describe("extractLlm with a fallback", () => {
  test("the primary answers when it can; the answer is cached under its own key with its model", async () => {
    const g = gateway({ [MM]: [() => answer("[1]")], [LUNA]: [() => answer("[9]")] });
    expect(await extractLlm("chain one", nums, { fetch: g.f, backoffMs: 1, models: releaseModels() })).toEqual([1]);
    expect(g.calls.map((c) => c.model)).toEqual([MM]);
    expect(usage().at(-1)).toMatchObject({ api: "vercel", model: MM, role: "primary" });
  });

  test.each([
    ["an HTTP error", () => new Response("bad gateway", { status: 502 }), "http"],
    ["exhausted 429s", () => new Response("slow down", { status: 429 }), "http"],
    ["a truncated answer", () => answer("[1", "length"), "truncated"],
    ["an unparseable answer", () => answer("no json here"), "unparseable"],
  ])("falls back to gpt-6-luna on %s, and logs why", async (_, bad, reason) => {
    const prompt = `chain ${reason} ${Math.random()}`;
    const g = gateway({ [MM]: [bad], [LUNA]: [() => answer("[2]")] });
    const before = llmStats.fallbacks;
    let lengths = 0;
    expect(await extractLlm(prompt, nums, { fetch: g.f, backoffMs: 1, models: releaseModels(), onLength: () => lengths++ })).toEqual([2]);
    expect(g.calls.at(-1)!.model).toBe(LUNA);
    // The primary gives way quickly: 1 retry on 429/5xx, 2 attempts at a parseable answer, none after truncation.
    expect(g.calls.filter((c) => c.model === MM)).toHaveLength(reason === "truncated" ? 1 : 2);
    expect(lengths).toBe(0);
    expect(llmStats.fallbacks).toBe(before + 1);
    expect(usage().some((u) => u.event === "extract-fallback" && u.model === MM && u.reason === reason && u.to === `vercel:${LUNA}`)).toBe(true);
    expect(usage().at(-1)).toMatchObject({ model: LUNA, role: "fallback" });
    // Cached under gpt-6-luna's key: asked again, nobody is called.
    const n = g.calls.length;
    expect(await extractLlm(prompt, nums, { fetch: g.f, backoffMs: 1, models: releaseModels() })).toEqual([2]);
    expect(g.calls).toHaveLength(n);
  });

  test("undefined when both fail; only the last model's truncation asks the caller to split", async () => {
    const g = gateway({ [MM]: [() => answer("[1", "length")], [LUNA]: [() => answer("[1", "length")] });
    let lengths = 0;
    expect(await extractLlm("chain both truncated", nums, { fetch: g.f, backoffMs: 1, models: releaseModels(), onLength: () => lengths++ })).toBeUndefined();
    expect(lengths).toBe(1);
    expect(extractTruncated("chain both truncated", { models: releaseModels() })).toBe(true);
    const h = gateway({ [MM]: [() => new Response("x", { status: 500 })], [LUNA]: [() => answer("nope")] });
    lengths = 0;
    expect(await extractLlm("chain both fail", nums, { fetch: h.f, backoffMs: 1, models: releaseModels(), onLength: () => lengths++ })).toBeUndefined();
    expect(lengths).toBe(0);
    expect(h.calls.filter((c) => c.model === LUNA)).toHaveLength(3);
  });

  test("an answer gpt-6-luna cached before the switch is used as is: no call, no re-extraction", async () => {
    const prompt = "chain cached by luna";
    putExtractCache(prompt, "[5]");
    expect(extractCached(prompt, { models: releaseModels() })).toBe(true);
    const g = gateway({ [MM]: [() => answer("[1]")], [LUNA]: [() => answer("[9]")] });
    expect(await extractLlm(prompt, nums, { fetch: g.f, backoffMs: 1, models: releaseModels() })).toEqual([5]);
    expect(g.calls).toHaveLength(0);
    expect(llmStats.answered_by[`vercel:${LUNA}`]).toBeGreaterThan(0);
  });

  test("a truncation gpt-6-luna recorded before the switch still sends the chunk to splitting, without a call", async () => {
    const prompt = "chain luna truncated earlier";
    const g = gateway({ [MM]: [() => answer("[1", "length")], [LUNA]: [() => answer("[1", "length")] });
    await extractLlm(prompt, nums, { fetch: g.f, backoffMs: 1 });
    let lengths = 0;
    const n = g.calls.length;
    expect(await extractLlm(prompt, nums, { fetch: g.f, backoffMs: 1, models: releaseModels(), onLength: () => lengths++ })).toBeUndefined();
    expect(g.calls).toHaveLength(n);
    expect(lengths).toBe(1);
  });

  test("each model is asked its own prompt: MiniMax the statement evidence field, gpt-6-luna production's prompt unchanged", async () => {
    const prompt = fill(EXTRACT_PROMPT, { TECH: "zod", VERSION: "4.0.0", DATE: "2026-01-01", PART: "", NOTES: "- `z.email()` is new." });
    const promptFor = (m: { model: string }) => extractPromptFor(m.model, prompt);
    const g = gateway({ [MM]: [() => new Response("x", { status: 503 })], [LUNA]: [() => answer("[]")] });
    expect(await extractLlm(prompt, nums, { fetch: g.f, backoffMs: 1, models: releaseModels(), promptFor })).toEqual([]);
    const mm = g.calls.find((c) => c.model === MM)!.prompt, luna = g.calls.find((c) => c.model === LUNA)!.prompt;
    expect(luna).toBe(prompt);
    expect(mm).toBe(prompt.replace(EVIDENCE_FIELD, STATEMENT_EVIDENCE).replace("If nothing qualifies, output [].", `If nothing qualifies, output [].\n${LINK_RULE}`));
    expect(mm).not.toContain(EVIDENCE_FIELD);
  });
});

describe("extractRelease routes by note kind", () => {
  const t = { id: "zod", name: "zod", repo: "colinhacks/zod", components: ["pkg:npm/zod"] } as unknown as Technology;
  const record = JSON.stringify([{ subject: "z.email()", summary: "z.email() is new.", change_type: "feature", evidence: "`z.email()` is new." }]);
  const stub = (by: Record<string, () => Response>) => {
    const calls: Array<{ model: string; prompt: string }> = [];
    vi.stubGlobal("fetch", (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { model: string; messages: Array<{ content: string }> };
      calls.push({ model: b.model, prompt: b.messages[0]!.content });
      return by[b.model]!();
    }) as unknown as typeof fetch);
    return calls;
  };
  const label = () => answer(JSON.stringify({ r1: { terms: ["z.email"] } }));
  test("a release note: steps A and B go to MiniMax, A with its own prompt, B with LABEL_PROMPT unchanged", async () => {
    const rel = { technology: "zod", tag: "v4.0.1", version: "4.0.1", date: "2026-01-01", url: "u", snapshot: "s1", notes: "- `z.email()` is new." } as ReleaseNote;
    const calls = stub({ [MM]: () => (calls.length > 1 ? label() : answer(record)), [LUNA]: () => answer("[]") });
    const r = await extractRelease(t, rel);
    expect(r.failed).toBe(0);
    expect(r.incoming).toHaveLength(1);
    expect(calls.map((c) => c.model)).toEqual([MM, MM]);
    expect(calls[0]!.prompt).toContain(STATEMENT_EVIDENCE);
    expect(calls[1]!.prompt.startsWith("You write search terms")).toBe(true);
    // Cached under MiniMax's keys: extracting again is free.
    expect(releaseCached(t, rel)).toBe(true);
  });
  test("a release note MiniMax cannot answer goes to gpt-6-luna with production's prompt", async () => {
    const rel = { technology: "zod", tag: "v4.0.2", version: "4.0.2", date: "2026-01-02", url: "u", snapshot: "s2", notes: "- `z.url()` is new." } as ReleaseNote;
    const calls = stub({ [MM]: () => new Response("x", { status: 500 }), [LUNA]: () => (calls.filter((c) => c.model === LUNA).length > 1 ? label() : answer(record)) });
    const r = await extractRelease(t, rel);
    expect(r.incoming).toHaveLength(1);
    const luna = calls.filter((c) => c.model === LUNA);
    expect(luna).toHaveLength(2);
    expect(luna[0]!.prompt).toBe(fill(EXTRACT_PROMPT, { TECH: "zod", VERSION: "4.0.2", DATE: "2026-01-02", PART: "", NOTES: rel.notes }));
  });
  test("an upgrade guide goes to gpt-6-luna alone", async () => {
    const g = { technology: "zod", kind: "upgrade_guide", keyTag: "+guide.x", tag: "guide-4", version: "4.0.0", date: "2026-01-03", url: "g", snapshot: "s3", notes: "- `z.ip()` is removed." } as GuideNote;
    const calls = stub({ [MM]: () => answer(record), [LUNA]: () => (calls.length > 1 ? label() : answer(record)) });
    await extractRelease(t, g);
    expect(calls.map((c) => c.model)).toEqual([LUNA, LUNA]);
    expect(calls[0]!.prompt).not.toContain(STATEMENT_EVIDENCE);
  });
});

describe("extractPromptFor", () => {
  test("only MiniMax's extract prompt changes: its evidence field and the link rule (r3, frozen in eval/select/slice11)", () => {
    expect(extractPromptFor(LUNA, EXTRACT_PROMPT)).toBe(EXTRACT_PROMPT);
    expect(extractPromptFor(MM, "You write search terms… " + EVIDENCE_FIELD)).toContain(EVIDENCE_FIELD);
    const mm = extractPromptFor(MM, EXTRACT_PROMPT);
    expect(mm.replace(STATEMENT_EVIDENCE, EVIDENCE_FIELD).replace(`\n${LINK_RULE}`, "")).toBe(EXTRACT_PROMPT);
    expect(sha256(mm)).toBe(FROZEN_SHA);
  });
});
// The template slice 11 froze on DEV (run3.mts --addendum mm-r3, meta.json prompt_sha.extract), unchanged in slice 12.
const FROZEN_SHA = "2f578d1beb5902437372ff550f5a181de3461c4125cb5fdc8c4d8ef2732f4370";
