// SubQ Snap (Subquadratic's decision model) as a step D/E candidate. Its systemone API takes the same body as Jev's
// (state, then questions of type `choice` with criteria) and answers the same way, so it is asked exactly what the
// pipeline's Jev is asked: the same batches (at most 8 questions and 32 KiB of JSON per request), the same answer checks.
// Eval only: the pipeline's classifiers are unchanged. Usage goes to the same log as every other candidate.
import { join } from "node:path";
import { type Answer, type Classification, type Classifier, ClassifierError, type ClassifierName, keyFromEnvFile, type Questions } from "../../central/src/pipeline/classify/adapter.ts";
import { dollars, loadPrices, logUsageLine, OUT_DIR, priceOf, PROVIDERS, type Usage } from "./client.ts";

const MAX_QUESTIONS = 8;
const MAX_BYTES = 32 * 1024;

export const subqStats = { calls: 0, input_tokens: 0, output_tokens: 0, dollars: 0, unpriced_calls: 0 };

export class SubqClassifier implements Classifier {
  readonly name = "subq" as ClassifierName;
  readonly model: string;
  private readonly key: () => string;
  /** `onUsage` takes each call's usage instead of the usage log (a runner with its own meter). */
  private readonly o: { model?: string; step: string; fetch?: typeof fetch; usageLog?: string; onUsage?: (u: Usage, dollars: number | null) => void; retries?: number; backoffMs?: number };
  constructor(o: SubqClassifier["o"]) {
    this.o = o;
    this.model = o.model ?? "subq-snap-preview";
    this.key = keyFromEnvFile(PROVIDERS.subq!.keyFile, PROVIDERS.subq!.keyVar);
  }

  private body(state: Record<string, unknown>, qs: Questions) {
    return {
      model: this.model,
      state,
      questions: Object.fromEntries(Object.entries(qs).map(([id, q]) => [id, { type: "choice", instructions: q.instructions, criteria: q.options }])),
    };
  }

  private batches(state: Record<string, unknown>, questions: Questions): Questions[] {
    const out: Questions[] = [];
    let cur: Questions = {};
    for (const [id, q] of Object.entries(questions)) {
      const next = { ...cur, [id]: q };
      const size = Buffer.byteLength(JSON.stringify(this.body(state, next)));
      if (Object.keys(cur).length && (Object.keys(next).length > MAX_QUESTIONS || size > MAX_BYTES)) {
        out.push(cur);
        cur = { [id]: q };
      } else cur = next;
    }
    if (Object.keys(cur).length) out.push(cur);
    return out;
  }

  private async post(body: unknown): Promise<{ model?: string; answers?: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number } }> {
    const f = this.o.fetch ?? fetch;
    const retries = this.o.retries ?? 3;
    const backoff = (attempt: number) => new Promise((r) => setTimeout(r, (this.o.backoffMs ?? 1000) * 2 ** attempt));
    let key: string;
    try {
      key = this.key();
    } catch (e) {
      throw e instanceof ClassifierError ? e : new ClassifierError("auth", "no SubQ key");
    }
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await f(`${PROVIDERS.subq!.baseUrl}/systemone`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        if (attempt < retries) {
          await backoff(attempt);
          continue;
        }
        throw new ClassifierError("network", String(e));
      }
      if (res.status === 401 || res.status === 403) throw new ClassifierError("auth", `HTTP ${res.status}`);
      if (res.status === 402) throw new ClassifierError("auth", "HTTP 402: no SubQ credits left");
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await backoff(attempt);
        continue;
      }
      if (!res.ok) throw new ClassifierError("http", `HTTP ${res.status}`);
      return (await res.json().catch(() => {
        throw new ClassifierError("malformed", "response is not JSON");
      })) as never;
    }
  }

  async classify(state: Record<string, unknown>, questions: Questions): Promise<Classification> {
    const answers: Record<string, Answer> = {};
    let model = this.model;
    const price = priceOf(loadPrices(), "subq", this.model);
    for (const qs of this.batches(state, questions)) {
      const res = await this.post(this.body(state, qs));
      const u: Usage = { input_tokens: res?.usage?.input_tokens ?? 0, cached_input_tokens: 0, output_tokens: res?.usage?.output_tokens ?? 0, reasoning_tokens: null };
      const d = dollars(price, u);
      subqStats.calls++;
      subqStats.input_tokens += u.input_tokens;
      subqStats.output_tokens += u.output_tokens;
      if (d === null) subqStats.unpriced_calls++;
      else subqStats.dollars += d;
      if (this.o.onUsage) this.o.onUsage(u, d);
      else logUsageLine(this.o.usageLog ?? join(OUT_DIR, "usage.jsonl"), { step: this.o.step, provider: "subq", model, ...(res?.model ? { served_model: res.model } : {}), ...u, dollars: d });
      if (!res || typeof res.answers !== "object" || res.answers === null) throw new ClassifierError("malformed", "no answers");
      for (const [id, q] of Object.entries(qs)) answers[id] = check(id, q.options, res.answers[id]);
      if (typeof res.model === "string") model = res.model;
    }
    return { classifier: this.name, model, answers };
  }
}

/** The pipeline's answer checks (adapter.ts `checkAnswer`, not exported): a choice in the set, a confidence, every probability. */
function check(id: string, options: Record<string, string>, a: unknown): Answer {
  const x = a as Partial<Answer> | undefined;
  if (!x || typeof x.choice !== "string" || !(x.choice in options)) throw new ClassifierError("malformed", `answer ${id}: choice outside the set`);
  if (typeof x.confidence !== "number" || !Number.isFinite(x.confidence)) throw new ClassifierError("malformed", `answer ${id}: no confidence`);
  const probabilities: Record<string, number> = {};
  for (const o of Object.keys(options)) {
    const p = x.probabilities?.[o];
    if (typeof p !== "number" || !Number.isFinite(p)) throw new ClassifierError("malformed", `answer ${id}: no probability for ${o}`);
    probabilities[o] = p;
  }
  return { choice: x.choice, confidence: x.confidence, probabilities };
}
