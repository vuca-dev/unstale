// The model requests central builds, byte for byte, for a fixed set of states: both extraction calls and their
// variants, every label question, the judge in each of its rule forms, the choice fallback and the advisory APIs
// read. Each request is captured at the HTTP boundary (the model endpoints are stubbed; llm.ts and adapter.ts are
// real) with the cache key it is stored under. The Jev and extraction caches are keyed on these bytes, so any change
// to a prompt, question or rubric empties a cache: when this test fails, the change was not meant to be silent.
// Regenerate on purpose with UNSTALE_UPDATE_PROMPT_SNAPSHOT=1.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { renderChange } from "../src/docs/render.ts";
import type { SectionChange } from "../src/collector/sections.ts";
import { advisoryApis } from "../src/pipeline/advisory-apis.ts";
import type { Advisory } from "../src/pipeline/advisories.ts";
import { ChatClassifier, ClassifierCache, Jev, type Classifier, type Questions } from "../src/pipeline/classify/adapter.ts";
import { labelQuestions, recordState, type Labels } from "../src/pipeline/classify/labels.ts";
import { extractCacheKey, extractLlm } from "../src/pipeline/llm.ts";
import { extractRelease, type Incoming } from "../src/pipeline/extract.ts";
import { create, matchRequest } from "../src/pipeline/match.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";
import { TECHNOLOGIES } from "../src/pipeline/technologies.ts";

const SNAPSHOT = new URL("./fixtures/prompt-requests.json", import.meta.url);
const UPDATE = process.env.UNSTALE_UPDATE_PROMPT_SNAPSHOT === "1";

const OWN = ["UNSTALE_CENTRAL_DIR", "AI_GATEWAY_API_KEY", "UNSTALE_EXTRACT_MODEL", "UNSTALE_EXTRACT_EFFORT", "UNSTALE_EXTRACT_SERVICE_TIER", "UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET"];
const prev = { ...process.env };
beforeAll(() => {
  for (const k of OWN) delete process.env[k];
  process.env.AI_GATEWAY_API_KEY = "test-key";
  process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
});
// A fresh cache per state, so every request reaches the stub.
beforeEach(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-prompt-snapshot-"));
  for (const k of ["UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET"]) delete process.env[k];
});
afterEach(() => vi.unstubAllGlobals());

interface Captured {
  /** The request body as sent. */
  body: unknown;
  /** The cache key its answer is stored under. */
  key: string;
}
const captured: Record<string, Captured[]> = {};

afterAll(() => {
  for (const k of OWN) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  if (UPDATE) writeFileSync(SNAPSHOT, JSON.stringify(captured, null, 1) + "\n");
});

const expected = (): Record<string, Captured[]> => (UPDATE ? {} : (JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, Captured[]>));

function record(name: string, got: Captured[]): void {
  // Calls made concurrently (chunks of one release) are put in a stable order.
  const sorted = [...got].sort((a, b) => a.key.localeCompare(b.key));
  captured[name] = sorted;
  if (!UPDATE) expect(sorted, name).toEqual(expected()[name]);
}

// ---- Extraction: a stubbed chat-completions endpoint that answers each call with a fixed, parseable answer. ----

const RECORDS = [
  { subject: "after", subject_kind: "literal", facet: null, change_type: "new_api", surface: "code_api", summary: "after() runs work once a response finishes.", audience: "application", introduces: ["after"], evidence: "Adds `after`" },
  { subject: "images.minimumCacheTTL", subject_kind: "literal", facet: null, change_type: "default_change", surface: "configuration", summary: "The default minimum cache TTL is now four hours.", audience: "application", introduces: [], evidence: "minimumCacheTTL default is now 4 hours" },
];

function answerFor(prompt: string): string {
  if (prompt.startsWith("You write search terms")) return JSON.stringify({ r1: { terms: ["after"], replaces: [], requires: [], prerequisites: [], conditions: [] } });
  if (prompt.startsWith("You extract change records from official release notes, then label them")) return JSON.stringify({ records: [{ id: "r1", ...RECORDS[0] }], labels: [{ id: "r1", terms: ["after"], replaces: [], requires: [], prerequisites: [], conditions: [] }] });
  if (prompt.includes("each line starts with its number")) return JSON.stringify(RECORDS.map((r) => ({ ...r, evidence: [1] })));
  return JSON.stringify(RECORDS);
}

function stubChat(): Captured[] {
  const got: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: Array<{ content: string }>; max_tokens: number; response_format?: unknown };
      const prompt = body.messages[0]!.content;
      got.push({ body, key: extractCacheKey(prompt, { ...(body.response_format ? { responseFormat: body.response_format } : {}), maxTokens: body.max_tokens }) });
      return new Response(JSON.stringify({ choices: [{ message: { content: answerFor(prompt) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    }),
  );
  return got;
}

const NOTES = "## Features\n\n- Adds `after` to run work once a response finishes.\n- `images.minimumCacheTTL` default is now 4 hours.\n\n## Breaking\n\n- Node.js 18 is no longer supported; Node.js 20.9 is required.";
const rel = (version: string, notes: string, over: Record<string, unknown> = {}) => ({ technology: "next", tag: `v${version}`, version, date: "2026-08-21", url: `https://github.com/vercel/next.js/releases/tag/v${version}`, snapshot: `sha256:${version}`, notes, ...over });
// A release body over MAX_CHUNK: extracted in parts, each prompt naming its part.
const LONG = Array.from({ length: 470 }, (_, i) => `- Fix \`route${i}\` handling of trailing slashes in nested segments.`).join("\n");
const DOCS = renderChange("https://nextjs.org/docs/app/api-reference/config/next-config-js/images", "docs", [
  { path: ["Images", "minimumCacheTTL"], status: "changed" as SectionChange["status"], hunks: "@@ -1,2 +1,2 @@\n The minimum cache TTL.\n-Default: 60 seconds.\n+Default: 4 hours.", added: 1, removed: 1 },
]);
const DOCS_MARKED = renderChange("https://nextjs.org/docs/app/api-reference/config/next-config-js/images", "docs", [
  { path: ["Images", "minimumCacheTTL"], status: "changed" as SectionChange["status"], hunks: "@@ -1,2 +1,2 @@\n The minimum cache TTL.\n-Default: 60 seconds.\n+Default: 4 hours.", added: 1, removed: 1 },
], { words: true });

const next = TECHNOLOGIES.next!;

describe("extraction requests", () => {
  const cases: Array<[string, Record<string, string>, ReturnType<typeof rel>]> = [
    ["extract.two-call.release-notes", {}, rel("16.3.2", NOTES)],
    ["extract.two-call.note-date", {}, rel("16.3.3", NOTES, { noteDate: "2026-08-20" })],
    ["extract.two-call.multi-part", {}, rel("16.4.0", LONG)],
    ["extract.two-call.upgrade-guide", {}, rel("16.0.0", NOTES, { kind: "upgrade_guide", keyTag: "+guide.0123abcd" })],
    ["extract.two-call.docs", {}, rel("16.3.2", DOCS, { kind: "docs", keyTag: "+docs.0123abcd" })],
    ["extract.two-call.docs-marked", {}, rel("16.3.2", DOCS_MARKED, { kind: "docs", keyTag: "+docs.4567abcd" })],
    ["extract.one-call", { UNSTALE_EXTRACT_STRUCTURE: "one-call" }, rel("16.3.2", NOTES)],
    ["extract.one-call-schema", { UNSTALE_EXTRACT_STRUCTURE: "one-call-schema" }, rel("16.3.2", NOTES)],
    ["extract.evidence-ids", { UNSTALE_EXTRACT_EVIDENCE: "ids" }, rel("16.3.2", NOTES)],
    ["extract.diet-full", { UNSTALE_EXTRACT_DIET: "1" }, rel("16.3.2", NOTES)],
    ["extract.diet-compact", { UNSTALE_EXTRACT_DIET: "compact" }, rel("16.3.2", NOTES)],
  ];
  for (const [name, env, r] of cases) {
    test(name, async () => {
      Object.assign(process.env, env);
      const got = stubChat();
      const out = await extractRelease(next, r as Parameters<typeof extractRelease>[1]);
      expect(out.failed).toBe(0);
      expect(got.length).toBeGreaterThan(0);
      record(name, got);
    });
  }
});

// ---- Classifier: Jev's request bodies (the stub answers every question) and its cache keys. ----

function stubJev(): { jev: Jev; got: unknown[] } {
  const got: unknown[] = [];
  const f = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { questions: Record<string, { criteria: Record<string, string> }> };
    got.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, q]) => {
        const opts = Object.keys(q.criteria);
        return [id, { choice: opts[0], confidence: 0.9, probabilities: Object.fromEntries(opts.map((o) => [o, 1 / opts.length])) }];
      }),
    );
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  });
  return { jev: new Jev({ fetch: f as unknown as typeof fetch, apiKey: () => "test-key", backoffMs: 0 }), got };
}

const cacheKey = (c: Pick<Classifier, "name" | "model">, state: Record<string, unknown>, questions: Questions) => new ClassifierCache(mkdtempSync(join(tmpdir(), "unstale-cls-"))).key(c as Classifier, state, questions);

async function classifierRequests(state: Record<string, unknown>, questions: Questions): Promise<Captured[]> {
  const { jev, got } = stubJev();
  await jev.classify(state, questions);
  const key = cacheKey({ name: "jev", model: "jev-latest" }, state, questions);
  return got.map((body) => ({ body, key }));
}

function incoming(over: Partial<Incoming> & { key: string }): Incoming {
  return {
    technology: "next",
    version: "16.3.2",
    date: "2026-08-21",
    line: "16",
    url: "https://github.com/vercel/next.js/releases/tag/v16.3.2",
    snapshot: "sha256:aaa",
    subject: "images.minimumCacheTTL",
    subject_kind: "literal",
    summary: "The default minimum cache TTL for optimized images is now four hours.",
    introduces: [],
    quote: "minimumCacheTTL default is now 4 hours",
    grounded: true,
    terms: ["images", "minimumCacheTTL"],
    replaces: [],
    requires: [],
    prerequisites: [],
    conditions: [],
    ...over,
  };
}

const labelsOf = (over: Partial<Labels> = {}): Labels => ({
  change_type: "default_change",
  surface: "configuration",
  breaking: false,
  benefit: ["none"],
  classifier: { classifier: "jev", model: "jev-test", change_type: 0.9, surface: 0.9, breaking: 0.1, benefit: [], borderline: [] },
  ...over,
});

describe("label requests", () => {
  const cases: Array<[string, Incoming]> = [
    ["labels.release-notes", incoming({ key: "next@16.3.2#0.0" })],
    ["labels.facet-section", incoming({ key: "next@16.3.2#0.1", subject: "next build", facet: "--turbopack", section: "CLI", introduces: ["--turbopack"], replaces: ["--turbo"] })],
    ["labels.upgrade-guide", incoming({ key: "next@16.0.0+guide.0123abcd#0.0", kind: "upgrade_guide", version: "16.0.0", subject: "middleware.ts", replaces: ["middleware.ts"], introduces: ["proxy.ts"], quote: "Rename middleware.ts to proxy.ts" })],
    ["labels.docs", incoming({ key: "next@16.3.2+docs.0123abcd#0.0", kind: "docs" })],
  ];
  for (const [name, inc] of cases) {
    test(name, async () => {
      record(name, await classifierRequests(recordState("Next.js", inc), labelQuestions()));
    });
  }
});

function stored(s: TechStore, over: Partial<Incoming> & { key: string }, kind?: StoredRecord["evidence"][number]["kind"]): StoredRecord {
  const r = create(s, incoming(over), labelsOf(), ["pkg:npm/next"]);
  if (kind) r.evidence = r.evidence.map((e) => ({ ...e, kind }));
  return r;
}

describe("judge requests", () => {
  const store = (): TechStore => ({ technology: "next", records: {}, ingested: {} });
  const cases: Array<[string, () => ReturnType<typeof matchRequest>]> = [
    [
      "judge.release-notes.short-rules-floor",
      () => {
        const s = store();
        const a = stored(s, { key: "next@16.3.1#0.0", version: "16.3.1", snapshot: "sha256:b1" });
        const b = stored(s, { key: "next@16.3.1#0.1", version: "16.3.1", snapshot: "sha256:b1", subject: "images.qualities" });
        return matchRequest("Next.js", incoming({ key: "next@16.3.2#0.0" }), false, [a, b], [1.9, 0.2]);
      },
    ],
    [
      "judge.release-notes.short-rules-all",
      () => {
        const s = store();
        const a = stored(s, { key: "next@16.3.1#0.0", version: "16.3.1", snapshot: "sha256:b1" });
        return matchRequest("Next.js", incoming({ key: "next@16.3.2#0.0", facet: "minimumCacheTTL", subject: "images" }), true, [a]);
      },
    ],
    [
      "judge.guide-vs-release-notes",
      () => {
        const s = store();
        const a = stored(s, { key: "next@16.0.0#0.0", version: "16.0.0", snapshot: "sha256:c1" });
        return matchRequest("Next.js", incoming({ key: "next@16.0.0+guide.0123abcd#0.0", version: "16.0.0", kind: "upgrade_guide" }), false, [a], [1.5]);
      },
    ],
    [
      "judge.guide-lineage",
      () => {
        const s = store();
        const a = stored(s, { key: "next@16.0.0+guide.aaaaaaaa#0.0", version: "16.0.0", snapshot: "sha256:d1", kind: "upgrade_guide" }, "upgrade_guide");
        return matchRequest("Next.js", incoming({ key: "next@16.0.0+guide.bbbbbbbb#0.0", version: "16.0.0", kind: "upgrade_guide", snapshot: "sha256:d2" }), false, [a]);
      },
    ],
    [
      "judge.docs",
      () => {
        const s = store();
        const a = stored(s, { key: "next@16.3.1#0.0", version: "16.3.1", snapshot: "sha256:e1" });
        return matchRequest("Next.js", incoming({ key: "next@16.3.2+docs.0123abcd#0.0", kind: "docs" }), false, [a]);
      },
    ],
    [
      "judge.advisory",
      () => {
        const s = store();
        const a = stored(s, { key: "next@16.3.1#0.0", version: "16.3.1", snapshot: "sha256:f1", subject: "middleware", quote: "Fix authorization bypass in middleware (GHSA-f82v-jwr5-mffw)" });
        const adv = { ...incoming({ key: "next@16.3.1+advisory.GHSA-f82v-jwr5-mffw#0.0", subject: "middleware", quote: "Authorization bypass in Next.js middleware" }), kind: "advisory" } as unknown as Incoming;
        return matchRequest("Next.js", adv, false, [a]);
      },
    ],
  ];
  for (const [name, build] of cases) {
    test(name, async () => {
      const { state, questions } = build();
      expect(Object.keys(questions).length).toBeGreaterThan(0);
      record(name, await classifierRequests(state, questions));
    });
  }
});

// ---- The choice fallback (the extraction model answering a classifier request) and the advisory APIs read. ----

describe("extraction-model requests outside extraction", () => {
  test("choice-fallback.labels", async () => {
    const got = stubChat();
    const state = recordState("Next.js", incoming({ key: "next@16.3.2#0.0" }));
    const qs = labelQuestions();
    const runner = (prompt: string, parse: (t: string) => Record<string, string> | undefined) =>
      extractLlm(prompt, () => parse(JSON.stringify(Object.fromEntries(Object.entries(qs).map(([id, q]) => [id, Object.keys(q.options)[0]!])))));
    await new ChatClassifier({ model: "openai/gpt-6-luna", run: runner }).classify(state, qs);
    record("choice-fallback.labels", got);
  });
  test("choice-fallback.judge", async () => {
    const got = stubChat();
    const s: TechStore = { technology: "next", records: {}, ingested: {} };
    const a = stored(s, { key: "next@16.3.1#0.0", version: "16.3.1", snapshot: "sha256:b1" });
    const { state, questions } = matchRequest("Next.js", incoming({ key: "next@16.3.2#0.0" }), false, [a], [1.9]);
    const runner = (prompt: string, parse: (t: string) => Record<string, string> | undefined) => extractLlm(prompt, () => parse(JSON.stringify({ same_c1: "no" })));
    await new ChatClassifier({ model: "openai/gpt-6-luna", run: runner }).classify(state, questions);
    record("choice-fallback.judge", got);
  });
  test("advisory-apis", async () => {
    const got = stubChat();
    const a = { id: "GHSA-f82v-jwr5-mffw", aliases: ["CVE-2025-29927"], summary: "Authorization bypass in Next.js middleware", details: "A request header `x-middleware-subrequest` lets a request skip `middleware`." } as unknown as Advisory;
    await advisoryApis(a, ["next"]);
    record("advisory-apis", got);
  });
});
