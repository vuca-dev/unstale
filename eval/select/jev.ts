// The classifier candidates for steps D and E behind the adapter's own interface, so every candidate is asked the same
// state and questions and costed in the same usage log as the chat client:
// - Jev: the pipeline's `Jev` (its own HTTP, batching and answer checks) with a fetch that copies each response's usage
//   into eval/select/out/usage.jsonl. Jev's own logUsage writes to $UNSTALE_CENTRAL_DIR, which run.mts points at
//   eval/select/out/central so the store is never written.
// - A generative model: the pipeline's ChatClassifier prompt and parser (the chat fallback), run through ChatClient.
import { join } from "node:path";
import { ChatClassifier, Jev, type ChatRunner, type Classifier, type HttpOptions } from "../../central/src/pipeline/classify/adapter.ts";
import { dollars, loadPrices, logUsageLine, OUT_DIR, priceOf, type ChatClient, type Price, type Usage } from "./client.ts";

export interface JevOptions {
  model?: string;
  step: string;
  fetch?: typeof fetch;
  apiKey?: () => string;
  backoffMs?: number;
  usageLog?: string;
  prices?: Price[];
}

export const jevStats = { calls: 0, input_tokens: 0, output_tokens: 0, dollars: 0, unpriced_calls: 0 };

export function jevClassifier(o: JevOptions): Classifier {
  const model = o.model ?? "jev-latest";
  const base = o.fetch ?? fetch;
  const prices = o.prices ?? loadPrices();
  const log = o.usageLog ?? join(OUT_DIR, "usage.jsonl");
  const wrapped: typeof fetch = async (url, init) => {
    const res = await base(url, init);
    if (res.ok) {
      const j = (await res.clone().json().catch(() => undefined)) as { model?: string; usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
      const u: Usage = { input_tokens: j?.usage?.input_tokens ?? 0, cached_input_tokens: 0, output_tokens: j?.usage?.output_tokens ?? 0, reasoning_tokens: null };
      const d = dollars(priceOf(prices, "jev", model), u);
      jevStats.calls++;
      jevStats.input_tokens += u.input_tokens;
      jevStats.output_tokens += u.output_tokens;
      if (d === null) jevStats.unpriced_calls++;
      else jevStats.dollars += d;
      logUsageLine(log, { step: o.step, provider: "jev", model, ...(j?.model ? { served_model: j.model } : {}), ...u, dollars: d });
    }
    return res;
  };
  const opts: HttpOptions & { model: string } = { model, fetch: wrapped };
  if (o.apiKey) opts.apiKey = o.apiKey;
  if (o.backoffMs !== undefined) opts.backoffMs = o.backoffMs;
  return new Jev(opts);
}

/** A chat model answering the classifier's questions with the pipeline's chat-fallback prompt and parser. */
export function chatClassifier(client: ChatClient, model: string, step: string, extra: Record<string, unknown> = {}): Classifier {
  const run: ChatRunner = async (prompt, parse) => (await client.complete({ ...extra, model, messages: [{ role: "user", content: prompt }] }, parse, { step })).value;
  return new ChatClassifier({ model, run });
}
