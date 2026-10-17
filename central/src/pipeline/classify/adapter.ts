// The classifier adapter: one interface, two implementations (Jev, and Codex in place of OpenAI Decisions since
// 15 October 2026), a per-request fallback wrapper and a cache. Swapping or reordering classifiers touches only this
// module (CONTRACT: "Classifier: Jev first, fallback per request"; vault: Relevance Engine, "Classifier for labels
// and ratings").
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonical, logUsage, readJson, sha256, sleep, writeAtomic } from "../util.ts";

/** `openai-decisions` stays a known name: records labelled by it before 15 October 2026 keep it. */
export type ClassifierName = "jev" | "openai-decisions" | "codex";

/** A closed choice: option → description. Yes/no judgements are choices over `yes` and `no`. */
export interface ChoiceQuestion {
  instructions: string;
  options: Record<string, string>;
}
export type Questions = Record<string, ChoiceQuestion>;

export interface Answer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface Classification {
  classifier: ClassifierName;
  model: string;
  answers: Record<string, Answer>;
  /** False when the answers come from a text generator: its probabilities are the choice alone (1 for the chosen
   * option, 0 for the rest), not a calibrated score, so thresholds and probability-gated guards must not trust them. */
  calibrated?: false;
}

export interface Classifier {
  readonly name: ClassifierName;
  readonly model: string;
  classify(state: Record<string, unknown>, questions: Questions): Promise<Classification>;
}

/** Why a classifier call did not produce an answer; any of these sends the request to the fallback. */
export class ClassifierError extends Error {
  readonly kind: "auth" | "http" | "timeout" | "malformed" | "network";
  constructor(kind: ClassifierError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface HttpOptions {
  fetch?: typeof fetch;
  apiKey?: () => string;
  /** Base backoff delay in ms (tests set it to 0). */
  backoffMs?: number;
  timeoutMs?: number;
  retries?: number;
}

export function keyFromEnvFile(file: string, name: string): () => string {
  return () => {
    const fromEnv = process.env[name];
    if (fromEnv) return fromEnv;
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\n]+)`, "m").exec(readFileSync(file, "utf8"));
    if (!m) throw new ClassifierError("auth", `${name} not found in its env file`);
    return m[1]!.trim();
  };
}

export const usageStats: Record<ClassifierName, { calls: number; input_tokens: number; output_tokens: number }> = {
  jev: { calls: 0, input_tokens: 0, output_tokens: 0 },
  "openai-decisions": { calls: 0, input_tokens: 0, output_tokens: 0 },
  codex: { calls: 0, input_tokens: 0, output_tokens: 0 },
};

/** POST with timeout and retries on 429/529/5xx (exponential backoff); 401/403 fail at once. */
async function post(url: string, body: unknown, opts: Required<Omit<HttpOptions, "apiKey">> & { key: string }): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await opts.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (ctrl.signal.aborted) throw new ClassifierError("timeout", `no answer within ${opts.timeoutMs} ms`);
      if (attempt < opts.retries) {
        await sleep(opts.backoffMs * 2 ** attempt);
        continue;
      }
      throw new ClassifierError("network", String(e));
    }
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) throw new ClassifierError("auth", `HTTP ${res.status}`);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < opts.retries) {
        await sleep(opts.backoffMs * 2 ** attempt);
        continue;
      }
      throw new ClassifierError("http", `HTTP ${res.status} after ${opts.retries} retries`);
    }
    if (!res.ok) throw new ClassifierError("http", `HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new ClassifierError("malformed", "response is not JSON");
    }
  }
}

function checkAnswer(id: string, q: ChoiceQuestion, a: unknown): Answer {
  const x = a as Partial<Answer> | undefined;
  if (!x || typeof x.choice !== "string" || !(x.choice in q.options)) throw new ClassifierError("malformed", `answer ${id}: choice outside the set`);
  if (typeof x.confidence !== "number" || !Number.isFinite(x.confidence)) throw new ClassifierError("malformed", `answer ${id}: no confidence`);
  const probabilities: Record<string, number> = {};
  for (const o of Object.keys(q.options)) {
    const p = x.probabilities?.[o];
    if (typeof p !== "number" || !Number.isFinite(p)) throw new ClassifierError("malformed", `answer ${id}: no probability for ${o}`);
    probabilities[o] = p;
  }
  return { choice: x.choice, confidence: x.confidence, probabilities };
}

const JEV_MAX_QUESTIONS = 8;
const JEV_MAX_BYTES = 32 * 1024;

export class Jev implements Classifier {
  readonly name = "jev" as const;
  readonly model: string;
  private readonly opts: Required<Omit<HttpOptions, "apiKey">>;
  private readonly apiKey: () => string;
  constructor(o: HttpOptions & { model?: string } = {}) {
    this.model = o.model ?? "jev-latest";
    this.apiKey = o.apiKey ?? keyFromEnvFile(process.env.UNSTALE_JEV_ENV_FILE ?? join(homedir(), ".config", "ati", "jev.env"), "JEV_API_KEY");
    this.opts = { fetch: o.fetch ?? fetch, backoffMs: o.backoffMs ?? 1000, timeoutMs: o.timeoutMs ?? 30_000, retries: o.retries ?? 3 };
  }

  /** Splits the questions into requests of at most 8 questions and 32 KiB of JSON. */
  batches(state: Record<string, unknown>, questions: Questions): Questions[] {
    const out: Questions[] = [];
    let cur: Questions = {};
    for (const [id, q] of Object.entries(questions)) {
      const next = { ...cur, [id]: q };
      const size = Buffer.byteLength(JSON.stringify(this.body(state, next)));
      if (Object.keys(cur).length && (Object.keys(next).length > JEV_MAX_QUESTIONS || size > JEV_MAX_BYTES)) {
        out.push(cur);
        cur = { [id]: q };
      } else cur = next;
    }
    if (Object.keys(cur).length) out.push(cur);
    return out;
  }

  private body(state: Record<string, unknown>, qs: Questions) {
    return {
      model: this.model,
      state,
      questions: Object.fromEntries(
        Object.entries(qs).map(([id, q]) => [id, { type: "choice", instructions: q.instructions, criteria: q.options }]),
      ),
    };
  }

  async classify(state: Record<string, unknown>, questions: Questions): Promise<Classification> {
    let key: string;
    try {
      key = this.apiKey();
    } catch (e) {
      throw e instanceof ClassifierError ? e : new ClassifierError("auth", "no Jev key");
    }
    const answers: Record<string, Answer> = {};
    let model = this.model;
    for (const qs of this.batches(state, questions)) {
      const res = (await post("https://api.typesafe.ai/v1/systemone", this.body(state, qs), { ...this.opts, key })) as {
        model?: string;
        answers?: Record<string, unknown>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const usage = { input_tokens: res?.usage?.input_tokens ?? 0, output_tokens: res?.usage?.output_tokens ?? 0 };
      usageStats.jev.calls++;
      usageStats.jev.input_tokens += usage.input_tokens;
      usageStats.jev.output_tokens += usage.output_tokens;
      logUsage({ api: "jev", model: res?.model ?? this.model, ...usage });
      if (!res || typeof res.answers !== "object" || res.answers === null) throw new ClassifierError("malformed", "no answers");
      for (const [id, q] of Object.entries(qs)) answers[id] = checkAnswer(id, q, res.answers[id]);
      if (typeof res.model === "string") model = res.model;
    }
    return { classifier: "jev", model, answers };
  }
}

/** Runs one Codex prompt (`codex exec`); the default is the pipeline's Codex runner (codex.ts). */
export type CodexRunner = (prompt: string, model: string) => Promise<{ text: string; code: number | null; usage?: { input_tokens: number; output_tokens: number; cached_input_tokens: number } }>;

const CODEX_PROMPT = `You answer closed-choice questions about a record. Read the state and answer every question by picking
exactly one of its options.

Output only a JSON object, no prose: {"<question id>": "<option>", ...}

State:
%STATE%

Questions:
%QUESTIONS%
`;

/**
 * The fallback classifier: Codex (`codex exec`, gpt-5.6-luna) asked for one option per question, nothing else. A text
 * generator's stated probabilities are not scores: re-scored on choices alone, every chat model's "p >= 0.5" equalled
 * its choice, and thresholds fitted on its numbers only traded precision away (eval/select/slice4/RESULTS-choice.md).
 * So the answer is the choice, given as probability 1 (0 for the other options), and the classification is marked
 * `calibrated: false`: the judge then lets a "yes" merge only where its deterministic guards agree (match.ts pick).
 * Replaces the OpenAI Decisions adapter (user rule, 15 October 2026: Luna only through Codex). An unparseable or incomplete answer is retried once, then
 * is unanswerable: a `malformed` ClassifierError, recorded in the usage log. Caching is the FallbackClassifier's
 * (by request hash); every real call is logged as api "codex".
 */
export class CodexClassifier implements Classifier {
  readonly name = "codex" as const;
  readonly model: string;
  private readonly run: CodexRunner;
  constructor(o: { model?: string; run?: CodexRunner } = {}) {
    this.model = o.model ?? "gpt-5.6-luna";
    this.run = o.run ?? (async (prompt, model) => (await import("../codex.ts")).runCodex(prompt, model));
  }

  prompt(state: Record<string, unknown>, questions: Questions): string {
    const qs = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { instructions: q.instructions, options: q.options }]));
    return CODEX_PROMPT.replace("%STATE%", canonical(state)).replace("%QUESTIONS%", JSON.stringify(qs, null, 1));
  }

  async classify(state: Record<string, unknown>, questions: Questions): Promise<Classification> {
    const prompt = this.prompt(state, questions);
    let last = "no answer";
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.run(prompt, this.model);
      if (r.usage) {
        usageStats.codex.calls++;
        usageStats.codex.input_tokens += r.usage.input_tokens;
        usageStats.codex.output_tokens += r.usage.output_tokens;
        logUsage({ api: "codex", model: this.model, purpose: "classifier", ...r.usage });
      }
      if (r.code !== 0) {
        last = `codex exited ${r.code}`;
        continue;
      }
      try {
        const m = /\{[\s\S]*\}/.exec(r.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        const raw = (m ? JSON.parse(m[0]) : undefined) as Record<string, unknown> | undefined;
        if (!raw || typeof raw !== "object") throw new ClassifierError("malformed", "no JSON object");
        const answers: Record<string, Answer> = {};
        for (const [id, q] of Object.entries(questions)) {
          const v = raw[id];
          const choice = typeof v === "string" ? v : typeof (v as { choice?: unknown } | undefined)?.choice === "string" ? (v as { choice: string }).choice : undefined;
          const probabilities = Object.fromEntries(Object.keys(q.options).map((o) => [o, o === choice ? 1 : 0]));
          answers[id] = checkAnswer(id, q, choice === undefined ? undefined : { choice, confidence: 1, probabilities });
        }
        return { classifier: "codex", model: this.model, answers, calibrated: false };
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    logUsage({ event: "codex-unanswerable", reason: last });
    throw new ClassifierError("malformed", `codex: ${last}`);
  }
}

/** Caches answers on disk by a hash of the full request (classifier + model + state + questions). */
export class ClassifierCache {
  hits = 0;
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  key(c: Classifier, state: Record<string, unknown>, questions: Questions): string {
    return sha256(canonical({ classifier: c.name, model: c.model, state, questions }));
  }
  private path(k: string): string {
    return join(this.dir, k.slice(0, 2), `${k}.json`);
  }
  get(c: Classifier, state: Record<string, unknown>, questions: Questions): Classification | undefined {
    return readJson<Classification>(this.path(this.key(c, state, questions)));
  }
  put(c: Classifier, state: Record<string, unknown>, questions: Questions, v: Classification): void {
    writeAtomic(this.path(this.key(c, state, questions)), JSON.stringify(v) + "\n");
  }
}

export interface FallbackEvents {
  fallback?: (err: ClassifierError) => void;
  disabled?: () => void;
}

/**
 * Primary first, fallback per request. A cached answer from either classifier is used without a call, so a rerun
 * makes no uncached calls. After `maxConsecutive` consecutive fallbacks the primary is not called again this run.
 */
export class FallbackClassifier {
  consecutive = 0;
  disabled = false;
  readonly counts: Record<ClassifierName, number> = { jev: 0, "openai-decisions": 0, codex: 0 };
  fallbacks = 0;
  private readonly primary: Classifier;
  private readonly fallback: Classifier;
  private readonly cache: ClassifierCache;
  private readonly events: FallbackEvents;
  private readonly maxConsecutive: number;
  constructor(primary: Classifier, fallback: Classifier, cache: ClassifierCache, events: FallbackEvents = {}, maxConsecutive = 10) {
    this.primary = primary;
    this.fallback = fallback;
    this.cache = cache;
    this.events = events;
    this.maxConsecutive = maxConsecutive;
  }

  cacheHits(): number {
    return this.cache.hits;
  }

  async classify(state: Record<string, unknown>, questions: Questions): Promise<Classification> {
    const hit = this.cache.get(this.primary, state, questions) ?? this.cache.get(this.fallback, state, questions);
    if (hit) {
      this.cache.hits++;
      this.counts[hit.classifier]++;
      return hit;
    }
    if (!this.disabled) {
      try {
        const r = await this.primary.classify(state, questions);
        this.consecutive = 0;
        this.cache.put(this.primary, state, questions, r);
        this.counts[r.classifier]++;
        return r;
      } catch (e) {
        if (!(e instanceof ClassifierError)) throw e;
        this.fallbacks++;
        this.events.fallback?.(e);
        if (++this.consecutive >= this.maxConsecutive && !this.disabled) {
          this.disabled = true;
          console.error(`\n*** ${this.primary.name} DISABLED for the rest of this run after ${this.consecutive} consecutive fallbacks (last: ${e.kind}: ${e.message}) ***\n`);
          logUsage({ event: `${this.primary.name}-disabled`, reason: `${e.kind}: ${e.message}` });
          this.events.disabled?.();
        }
      }
    }
    const r = await this.fallback.classify(state, questions);
    this.cache.put(this.fallback, state, questions, r);
    this.counts[r.classifier]++;
    return r;
  }
}
