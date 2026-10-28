// The classifier adapter: Jev first, the extraction chat model per-request fallback (CONTRACT: "Classifier"; the chat
// fallback since 16 October 2026). fetch (Jev) and the chat runner (llm.ts's extractLlm) are mocked.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { attributeEvidence, classifierAttribution, ChatClassifier, ClassifierCache, FallbackClassifier, Jev, type ChatRunner, type Questions } from "../src/pipeline/classify/adapter.ts";

const Q: Questions = {
  breaking: { instructions: "Breaking?", options: { yes: "Breaking.", no: "Not breaking." } },
  surface: { instructions: "Where?", options: { code_api: "Code.", configuration: "Config." } },
};
const STATE = { subject: "images.minimumCacheTTL", summary: "Default raised to 4 hours." };
const MODEL = "openai/gpt-6-luna";

type Call = { url: string; body: Record<string, unknown> };

function jevOk(body: { questions: Record<string, { criteria: Record<string, string> }> }) {
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([id, q]) => {
      const opts = Object.keys(q.criteria);
      return [id, { type: "choice", choice: opts[0], confidence: 0.8, probabilities: Object.fromEntries(opts.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / (opts.length - 1)])) }];
    }),
  );
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 10 } };
}
/** A chat answer to the choice prompt: the second option for every question (with stated probabilities it ignores). */
function chatOk(prompt: string): string {
  const qs = JSON.parse(prompt.slice(prompt.indexOf("Questions:\n") + 11)) as Record<string, { options: Record<string, string> }>;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(qs).map(([id, q]) => {
        const opts = Object.keys(q.options);
        return [id, { choice: opts[1], probabilities: Object.fromEntries(opts.map((o, i) => [o, i === 1 ? 0.7 : 0.3])) }];
      }),
    ),
  );
}

/** A fetch (Jev) and a chat runner that record calls; `jev` decides Jev's response per call. The runner retries as
 * llm.ts does: up to three attempts, the first answer that parses. */
function mockFetch(jev: (body: never, n: number) => Response | Promise<Response>, chatText: (prompt: string, n: number) => string = chatOk) {
  const calls: Call[] = [];
  let n = 0;
  let k = 0;
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as never;
    calls.push({ url, body });
    return jev(body, n++);
  }) as unknown as typeof fetch;
  const run: ChatRunner = async (prompt, parse, attribution) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      calls.push({ url: "chat:", body: { prompt, attribution } });
      const v = parse(chatText(prompt, k++));
      if (v) return v;
    }
    return undefined;
  };
  return { f, run, calls, jevCalls: () => calls.filter((c) => c.url.includes("typesafe")).length, chatCalls: () => calls.filter((c) => c.url.startsWith("chat:")).length };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-cls-"));
  process.env.UNSTALE_STORE = dir;
});

function make(jev: (body: never, n: number) => Response | Promise<Response>, timeoutMs = 30_000) {
  const m = mockFetch(jev);
  const opts = { fetch: m.f, apiKey: () => "test-key", backoffMs: 0 };
  const fb = new FallbackClassifier(new Jev({ ...opts, timeoutMs }), new ChatClassifier({ model: MODEL, run: m.run }), new ClassifierCache(join(dir, "cache")));
  return { m, fb };
}

describe("classifier adapter", () => {
  test("Jev answers: probabilities, confidence and the reported model are returned", async () => {
    const { m, fb } = make((b) => Response.json(jevOk(b)));
    const r = await fb.classify(STATE, Q);
    expect(r.classifier).toBe("jev");
    expect(r.model).toBe("jev-1.13.0");
    expect(r.answers.breaking).toEqual({ choice: "yes", confidence: 0.8, probabilities: { yes: 0.9, no: 0.1 } });
    expect(m.chatCalls()).toBe(0);
  });

  test("falls back on 401 without retrying Jev", async () => {
    const { m, fb } = make(() => new Response("no", { status: 401 }));
    const r = await fb.classify(STATE, Q);
    expect(r.classifier).toBe("chat");
    expect(r.answers.surface!.choice).toBe("configuration");
    // A text generator's answer is its choice alone: probability 1 for it, 0 for the rest, marked uncalibrated.
    expect(r.answers.surface).toEqual({ choice: "configuration", confidence: 1, probabilities: { code_api: 0, configuration: 1 } });
    expect(r.calibrated).toBe(false);
    expect(r.model).toBe(MODEL);
    expect([m.jevCalls(), m.chatCalls()]).toEqual([1, 1]);
    // The fallback's usage line is attributed as Jev's would be (llm.ts writes it).
    expect((m.calls.at(-1)!.body as { attribution?: unknown }).attribution).toEqual(classifierAttribution(STATE, Q));
  });

  test("retries 5xx three times, then falls back", async () => {
    const { m, fb } = make(() => new Response("busy", { status: 503 }));
    const r = await fb.classify(STATE, Q);
    expect(r.classifier).toBe("chat");
    expect(m.jevCalls()).toBe(4);
  });

  test("a 529 that recovers within the retries stays on Jev", async () => {
    const { m, fb } = make((b, n) => (n < 2 ? new Response("", { status: 529 }) : Response.json(jevOk(b))));
    expect((await fb.classify(STATE, Q)).classifier).toBe("jev");
    expect([m.jevCalls(), m.chatCalls()]).toEqual([3, 0]);
  });

  test("falls back on timeout", async () => {
    const hang = (_b: never, _n: number) => new Promise<Response>(() => {});
    const m = mockFetch(hang);
    // The mock never resolves, so the adapter's abort must end it.
    const f = (async (url: string, init: RequestInit) => {
      if (url.includes("typesafe")) {
        return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return m.f(url, init);
    }) as unknown as typeof fetch;
    const opts = { fetch: f, apiKey: () => "k", backoffMs: 0 };
    const fb = new FallbackClassifier(new Jev({ ...opts, timeoutMs: 30 }), new ChatClassifier({ model: MODEL, run: m.run }), new ClassifierCache(join(dir, "c")));
    expect((await fb.classify(STATE, Q)).classifier).toBe("chat");
  });

  test("falls back on malformed answers: a choice outside the set, a missing id, missing probabilities", async () => {
    const bad = [
      (b: never) => {
        const r = jevOk(b);
        r.answers.breaking!.choice = "maybe";
        return r;
      },
      (b: never) => {
        const r = jevOk(b);
        delete r.answers.surface;
        return r;
      },
      (b: never) => {
        const r = jevOk(b);
        r.answers.breaking!.probabilities = {};
        return r;
      },
    ];
    for (const mk of bad) {
      const { fb } = make((b) => Response.json(mk(b)));
      expect((await fb.classify(STATE, Q)).classifier).toBe("chat");
    }
  });

  test("Jev is disabled after ten consecutive fallbacks, and the event is logged", async () => {
    const { m, fb } = make(() => new Response("", { status: 401 }));
    for (let i = 0; i < 12; i++) await fb.classify({ ...STATE, i }, Q);
    expect(m.jevCalls()).toBe(10);
    expect(m.chatCalls()).toBe(12);
    expect(fb.disabled).toBe(true);
    const log = readFileSync(join(dir, "central", "usage.jsonl"), "utf8");
    expect(log).toContain('"event":"jev-disabled"');
  });

  test("a Jev success resets the consecutive count", async () => {
    const { m, fb } = make((b, n) => (n % 9 === 8 ? Response.json(jevOk(b)) : new Response("", { status: 401 })));
    for (let i = 0; i < 18; i++) await fb.classify({ ...STATE, i }, Q);
    expect(fb.disabled).toBe(false);
    expect(m.jevCalls()).toBe(18);
  });

  test("a cache hit makes no call, whichever classifier answered first", async () => {
    const { m, fb } = make(() => new Response("", { status: 401 }));
    const a = await fb.classify(STATE, Q);
    const before = m.calls.length;
    const b = await fb.classify(STATE, Q);
    expect(b).toEqual(a);
    expect(m.calls.length).toBe(before);
    // A new adapter over the same cache directory (a rerun) makes no call either.
    const again = make((x) => Response.json(jevOk(x)));
    const fb2 = new FallbackClassifier(
      new Jev({ fetch: again.m.f, apiKey: () => "k", backoffMs: 0 }),
      new ChatClassifier({ model: MODEL, run: again.m.run }),
      new ClassifierCache(join(dir, "cache")),
    );
    expect(await fb2.classify(STATE, Q)).toEqual(a);
    expect(again.m.calls.length).toBe(0);
  });

  test("Jev requests carry at most 8 questions; usage is logged per real call", async () => {
    const many: Questions = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`q${i}`, Q.breaking!]));
    const { m, fb } = make((b) => Response.json(jevOk(b)));
    const r = await fb.classify(STATE, many);
    expect(Object.keys(r.answers)).toHaveLength(11);
    expect(m.calls.map((c) => Object.keys(c.body.questions as object).length)).toEqual([8, 3]);
    const log = readFileSync(join(dir, "central", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ api: "jev", model: "jev-1.13.0", input_tokens: 100, output_tokens: 10, batch: 1, batches: 2, questions: 8 });
    expect(log[1]).toMatchObject({ batch: 2, batches: 2, questions: 3 });
    expect(log[0].request).not.toBe(log[1].request);
  });

  test("chat fallback: an answer naming an unknown option or skipping a question is retried, then unanswerable and recorded", async () => {
    const bad = [
      () => "not json",
      (p: string) => chatOk(p).replace('"configuration"', '"elsewhere"'),
      (p: string) => JSON.stringify({ breaking: JSON.parse(chatOk(p)).breaking }),
    ];
    for (const text of bad) {
      const m = mockFetch(() => new Response("", { status: 401 }), text);
      const fb = new FallbackClassifier(new Jev({ fetch: m.f, apiKey: () => "k", backoffMs: 0 }), new ChatClassifier({ model: MODEL, run: m.run }), new ClassifierCache(join(dir, `bad-${bad.indexOf(text)}`)));
      await expect(fb.classify(STATE, Q)).rejects.toThrow(/chat classifier/);
      expect(m.chatCalls()).toBe(3);
    }
    const events = readFileSync(join(dir, "central", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event);
    expect(events.filter((e) => e.event === "chat-unanswerable")).toHaveLength(3);
  });

  test("chat fallback asks for choices only and reads the plain {id: option} answer", async () => {
    const c = new ChatClassifier({ model: MODEL, run: async (_p, parse) => parse('{"surface": "code_api", "breaking": "yes"}') });
    expect(c.prompt(STATE, Q)).not.toMatch(/probabilit/i);
    const r = await c.classify(STATE, Q);
    expect(r.answers.breaking).toEqual({ choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } });
    expect(r.calibrated).toBe(false);
  });

  test("chat fallback: a later attempt's good answer is used; a failed call is a network error", async () => {
    const m = mockFetch(() => new Response("", { status: 401 }), (p, n) => (n === 0 ? "```json\n{}\n```" : chatOk(p)));
    const fb = new FallbackClassifier(new Jev({ fetch: m.f, apiKey: () => "k", backoffMs: 0 }), new ChatClassifier({ model: MODEL, run: m.run }), new ClassifierCache(join(dir, "retry")));
    expect((await fb.classify(STATE, Q)).answers.breaking).toEqual({ choice: "no", confidence: 1, probabilities: { yes: 0, no: 1 } });
    expect(m.chatCalls()).toBe(2);
    const down = new ChatClassifier({ model: MODEL, run: async () => { throw new Error("fetch failed"); } });
    await expect(down.classify(STATE, Q)).rejects.toMatchObject({ kind: "network" });
  });
});

test("attribution distinguishes labels, cross-source matching and bounded deterministic samples without mutating requests", () => {
  const questions = { change_type: Q.breaking! };
  const state = { technology: "React", source: "official documentation change", subject: "a".repeat(500), summary: "b".repeat(1000), evidence: "c".repeat(1000) };
  const original = JSON.stringify(state);
  expect(classifierAttribution(state, questions)).toMatchObject({ stage: "labelling", source: "official documentation change", technology: "React", candidates: 0 });
  expect(classifierAttribution({ technology: "React", incoming: { source: "security advisory" }, candidates: { c1: {}, c2: {} } }, Q)).toMatchObject({ stage: "matching", source: "security advisory", candidates: 2 });
  let sample: Record<string, unknown> | undefined;
  let sampled = 0;
  for (let i = 0; i < 10000; i++) {
    const request = { ...state, release: String(i) };
    const a = classifierAttribution(request, questions);
    if (a.sample) {
      expect(classifierAttribution(request, questions)).toEqual(a);
      sample = a.sample as Record<string, unknown>;
      sampled++;
    }
  }
  expect(sampled).toBeGreaterThan(100);
  expect(sampled).toBeLessThan(220);
  expect(sample).toBeDefined();
  expect(String(sample!.subject).length).toBeLessThanOrEqual(120);
  expect(String(sample!.summary).length).toBeLessThanOrEqual(320);
  expect(String(sample!.evidence).length).toBeLessThanOrEqual(320);
  expect(String(sample!.release).length).toBeLessThanOrEqual(80);
  expect(JSON.stringify(state)).toBe(original);
});

test("matching evidence is attribution-only and never serialized or included in its request hash", () => {
  for (let i = 0; i < 10000; i++) {
    const state = { technology: "React", incoming: { subject: "api", release: String(i) }, candidates: {} };
    const before = classifierAttribution(state, Q);
    if (!before.sample) continue;
    const json = JSON.stringify(state);
    attributeEvidence(state, "source quote");
    expect(classifierAttribution(state, Q)).toMatchObject({ request: before.request, sample: { evidence: "source quote" } });
    expect(JSON.stringify(state)).toBe(json);
    return;
  }
  throw new Error("no sampled matching request");
});
