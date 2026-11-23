// OpenAI's decision model (`POST https://api.openai.com/v1/decisions`, model gpt-6-luna) as a step D/E candidate, for a
// user whose only key is OpenAI's. The request shape is the one central's adapter used before 15 October 2026
// (commit 8ad49a7, `OpenAIDecisions`): the state as one canonical JSON string in `input`, the questions as an array of
// `{type: "choice", name, instructions, choices: [{value, description}]}`. It answers per question with a choice, a
// confidence and a probability per option, so the pipeline's answer checks apply unchanged. Output is free; usage goes
// to the caller's meter. Eval only: the pipeline's classifiers are unchanged.
import { type Answer, type Classification, type Classifier, ClassifierError, type ClassifierName, keyFromEnvFile, type Questions } from "../../central/src/pipeline/classify/adapter.ts";
import { canonical } from "../../central/src/pipeline/util.ts";
import { PROVIDERS, type Usage } from "../select/client.ts";

export const DECISIONS_PRICE = { input: 0.1, cached_input: null, output: 0 } as const;
export const decisionsStats = { calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, dollars: 0 };

export class DecisionsClassifier implements Classifier {
  // Cache keys and run ids name it; "openai-decisions" is the adapter's own historical name.
  readonly name = "openai-decisions" as ClassifierName;
  readonly model: string;
  private readonly key = keyFromEnvFile(PROVIDERS.openai!.keyFile, PROVIDERS.openai!.keyVar);
  constructor(private readonly o: { model?: string; onUsage: (u: Usage, dollars: number) => void; retries?: number; backoffMs?: number }) {
    this.model = o.model ?? "gpt-6-luna";
  }

  body(state: Record<string, unknown>, qs: Questions) {
    return {
      model: this.model,
      input: canonical(state),
      questions: Object.entries(qs).map(([name, q]) => ({ type: "choice", name, instructions: q.instructions, choices: Object.entries(q.options).map(([value, description]) => ({ value, description })) })),
    };
  }

  private async post(body: unknown): Promise<{ model?: string; answers?: Array<{ name?: string; choice?: string; confidence?: number; probabilities?: Array<{ value: string; probability: number }> }>; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }> {
    const retries = this.o.retries ?? 4;
    const wait = (n: number) => new Promise((r) => setTimeout(r, (this.o.backoffMs ?? 2000) * 2 ** n));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch("https://api.openai.com/v1/decisions", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.key()}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        if (attempt < retries) { await wait(attempt); continue; }
        throw new ClassifierError("network", String(e));
      }
      if (res.status === 401 || res.status === 403) throw new ClassifierError("auth", `HTTP ${res.status}`);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) { await wait(attempt); continue; }
      if (!res.ok) throw new ClassifierError("http", `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json().catch(() => { throw new ClassifierError("malformed", "response is not JSON"); })) as never;
    }
  }

  async classify(state: Record<string, unknown>, questions: Questions): Promise<Classification> {
    const res = await this.post(this.body(state, questions));
    const cached = res?.usage?.input_tokens_details?.cached_tokens ?? 0;
    const u: Usage = { input_tokens: res?.usage?.input_tokens ?? 0, cached_input_tokens: cached, output_tokens: res?.usage?.output_tokens ?? 0, reasoning_tokens: null };
    // Cached input is billed at the input price (no cached price is published): an upper bound.
    const d = (u.input_tokens * DECISIONS_PRICE.input) / 1e6;
    decisionsStats.calls++;
    decisionsStats.input_tokens += u.input_tokens;
    decisionsStats.cached_input_tokens += cached;
    decisionsStats.output_tokens += u.output_tokens;
    decisionsStats.dollars += d;
    this.o.onUsage(u, d);
    if (!res || !Array.isArray(res.answers)) throw new ClassifierError("malformed", "no answers");
    const byName = new Map(res.answers.map((a) => [a.name, a]));
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const a = byName.get(id);
      const probabilities: Record<string, number> = {};
      for (const o of Object.keys(q.options)) {
        const p = a?.probabilities?.find((x) => x.value === o)?.probability;
        if (typeof p !== "number" || !Number.isFinite(p)) throw new ClassifierError("malformed", `answer ${id}: no probability for ${o}`);
        probabilities[o] = p;
      }
      if (!a || typeof a.choice !== "string" || !(a.choice in q.options)) throw new ClassifierError("malformed", `answer ${id}: choice outside the set`);
      answers[id] = { choice: a.choice, confidence: typeof a.confidence === "number" ? a.confidence : probabilities[a.choice]!, probabilities };
    }
    return { classifier: this.name, model: res.model ?? this.model, answers };
  }
}
