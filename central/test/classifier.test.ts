// The classifier adapter: Jev first, Codex per-request fallback (CONTRACT: "Classifier"; Codex since 15 October 2026).
// fetch (Jev) and the Codex runner (the `codex exec` subprocess) are mocked.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { ClassifierCache, CodexClassifier, FallbackClassifier, Jev, type CodexRunner, type Questions } from "../src/pipeline/classify/adapter.ts";

const Q: Questions = {
  breaking: { instructions: "Breaking?", options: { yes: "Breaking.", no: "Not breaking." } },
  surface: { instructions: "Where?", options: { code_api: "Code.", configuration: "Config." } },
};
const STATE = { subject: "images.minimumCacheTTL", summary: "Default raised to 4 hours." };

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
/** A Codex answer as the prompt asks for it: the second option chosen at 0.7 for every question in the prompt. */
function codexOk(prompt: string): string {
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

/** A fetch (Jev) and a Codex runner that record calls; `jev` decides Jev's response per call. */
function mockFetch(jev: (body: never, n: number) => Response | Promise<Response>, codexText: (prompt: string, n: number) => string = codexOk) {
  const calls: Call[] = [];
  let n = 0;
  let k = 0;
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as never;
    calls.push({ url, body });
    return jev(body, n++);
  }) as unknown as typeof fetch;
  const run: CodexRunner = async (prompt, model) => {
    calls.push({ url: `codex:${model}`, body: { prompt } });
    return { text: codexText(prompt, k++), code: 0, usage: { input_tokens: 50, output_tokens: 5, cached_input_tokens: 0 } };
  };
  return { f, run, calls, jevCalls: () => calls.filter((c) => c.url.includes("typesafe")).length, codexCalls: () => calls.filter((c) => c.url.startsWith("codex:")).length };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-cls-"));
  process.env.UNSTALE_STORE = dir;
});

function make(jev: (body: never, n: number) => Response | Promise<Response>, timeoutMs = 30_000) {
  const m = mockFetch(jev);
  const opts = { fetch: m.f, apiKey: () => "test-key", backoffMs: 0 };
  const fb = new FallbackClassifier(new Jev({ ...opts, timeoutMs }), new CodexClassifier({ run: m.run }), new ClassifierCache(join(dir, "cache")));
  return { m, fb };
}

describe("classifier adapter", () => {
  test("Jev answers: probabilities, confidence and the reported model are returned", async () => {
    const { m, fb } = make((b) => Response.json(jevOk(b)));
    const r = await fb.classify(STATE, Q);
    expect(r.classifier).toBe("jev");
    expect(r.model).toBe("jev-1.13.0");
    expect(r.answers.breaking).toEqual({ choice: "yes", confidence: 0.8, probabilities: { yes: 0.9, no: 0.1 } });
    expect(m.codexCalls()).toBe(0);
  });

  test("falls back on 401 without retrying Jev", async () => {
    const { m, fb } = make(() => new Response("no", { status: 401 }));
    const r = await fb.classify(STATE, Q);
    expect(r.classifier).toBe("codex");
    expect(r.answers.surface!.choice).toBe("configuration");
    // A text generator's answer is its choice alone: probability 1 for it, 0 for the rest, marked uncalibrated.
    expect(r.answers.surface).toEqual({ choice: "configuration", confidence: 1, probabilities: { code_api: 0, configuration: 1 } });
    expect(r.calibrated).toBe(false);
    expect(r.model).toBe("gpt-5.6-luna");
    expect([m.jevCalls(), m.codexCalls()]).toEqual([1, 1]);
  });

  test("retries 5xx three times, then falls back", async () => {
    const { m, fb } = make(() => new Response("busy", { status: 503 }));
    const r = await fb.classify(STATE, Q);
    expect(r.classifier).toBe("codex");
    expect(m.jevCalls()).toBe(4);
  });

  test("a 529 that recovers within the retries stays on Jev", async () => {
    const { m, fb } = make((b, n) => (n < 2 ? new Response("", { status: 529 }) : Response.json(jevOk(b))));
    expect((await fb.classify(STATE, Q)).classifier).toBe("jev");
    expect([m.jevCalls(), m.codexCalls()]).toEqual([3, 0]);
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
    const fb = new FallbackClassifier(new Jev({ ...opts, timeoutMs: 30 }), new CodexClassifier({ run: m.run }), new ClassifierCache(join(dir, "c")));
    expect((await fb.classify(STATE, Q)).classifier).toBe("codex");
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
      expect((await fb.classify(STATE, Q)).classifier).toBe("codex");
    }
  });

  test("Jev is disabled after ten consecutive fallbacks, and the event is logged", async () => {
    const { m, fb } = make(() => new Response("", { status: 401 }));
    for (let i = 0; i < 12; i++) await fb.classify({ ...STATE, i }, Q);
    expect(m.jevCalls()).toBe(10);
    expect(m.codexCalls()).toBe(12);
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
      new CodexClassifier({ run: again.m.run }),
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
    expect(log[0]).toMatchObject({ api: "jev", model: "jev-1.13.0", input_tokens: 100, output_tokens: 10 });
  });

  test("Codex fallback: usage is logged as api codex; a malformed answer is retried once, then unanswerable and recorded", async () => {
    const ok = make(() => new Response("", { status: 401 }));
    await ok.fb.classify(STATE, Q);
    const log = readFileSync(join(dir, "central", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.find((l) => l.api === "codex")).toMatchObject({ api: "codex", model: "gpt-5.6-luna", purpose: "classifier", input_tokens: 50 });

    const bad = [
      () => "not json",
      (p: string) => codexOk(p).replace('"configuration"', '"elsewhere"'),
      (p: string) => JSON.stringify({ breaking: JSON.parse(codexOk(p)).breaking }),
    ];
    for (const text of bad) {
      const m = mockFetch(() => new Response("", { status: 401 }), text);
      const fb = new FallbackClassifier(new Jev({ fetch: m.f, apiKey: () => "k", backoffMs: 0 }), new CodexClassifier({ run: m.run }), new ClassifierCache(join(dir, `bad-${bad.indexOf(text)}`)));
      await expect(fb.classify(STATE, Q)).rejects.toThrow(/codex/);
      expect(m.codexCalls()).toBe(2);
    }
    const events = readFileSync(join(dir, "central", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event);
    expect(events.filter((e) => e.event === "codex-unanswerable")).toHaveLength(3);
  });

  test("Codex fallback asks for choices only and reads the plain {id: option} answer", async () => {
    const c = new CodexClassifier({ run: async () => ({ text: '{"surface": "code_api", "breaking": "yes"}', code: 0 }) });
    expect(c.prompt(STATE, Q)).not.toMatch(/probabilit/i);
    const r = await c.classify(STATE, Q);
    expect(r.answers.breaking).toEqual({ choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } });
    expect(r.calibrated).toBe(false);
  });

  test("Codex fallback: the second attempt's good answer is used", async () => {
    const m = mockFetch(() => new Response("", { status: 401 }), (p, n) => (n === 0 ? "```json\n{}\n```" : codexOk(p)));
    const fb = new FallbackClassifier(new Jev({ fetch: m.f, apiKey: () => "k", backoffMs: 0 }), new CodexClassifier({ run: m.run }), new ClassifierCache(join(dir, "retry")));
    expect((await fb.classify(STATE, Q)).answers.breaking).toEqual({ choice: "no", confidence: 1, probabilities: { yes: 0, no: 1 } });
    expect(m.codexCalls()).toBe(2);
  });
});
