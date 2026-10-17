// Model-selection runner for one step on one provider and model.
//
//   cd central && npx tsx ../eval/select/run.mts --step extract|classify|judge --provider P --model M
//     [--split dev|heldout|all] [--limit N --seed S] [--set NAME] [--structure two-call|one-call]
//     [--dry-run] [--budget USD] [--allow-openai] [--max-tokens N]
//
// Providers: vercel, cloudflare, openai (only with --allow-openai), jev (classify, judge), codex (the pipeline's
// `codex exec` path: Luna on the user's plan), and `cache`: the pipeline's own answers (stored extractions and the
// classifier cache, read only), which must reproduce the published numbers before any candidate is run.
// Outputs: eval/select/out/runs/<step>-<provider>-<model>-<structure>-<split>[-limit-seed]/, in the formats the
// existing scorers read; the scorers are run at the end. Nothing in .store is written: Jev's and Codex's own logs go to
// $UNSTALE_CENTRAL_DIR, set here to eval/select/out/central.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { OUT_DIR, ChatClient, dollars, loadPrices, logUsageLine, PROVIDERS, priceOf, type Price } from "./client.ts";
process.env.UNSTALE_CENTRAL_DIR = join(OUT_DIR, "central");
const { ChatClassifier, ClassifierCache, ClassifierError } = await import("../../central/src/pipeline/classify/adapter.ts");
const { interpret, labelQuestions } = await import("../../central/src/pipeline/classify/labels.ts");
const { runCodex, parseJson, CODEX_MODEL } = await import("../lib/codex.ts");
const { chunk, EXTRACT_PROMPT, Extracted, fill, LABEL_PROMPT, strings, toIncoming } = await import("../../central/src/pipeline/extract.ts");
const { TECHNOLOGIES } = await import("../../central/src/pipeline/technologies.ts");
const { pick } = await import("../../central/src/pipeline/match.ts");
const { pool, sha256, writeAtomic } = await import("../../central/src/pipeline/util.ts");
const { checkBudget, printSpend, remainingBudget } = await import("./budget.ts");
const { chatClassifier, jevClassifier } = await import("./jev.ts");
const { SubqClassifier } = await import("./subq.ts");
const { ONE_CALL_PROMPT } = await import("./prompts.ts");
const S = await import("./states.ts");
import type { Classification, Classifier, Questions } from "../../central/src/pipeline/classify/adapter.ts";
import type { Labels } from "../../central/src/pipeline/classify/labels.ts";
import type { Incoming } from "../../central/src/pipeline/extract.ts";

const { values: a } = parseArgs({
  options: {
    step: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    split: { type: "string", default: "dev" },
    limit: { type: "string" },
    seed: { type: "string", default: "1" },
    set: { type: "string" },
    structure: { type: "string", default: "two-call" },
    "dry-run": { type: "boolean", default: false },
    budget: { type: "string" },
    "allow-openai": { type: "boolean", default: false },
    "max-tokens": { type: "string" },
  },
});
const step = a.step as "extract" | "classify" | "judge";
const provider = a.provider ?? "";
if (!["extract", "classify", "judge"].includes(step) || !provider) throw new Error("usage: --step extract|classify|judge --provider P --model M [--split dev|heldout|all] [--limit N] [--dry-run]");
if (provider === "openai" && !a["allow-openai"]) throw new Error("the OpenAI API provider is disabled; pass --allow-openai (user: only if final results demand it)");
// Decision models (Jev, SubQ Snap) answer closed questions only.
const decision = provider === "jev" || provider === "subq";
if (decision && step === "extract") throw new Error(`${provider} answers closed questions only: classify or judge`);
if (!(provider in PROVIDERS) && provider !== "cache") throw new Error(`unknown provider ${provider}`);
const model = provider === "codex" ? (a.model ?? CODEX_MODEL) : provider === "jev" ? (a.model ?? "jev-latest") : provider === "subq" ? (a.model ?? "subq-snap-preview") : provider === "cache" ? "pipeline" : (a.model ?? "");
if (!model) throw new Error("--model is required");
const split = a.split as "dev" | "heldout" | "all";
const structure = a.structure as "two-call" | "one-call";
const limit = a.limit ? Number(a.limit) : undefined;
const dry = a["dry-run"];
const prices = loadPrices();
const price = priceOf(prices, provider, model);
const ATTEMPTS = 3;
const CHARS_PER_TOKEN_BOUND = 3; // worst-case input tokens: characters / 3 (English prose and JSON run ~4)
const MAX_OUT: Record<string, number> = { extract: 16_000, label: 16_000, "one-call": 24_000, classify: 2_000, judge: 2_000 };
if (a["max-tokens"]) for (const k of Object.keys(MAX_OUT)) MAX_OUT[k] = Number(a["max-tokens"]);
if (price?.max_output) for (const k of Object.keys(MAX_OUT)) MAX_OUT[k] = Math.min(MAX_OUT[k]!, price.max_output);
const runId = [step, provider, model.replace(/[^\w.-]+/g, "_"), ...(step === "extract" ? [structure] : []), split, ...(limit ? [`limit${limit}`, `seed${a.seed}`] : [])].join("-");
const runDir = join(OUT_DIR, "runs", runId);

const splits = JSON.parse(readFileSync(join(S.EVAL, "select", "splits.json"), "utf8")) as { sets: Record<string, { dev?: string[]; heldout?: string[] }> };
const inSplit = (set: string, x: string): boolean => {
  const s = splits.sets[set]!;
  return split === "all" || (split === "dev" ? (s.dev ?? []) : (s.heldout ?? [])).includes(x);
};
/** A fixed-seed sample: order by sha256(seed:id), keep the first N. */
const sample = <T,>(xs: T[], id: (x: T) => string): T[] =>
  limit === undefined ? xs : [...xs].sort((x, y) => sha256(`${a.seed}:${id(x)}`).localeCompare(sha256(`${a.seed}:${id(y)}`))).slice(0, limit);
const tok = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN_BOUND);

// ---- Worst-case estimate and the budget guard ----

interface Plan {
  calls: number;
  input: number;
  output: number;
}
const plan: Plan = { calls: 0, input: 0, output: 0 };
const planCall = (inputTokens: number, maxOut: number): void => {
  plan.calls++;
  plan.input += inputTokens;
  plan.output += maxOut;
};
const worstDollars = (p: Price | undefined, input: number, output: number): number | null =>
  provider === "cache" ? 0 : dollars(p, { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_tokens: null });

async function guard(): Promise<void> {
  const one = worstDollars(price, plan.input, plan.output);
  const all = one === null ? null : one * ATTEMPTS;
  const fmt = (d: number | null) => (d === null ? "price unknown" : `$${d.toFixed(4)}`);
  console.log(`${runId}: ${plan.calls} calls; worst case ${plan.input} input + ${plan.output} output tokens = ${fmt(one)} (${fmt(all)} if every call is retried ${ATTEMPTS}×)` +
    (price ? ` [price ${price.input}/${price.cached_input}/${price.output} per M, ${price.source}, checked ${price.checked}]` : provider === "cache" ? "" : " [no price row]"));
  if (provider === "codex") console.log("  codex: billed to the plan; the $ above is Luna at API list price without the harness overhead");
  if (dry || provider === "cache") return;
  const remaining = await remainingBudget(provider, a.budget !== undefined ? Number(a.budget) : undefined);
  const refusal = checkBudget(all, remaining);
  if (refusal) {
    console.error(`refused: ${refusal}`);
    process.exit(2);
  }
}

// ---- Answer sources ----

const chat = ["vercel", "openai", "cloudflare"].includes(provider) ? new ChatClient({ provider: PROVIDERS[provider]!, cacheDir: join(OUT_DIR, "cache", "chat") }) : undefined;

/** Codex through the pipeline's runner: the store's Codex cache (read only), then ours, then `codex exec`. */
async function codexComplete<T>(prompt: string, parse: (t: string) => T | undefined, stepName: string): Promise<T | undefined> {
  const key = sha256(`${model}\n${prompt}`);
  for (const dir of [join(S.STORE, "central", "cache", "codex"), join(OUT_DIR, "central", "cache", "codex")]) {
    const p = join(dir, key.slice(0, 2), `${key}.json`);
    if (existsSync(p)) {
      const v = parse((JSON.parse(readFileSync(p, "utf8")) as { text: string }).text);
      if (v !== undefined) return v;
    }
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const r = await runCodex(prompt, model);
    if (r.usage) {
      const u = { input_tokens: r.usage.input_tokens, cached_input_tokens: r.usage.cached_input_tokens, output_tokens: r.usage.output_tokens, reasoning_tokens: null };
      const promptTokens = Math.ceil(prompt.length / 4);
      logUsageLine(join(OUT_DIR, "usage.jsonl"), {
        step: stepName, provider: "codex", model, ...u,
        dollars: dollars(price, u),
        prompt_chars: prompt.length,
        prompt_tokens_est: promptTokens,
        dollars_prompt_only: dollars(price, { input_tokens: promptTokens, cached_input_tokens: 0, output_tokens: u.output_tokens, reasoning_tokens: null }),
        cost_source: "list price (harness included); the plan is billed, not this",
      });
    }
    const v = r.code === 0 ? parse(r.text) : undefined;
    if (v !== undefined) {
      writeAtomic(join(OUT_DIR, "central", "cache", "codex", key.slice(0, 2), `${key}.json`), JSON.stringify({ model, text: r.text, usage: r.usage }) + "\n");
      return v;
    }
  }
  return undefined;
}

async function generate<T>(prompt: string, parse: (t: string) => T | undefined, kind: string): Promise<T | undefined> {
  if (provider === "codex") return codexComplete(prompt, parse, `${step}:${kind}`);
  const c = await chat!.complete({ model, messages: [{ role: "user", content: prompt }], max_tokens: MAX_OUT[kind]! }, parse, { step: `${step}:${kind}` });
  return c.value;
}

/** The classifier for steps D and E, or undefined for `cache` (answers only from the pipeline's classifier cache). */
function classifier(stepName: string): Classifier | undefined {
  if (provider === "cache") return undefined;
  if (provider === "jev") return jevClassifier({ model, step: stepName });
  if (provider === "subq") return new SubqClassifier({ model, step: stepName });
  if (provider === "codex") {
    return new ChatClassifier({ model, run: (prompt, parse) => codexComplete(prompt, parse, stepName) });
  }
  return chatClassifier(chat!, model, stepName, { max_tokens: MAX_OUT[step === "judge" ? "judge" : "classify"]! });
}

/** Asks one request: our cache, then the classifier; `cache` reads the pipeline's answer for a faithful request. */
async function ask(cls: Classifier | undefined, cache: InstanceType<typeof ClassifierCache>, state: Record<string, unknown>, q: Questions, storeCache: string | string[] | undefined): Promise<Classification | undefined> {
  if (!cls) return storeCache ? S.cached(storeCache, state, q) : undefined;
  const hit = cache.get(cls, state, q);
  if (hit) return hit;
  try {
    const r = await cls.classify(state, q);
    cache.put(cls, state, q, r);
    return r;
  } catch (e) {
    if (e instanceof ClassifierError) {
      console.error(`${provider}: ${e.kind}: ${e.message}`);
      return undefined;
    }
    throw e;
  }
}

const python = (args: string[]): void => {
  console.log(`$ python3 ${args.join(" ")}`);
  try {
    console.log(execFileSync("python3", args, { cwd: join(S.EVAL, ".."), encoding: "utf8" }).trimEnd());
  } catch (e) {
    console.error(String(e));
  }
};

// ---- Step A (+B): extraction ----

interface Doc {
  tech: string;
  rel: { technology: string; version: string; date: string; url: string; snapshot: string; notes: string; tag: string; kind?: "upgrade_guide"; keyTag?: string };
  /** The extraction-key prefix of this document (`next@16.0.0+guide.604704de#`). */
  prefix: string;
}

function documents(): Doc[] {
  const items = JSON.parse(readFileSync(join(S.EVAL, "sets", "extraction-recall.json"), "utf8")).items as Array<{ event: string; split: string; in_fetched_sources: boolean; sources: Array<{ url: string }> }>;
  const techOf: Record<string, string> = { next16: "next", prisma7: "prisma", nest12: "nestjs" };
  const want = new Map<string, string>();
  for (const it of items) if (it.in_fetched_sources && inSplit("extraction", it.event)) for (const s of it.sources) want.set(s.url, techOf[it.event.split("-").at(-1)!]!);
  const docs: Doc[] = [];
  for (const [url, tech] of want) {
    const central = join(S.STORE, "central");
    const rels = JSON.parse(readFileSync(join(central, "releases", tech, "index.json"), "utf8")).releases as Array<Omit<Doc["rel"], "notes">>;
    const r = rels.find((x) => x.url === url);
    if (r) {
      const notes = TECHNOLOGIES[tech]!.clean(readFileSync(join(central, "releases", tech, `${r.version}.md`), "utf8"));
      docs.push({ tech, rel: { ...r, notes }, prefix: `${tech}@${r.version}#` });
      continue;
    }
    const gs = JSON.parse(readFileSync(join(central, "guides", tech, "index.json"), "utf8")).guides as Array<Omit<Doc["rel"], "notes"> & { keyTag: string }>;
    const g = gs.find((x) => x.url === url);
    if (!g) throw new Error(`no stored document for ${url}`);
    const notes = readFileSync(join(central, "guides", tech, `${g.version.split(".")[0]}.${g.snapshot.slice(7, 15)}.md`), "utf8");
    docs.push({ tech, rel: { ...g, notes, kind: "upgrade_guide" }, prefix: `${tech}@${g.version}${g.keyTag}#` });
  }
  return docs.sort((x, y) => x.prefix.localeCompare(y.prefix));
}

const records = (text: string): Array<Record<string, unknown>> | undefined => {
  const v = parseJson(text, "array");
  return Array.isArray(v) ? (v.filter((r) => Extracted.safeParse(r).success) as Array<Record<string, unknown>>) : undefined;
};
const labelObject = (text: string): Record<string, unknown> | undefined => {
  const v = parseJson(text, "object");
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
};

async function extractDoc(d: Doc): Promise<{ incoming: Incoming[]; failed: number }> {
  const t = TECHNOLOGIES[d.tech]!;
  const parts = chunk(d.rel.notes);
  const out: Incoming[] = [];
  let failed = 0;
  await Promise.all(
    parts.map(async (notes, ci) => {
      if (!notes.trim()) return;
      const part = parts.length > 1 ? `\nPart ${ci + 1} of ${parts.length} of these release notes.` : "";
      const vars = { TECH: t.name, VERSION: d.rel.version, DATE: d.rel.date, PART: part, NOTES: notes };
      if (structure === "one-call") {
        const recs = await generate(fill(ONE_CALL_PROMPT, vars), records, "one-call");
        if (!recs) return void failed++;
        recs.forEach((r, i) => out.push(toIncoming(t, d.rel as never, ci, i, Extracted.parse(r), r, notes)));
        return;
      }
      const recs = await generate(fill(EXTRACT_PROMPT, vars), records, "extract");
      if (!recs) return void failed++;
      if (!recs.length) return;
      const ex = recs.map((r) => Extracted.parse(r));
      // As extract.ts extractRelease: the brief of each record, then the label call over the same notes.
      const brief = ex.map((r, i) => ({ id: `r${i + 1}`, subject: r.subject, facet: r.facet ?? null, change_type: r.change_type ?? null, summary: r.summary, introduces: strings(r.introduces, 20), evidence: r.evidence ?? "" }));
      const labels = await generate(fill(LABEL_PROMPT, { TECH: t.name, VERSION: d.rel.version, RECORDS: JSON.stringify(brief, null, 1), NOTES: notes }), labelObject, "label");
      if (!labels) failed++;
      ex.forEach((r, i) => out.push(toIncoming(t, d.rel as never, ci, i, r, labels?.[`r${i + 1}`], notes)));
    }),
  );
  out.sort((x, y) => x.key.localeCompare(y.key, "en", { numeric: true }));
  return { incoming: out, failed };
}

/** A catalog directory as score.py reads it: v1/tech/<t>.json listing gzipped JSONL shards of active records. */
function writeCatalog(dir: string, incoming: Incoming[]): void {
  const by = new Map<string, Incoming[]>();
  for (const i of incoming) by.set(i.technology, [...(by.get(i.technology) ?? []), i]);
  for (const [t, xs] of by) {
    const lines = xs.map((i) => JSON.stringify({ id: i.key, technology: t, status: "active", subject: i.subject, summary: i.summary, evidence: [{ kind: i.kind ?? "release_notes", url: i.url, quote: i.quote }] }));
    writeAtomic(join(dir, "v1", "shards", `${t}.jsonl.gz`), gzipSync(lines.join("\n") + "\n"));
    writeAtomic(join(dir, "v1", "tech", `${t}.json`), JSON.stringify({ shards: [{ path: `v1/shards/${t}.jsonl.gz` }] }) + "\n");
  }
}

async function runExtract(): Promise<void> {
  const docs = sample(documents(), (d) => d.prefix);
  const promptOf = structure === "one-call" ? ONE_CALL_PROMPT : EXTRACT_PROMPT;
  for (const d of docs) {
    for (const notes of chunk(d.rel.notes)) {
      const base = tok(fill(promptOf, { TECH: d.tech, VERSION: d.rel.version, DATE: d.rel.date, PART: "", NOTES: notes }));
      if (structure === "one-call") planCall(base, MAX_OUT["one-call"]!);
      else {
        planCall(base, MAX_OUT.extract!);
        // The label call reads the notes again plus the records (bounded by the extraction's output, pretty-printed).
        planCall(tok(fill(LABEL_PROMPT, { TECH: d.tech, VERSION: d.rel.version, RECORDS: "", NOTES: notes })) + Math.ceil(1.5 * MAX_OUT.extract!), MAX_OUT.label!);
      }
    }
  }
  console.log(`documents: ${docs.map((d) => d.prefix.slice(0, -1)).join(", ")}`);
  await guard();
  if (dry) return;
  let incoming: Incoming[] = [];
  let failed = 0;
  if (provider === "cache") {
    for (const d of docs) incoming.push(...[...S.extractions(join(S.STORE, "central"), d.tech).values()].filter((i) => i.key.startsWith(d.prefix)));
  } else {
    for (const r of await pool(docs, 3, extractDoc)) {
      incoming.push(...r.incoming);
      failed += r.failed;
    }
  }
  incoming = incoming.sort((x, y) => x.key.localeCompare(y.key, "en", { numeric: true }));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "incoming.json"), JSON.stringify(incoming, null, 1) + "\n");
  writeCatalog(join(runDir, "catalog"), incoming);
  console.log(`${incoming.length} records from ${docs.length} documents, ${failed} failed calls; ungrounded quotes ${incoming.filter((i) => !i.grounded).length}`);
  python(["eval/sets/score.py", "extraction", join(runDir, "catalog")]);
}

// ---- Step D: record labels ----

async function runClassify(): Promise<void> {
  const sets = a.set ? [a.set] : ["benefit", "breaking"];
  const q = labelQuestions();
  const built = sets.map((s) => ({ s, b: s === "benefit" ? S.benefitUnits() : S.breakingUnits() }));
  let units = built.flatMap(({ s, b }) => b.units.filter((u) => inSplit(s, u.tech)));
  units = sample(units, (u) => `${u.set}:${u.id}`);
  for (const { s, b } of built) {
    const mine = b.units.filter((u) => u.set === s);
    console.log(`${s}: ${mine.length} requests (${mine.filter((u) => u.faithful).length} proven identical to the pipeline's), ${b.excluded.length} excluded${b.note ? `; ${b.note}` : ""}`);
    for (const e of b.excluded.slice(0, 10)) console.log(`  excluded ${e.item}: ${e.why}`);
  }
  for (const u of units) planCall(tok(JSON.stringify({ state: u.state, questions: q })) + (decision ? 0 : 400), decision ? 0 : MAX_OUT.classify!);
  await guard();
  if (dry) return;
  const cls = classifier("classify");
  const cache = new ClassifierCache(join(OUT_DIR, "cache", "classifier", provider));
  const answers = new Map<string, Classification>();
  await pool(units, 4, async (u) => {
    const store = u.set === "benefit" && u.faithful ? join(S.STORE, "central-trust", "cache", "classifier") : undefined;
    const r = await ask(cls, cache, u.state, q, store);
    if (r) answers.set(`${u.set}:${u.id}`, r);
  });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "answers.json"), JSON.stringify(Object.fromEntries(answers), null, 1) + "\n");
  for (const s of sets) {
    const mine = units.filter((u) => u.set === s);
    const labels = new Map<string, Labels>();
    for (const u of mine) {
      const r = answers.get(`${s}:${u.id}`);
      if (r) labels.set(u.id, interpret(r));
    }
    // An item with any unanswered source is left out rather than scored on a partial union.
    const unanswered = new Set(mine.filter((u) => !labels.has(u.id)).map((u) => u.item));
    const agg = S.aggregate(mine.filter((u) => !unanswered.has(u.item)), labels);
    console.log(`${s}: ${agg.size} items labelled, ${unanswered.size} left out (an unanswered request)`);
    const file = join(runDir, `${s}-labels.json`);
    if (s === "benefit") writeFileSync(file, JSON.stringify(Object.fromEntries([...agg].map(([k, v]) => [k, v.benefit])), null, 1) + "\n");
    else writeFileSync(file, JSON.stringify(Object.fromEntries([...agg].map(([k, v]) => [k, v.breaking])), null, 1) + "\n");
    python(["eval/sets/score.py", s, file]);
  }
}

// ---- Step E: same-or-new judge ----

async function runJudge(): Promise<void> {
  const sets = a.set ? [a.set] : ["within", "guides", "nuxt"];
  const built: Array<{ s: string; b: Awaited<ReturnType<typeof S.nuxtUnits>> }> = [];
  for (const s of sets) built.push({ s, b: s === "within" ? await S.withinUnits() : s === "guides" ? S.guideUnits() : await S.nuxtUnits() });
  for (const { s, b } of built) {
    console.log(`${s}: ${b.units.length} pairs reconstructed faithfully, ${b.excluded.length} not reconstructable`);
    for (const e of b.excluded) console.log(`  not reconstructable: ${e.item}: ${e.why}`);
  }
  // Since f99833e the pipeline asks the shorter judge text (match.ts shortRules) and merges at SAME_P_SHORT, so a replay
  // of the stores' ingest no longer reproduces the requests they were built with.
  if (!built.some(({ b }) => b.units.length))
    throw new Error("no judge pair rebuilds faithfully from the stores (the judge text changed after they were built); the faithful requests frozen before then are out/slice5/units.json: use slice5/judge2.mts and score5.mts");
  let units = built.flatMap(({ s, b }) => b.units.filter((u) => inSplit(s, u.tech)));
  units = sample(units, (u) => `${u.set}:${u.n}`);
  const reqs = new Map<string, (typeof units)[number]>();
  for (const u of units) reqs.set(sha256(JSON.stringify([u.state, u.questions])), u);
  for (const u of reqs.values()) planCall(tok(JSON.stringify({ state: u.state, questions: u.questions })) + (decision ? 0 : 400), decision ? 0 : MAX_OUT.judge!);
  await guard();
  if (dry) return;
  const cls = classifier("judge");
  const cache = new ClassifierCache(join(OUT_DIR, "cache", "classifier", provider));
  const caches: Record<string, string | string[]> = {
    within: join(S.STORE, "central-v1", "cache", "classifier"),
    guides: S.GUIDE_CACHES,
    nuxt: join(S.STORE, "central-trust-nuxt", "cache", "classifier"),
  };
  const ans = new Map<string, Classification | undefined>();
  await pool([...reqs], 4, async ([k, u]) => ans.set(k, await ask(cls, cache, u.state, u.questions, caches[u.set])));
  // Ingest's decision for each audited request under this answer: match.ts `pick` (judge at SAME_P, then the guards).
  const rows = units.map((u) => {
    const r = ans.get(sha256(JSON.stringify([u.state, u.questions])));
    const decision = r ? pick(u.cands, r.answers, u.guardInc) : undefined;
    return { set: u.set, n: u.n, tech: u.tech, key: u.key, candidate: u.candidate, verdict: u.verdict, p_audit: u.p, p_run: r?.answers[`same_c${u.index + 1}`]?.probabilities.yes, merged: decision ? decision.id === u.candidate : undefined, outcome: decision?.judged[u.index]?.outcome };
  });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "judge.json"), JSON.stringify(rows, null, 1) + "\n");
  for (const s of sets) {
    const mine = rows.filter((r) => r.set === s);
    const scored = mine.filter((r) => r.merged !== undefined);
    const merged = scored.filter((r) => r.merged);
    const v = (xs: typeof scored, x: string) => xs.filter((r) => r.verdict === x).length;
    const falsePer100 = merged.length ? (100 * (v(merged, "DIFFERENT") + 0.5 * v(merged, "UNSURE"))) / merged.length : 0;
    console.log(`${s}: ${scored.length} of ${mine.length} answered | merged (judge + guards) ${merged.length}: SAME ${v(merged, "SAME")}, DIFFERENT ${v(merged, "DIFFERENT")}, UNSURE ${v(merged, "UNSURE")} | false merges per 100 merges ${falsePer100.toFixed(1)} | SAME pairs not merged ${v(scored, "SAME") - v(merged, "SAME")} | p identical to the audit ${scored.filter((r) => r.p_run === r.p_audit).length}`);
    if (s === "guides") {
      const pairs = JSON.parse(readFileSync(join(S.EVAL, "guides", "pairs.json"), "utf8")) as Array<{ n: number; p: number }>;
      const byN = new Map(mine.map((r) => [r.n, r.p_run]));
      const out = pairs.filter((p) => byN.get(p.n) !== undefined).map((p) => ({ ...p, p: byN.get(p.n)! }));
      writeFileSync(join(runDir, "guides-pairs.json"), JSON.stringify(out, null, 1) + "\n");
      python(["eval/guides/rule_eval.py", join(runDir, "guides-pairs.json"), "eval/guides/verdicts.json"]);
    }
  }
}

if (step === "extract") await runExtract();
else if (step === "classify") await runClassify();
else await runJudge();
if (!dry) printSpend();
