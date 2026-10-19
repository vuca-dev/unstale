// Slice 3 runner: step A (+B) on the held-out extraction notes or the dev documents (PREREG.md).
//
//   cd central && npx tsx ../eval/select/slice3/run3.mts --cand luna-fresh|luna-cached|vercel:<model>
//     --split heldout|dev|smoke [--structure two-call|one-call] [--dry-run] [--tag T]
//
// As extract.ts extractRelease, call for call (the pipeline's prompts, chunk, parsers and toIncoming). Differences, all
// pre-registered: a truncated chat answer (finish_reason "length") fails its chunk at once (zero records, not retried);
// Luna-fresh reads no stored answer (own cache under out/slice3/cache/<run>); Luna-cached makes no call.
// Output: out/slice3/runs/<run>/incoming.json, raw.jsonl (every answer), meta.json; dev also writes catalog/.
// Gateway usage goes to out/slice3/usage.jsonl; every call is refused once that log reaches the slice cap ($4).
// Slice 3e (PREREG.md, "Slice 3e"): --cand openai:<model> calls the OpenAI API directly (central's `openai` provider,
// max_completion_tokens, priced from prices.json at Standard list). For openai the cap is hard per call: a call starts only
// if the log plus every in-flight call's worst case (prompt chars/3 at input + max output at output) stays within --cap.
// Slice 3f (PREREG.md, "Slice 3f"): --strict adds OpenAI strict structured output to both two-call answers (below).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a } = parseArgs({
  options: {
    cand: { type: "string" },
    split: { type: "string", default: "smoke" },
    structure: { type: "string", default: "two-call" },
    "dry-run": { type: "boolean", default: false },
    tag: { type: "string" },
    concurrency: { type: "string", default: "4" },
    out: { type: "string", default: "slice3" },
    cap: { type: "string", default: "4" },
    effort: { type: "string" },
    evidence: { type: "string", default: "quote" },
    diet: { type: "string" },
    addendum: { type: "string" },
    repair: { type: "string" },
    strict: { type: "boolean", default: false },
  },
});
// Slice 3b (PREREG.md, "Slice 3b"): --out slice3b --cap 2.5; split heldout2 = held-out set 2 (holdout-majors); smoke3b
// = the shortest first-set note + msw's guide; --effort overrides the model's reasoning_effort.
const OUT3 = join(SELECT, "out", a.out!);
process.env.UNSTALE_CENTRAL_DIR = join(OUT3, "central");
const { PROVIDERS, baseUrlOf, dollars, loadPrices, parseUsage, priceOf, reportedCost, Limiter } = await import("../client.ts");
const { gatewayBalance, GATEWAY_RESERVE } = await import("../budget.ts");
const { keyFromEnvFile } = await import("../../../central/src/pipeline/classify/adapter.ts");
const { parseJson, CODEX_MODEL } = await import("../../lib/codex.ts");
const { chunk, EXTRACT_PROMPT, EXTRACT_PROMPT_IDS, Extracted, fill, LABEL_PROMPT, numberUnits, ONE_CALL_PROMPT, dietPrompt, parseIdsAnswer, parseOneCall, parseSchemaAnswer, SCHEMA_PROMPT, SCHEMA_RESPONSE_FORMAT, strings, toIncoming } = await import("../../../central/src/pipeline/extract.ts");
const { TECHNOLOGIES } = await import("../../../central/src/pipeline/technologies.ts");
const { pool, sha256, writeAtomic } = await import("../../../central/src/pipeline/util.ts");
const S = await import("../states.ts");
import type { Incoming } from "../../../central/src/pipeline/extract.ts";

export const SLICE_CAP = Number(a.cap);
const cand = a.cand ?? "";
const split = a.split as "heldout" | "dev" | "smoke" | "heldout2" | "smoke3b";
const structure = a.structure as "two-call" | "one-call" | "one-call-schema";
const dry = a["dry-run"];
const kind = cand === "luna-fresh" ? "codex" : cand === "luna-cached" ? "cached" : cand.startsWith("vercel:") ? "vercel" : cand.startsWith("openai:") ? "openai" : "";
const api = kind === "vercel" || kind === "openai";
if (!kind || !["heldout", "dev", "smoke", "heldout2", "smoke3b"].includes(split) || !["two-call", "one-call", "one-call-schema"].includes(structure)) throw new Error("usage: --cand luna-fresh|luna-cached|vercel:<model> --split heldout|dev|smoke [--structure two-call|one-call]");
const model = api ? cand.slice(kind.length + 1) : CODEX_MODEL;
const evidence = a.evidence as "quote" | "ids";
const runId = [cand.replace(/[^\w.-]+/g, "_"), structure, split, ...(evidence === "ids" ? ["ev_ids"] : []), ...(a.diet ? [a.diet === "compact" ? "compact" : "diet"] : []), ...(a.addendum ? [`add_${a.addendum}`] : []), ...(a.effort ? [`effort_${a.effort}`] : []), ...(a.repair ? ["repair"] : []), ...(a.strict ? ["strict"] : []), ...(a.tag ? [a.tag] : [])].join("-");
const runDir = join(OUT3, "runs", runId);
const USAGE = join(OUT3, "usage.jsonl");
const prices = loadPrices();
const price = api ? priceOf(prices, kind, model) : priceOf(prices, "codex", CODEX_MODEL);
const MAX_OUT: Record<string, number> = { extract: 16_000, label: 16_000, "one-call": 24_000, "one-call-schema": 24_000 };
if (price?.max_output) for (const k of Object.keys(MAX_OUT)) MAX_OUT[k] = Math.min(MAX_OUT[k]!, price.max_output);
const EXTRA: Record<string, Record<string, unknown>> = {
  "openai/gpt-oss-20b": { reasoning_effort: "low" },
  "openai/gpt-oss-120b": { reasoning_effort: "low" },
  "alibaba/qwen3.8-flash": { reasoning_effort: "none" },
  "deepseek/deepseek-v4-flash": { reasoning_effort: "none" },
  // Slice 3b: the lowest effort each accepts (probed 16 October 2026; PREREG.md "Slice 3b"), gpt-6-luna at low as briefed.
  "openai/gpt-6-luna": { reasoning_effort: "low" },
  "openai/gpt-5-nano": { reasoning_effort: "minimal" },
  "nvidia/nemotron-3.5-lightning": { reasoning_effort: "none" },
  "alibaba/qwen3.7-flash": { reasoning_effort: "none" },
  "zai/glm-4.7-flash": { reasoning_effort: "none" },
  // Slice 3e: OpenAI API directly, reasoning low as production's gpt-6-luna.
  "gpt-5.4-mini": { reasoning_effort: "low" },
  "gpt-5-mini": { reasoning_effort: "low" },
  "gpt-5.4-nano": { reasoning_effort: "low" },
  // Slice 3f: gpt-5.6-luna on the OpenAI API directly (slice 3's Luna baseline ran it through codex exec).
  "gpt-5.6-luna": { reasoning_effort: "low" },
};
if (a.effort) EXTRA[model] = { reasoning_effort: a.effort };
const ATTEMPTS = 3;
const { withAddendum } = await import("./addenda.ts");
const DIET = (p: string) => withAddendum(a.diet ? dietPrompt(p, a.diet === "compact" ? "compact" : "full") : p, a.addendum);

// ---- Documents ----

interface Doc {
  id: string;
  t: { id: string; name: string };
  rel: { technology: string; version: string; date: string; url: string; snapshot: string; notes: string; kind?: "upgrade_guide"; keyTag?: string };
}

function heldoutDocs(): Doc[] {
  const H = join(SELECT, "holdout", "extraction");
  const m = JSON.parse(readFileSync(join(H, "notes.json"), "utf8")) as { notes: Array<{ note_file: string; technology: string; name: string; version: string; date: string; url: string; snapshot: string }> };
  return m.notes.map((n) => ({
    id: n.note_file,
    t: { id: n.technology, name: n.name },
    rel: { technology: n.technology, version: n.version, date: n.date, url: n.url, snapshot: n.snapshot, notes: readFileSync(join(H, "notes", n.note_file), "utf8") },
  }));
}

/** The 9 documents eval/sets/extraction-recall.json cites in fetched sources (run.mts `documents`, split all). */
function devDocs(): Doc[] {
  const items = JSON.parse(readFileSync(join(S.EVAL, "sets", "extraction-recall.json"), "utf8")).items as Array<{ event: string; in_fetched_sources: boolean; sources: Array<{ url: string }> }>;
  const techOf: Record<string, string> = { next16: "next", prisma7: "prisma", nest12: "nestjs" };
  const want = new Map<string, string>();
  for (const it of items) if (it.in_fetched_sources) for (const s of it.sources) want.set(s.url, techOf[it.event.split("-").at(-1)!]!);
  const docs: Doc[] = [];
  const central = join(S.STORE, "central");
  for (const [url, tech] of want) {
    const t = TECHNOLOGIES[tech]!;
    const rels = JSON.parse(readFileSync(join(central, "releases", tech, "index.json"), "utf8")).releases as Array<Omit<Doc["rel"], "notes">>;
    const r = rels.find((x) => x.url === url);
    if (r) {
      docs.push({ id: `${tech}@${r.version}`, t, rel: { ...r, notes: t.clean(readFileSync(join(central, "releases", tech, `${r.version}.md`), "utf8")) } });
      continue;
    }
    const gs = JSON.parse(readFileSync(join(central, "guides", tech, "index.json"), "utf8")).guides as Array<Omit<Doc["rel"], "notes"> & { keyTag: string }>;
    const g = gs.find((x) => x.url === url);
    if (!g) throw new Error(`no stored document for ${url}`);
    docs.push({ id: `${tech}@${g.version}${g.keyTag}`, t, rel: { ...g, notes: readFileSync(join(central, "guides", tech, `${g.version.split(".")[0]}.${g.snapshot.slice(7, 15)}.md`), "utf8"), kind: "upgrade_guide" } });
  }
  return docs.sort((x, y) => x.id.localeCompare(y.id));
}

/** Held-out set 2 (eval/select/holdout-majors): guides go through as the pipeline's guide notes (kind upgrade_guide). */
function heldout2Docs(): Doc[] {
  const H = join(SELECT, "holdout-majors", "extraction");
  const m = JSON.parse(readFileSync(join(H, "notes.json"), "utf8")) as { notes: Array<{ note_file: string; technology: string; name: string; kind: string; version: string; date: string; url: string }> };
  return m.notes.map((n) => ({
    id: n.note_file,
    t: { id: n.technology, name: n.name },
    rel: { technology: n.technology, version: n.version, date: n.date, url: n.url, snapshot: "", notes: readFileSync(join(H, "notes", n.note_file), "utf8"),
      ...(n.kind === "guide" ? { kind: "upgrade_guide" as const, keyTag: "+guide.h2" } : {}) },
  }));
}

let docs = split === "heldout" ? heldoutDocs() : split === "heldout2" ? heldout2Docs() : split === "smoke3b" ? [] : devDocs();
if (split === "smoke") docs = [...docs].sort((x, y) => x.rel.notes.length - y.rel.notes.length).slice(0, 2);
if (split === "smoke3b") docs = [[...heldoutDocs()].sort((x, y) => x.rel.notes.length - y.rel.notes.length)[0]!, heldout2Docs().find((d) => d.id === "msw@3.0.0.guide.md")!];

// ---- Spend ----

function sliceSpend(): number {
  if (!existsSync(USAGE)) return 0;
  let d = 0;
  for (const l of readFileSync(USAGE, "utf8").split("\n")) if (l.trim()) { const e = JSON.parse(l); if (e.provider === (kind === "openai" ? "openai" : "vercel") && typeof e.dollars === "number") d += e.dollars; }
  return d;
}
const meter = { calls: 0, input: 0, cached_input: 0, output: 0, reasoning: 0, dollars: 0, unparseable: 0, truncated: 0, http_failed: 0, refused: 0, store_hits: 0, own_cache_hits: 0, prompt_tokens_est: 0, repaired: 0 };
function log(step: string, u: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number | null }, d: number | null, extra: Record<string, unknown>) {
  meter.calls++;
  meter.input += u.input_tokens;
  meter.cached_input += u.cached_input_tokens;
  meter.output += u.output_tokens;
  meter.reasoning += u.reasoning_tokens ?? 0;
  meter.dollars += d ?? 0;
  mkdirSync(OUT3, { recursive: true });
  appendFileSync(USAGE, JSON.stringify({ run: runId, step, provider: api ? kind : "codex", model, ...u, dollars: d, ...extra, at: new Date().toISOString() }) + "\n");
}
const raw = (o: Record<string, unknown>) => { mkdirSync(runDir, { recursive: true }); appendFileSync(join(runDir, "raw.jsonl"), JSON.stringify(o) + "\n"); };

// ---- Answer sources ----

type Outcome<T> = { value?: T; why?: "unparseable" | "truncated" | "http" | "refused" | "missing" };
const cacheDir = join(OUT3, "cache", runId);
const readCache = (dir: string, key: string): string | undefined => {
  const p = join(dir, key.slice(0, 2), `${key}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { text: string }).text : undefined;
};
const writeCache = (key: string, text: string, usage: unknown) => writeAtomic(join(cacheDir, key.slice(0, 2), `${key}.json`), JSON.stringify({ model, text, usage }) + "\n");

const limiter = new Limiter(Number(a.concurrency));
const PROV = PROVIDERS[kind === "openai" ? "openai" : "vercel"]!;
const apiKey = api ? keyFromEnvFile(PROV.keyFile, PROV.keyVar) : () => "";
let reserved = 0; // openai: worst case of the calls in flight (hard cap)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(body: Record<string, unknown>): Promise<{ text: string; finish?: string; usage?: ReturnType<typeof parseUsage>; cost?: number; reasoningText?: number } | undefined> {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
    let res: Response;
    try {
      res = await fetch(`${baseUrlOf(PROV)}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < 4) { await sleep(2000 * 2 ** attempt); continue; }
      console.error(`network: ${String(e)}`);
      return undefined;
    }
    clearTimeout(timer);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) { const after = Number(res.headers.get("retry-after")); await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt); continue; }
      console.error(`HTTP ${res.status} after retries`);
      return undefined;
    }
    if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); return undefined; }
    const j = (await res.json()) as { choices?: Array<{ finish_reason?: string; message?: { content?: string | null; reasoning?: string | null } }>; usage?: unknown };
    const ch = j.choices?.[0];
    return { text: ch?.message?.content ?? "", finish: ch?.finish_reason, usage: parseUsage(j.usage), cost: reportedCost(j), reasoningText: ch?.message?.reasoning?.length };
  }
}

async function viaGateway<T>(prompt: string, parse: (t: string) => T | undefined, step: string, meta: Record<string, unknown>, rf?: unknown): Promise<Outcome<T>> {
  const body = { model, messages: [{ role: "user", content: prompt }], [kind === "openai" ? "max_completion_tokens" : "max_tokens"]: MAX_OUT[step]!, ...(EXTRA[model] ?? {}), ...(step === "one-call-schema" ? { response_format: SCHEMA_RESPONSE_FORMAT } : rf ? { response_format: rf } : {}) };
  const key = sha256(JSON.stringify(body));
  const hit = readCache(cacheDir, key);
  if (hit !== undefined) { const v = parse(hit); if (v !== undefined) { meter.own_cache_hits++; return { value: v }; } }
  return limiter.run(async () => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (sliceSpend() >= SLICE_CAP) { meter.refused++; console.error("refused: slice cap reached"); return { why: "refused" }; }
      const callWorst = kind === "openai" ? dollars(price, { input_tokens: Math.ceil(prompt.length / 3), cached_input_tokens: 0, output_tokens: MAX_OUT[step]!, reasoning_tokens: null }) ?? Infinity : 0;
      if (kind === "openai" && sliceSpend() + reserved + callWorst > SLICE_CAP) { meter.refused++; console.error("refused: this call's worst case would pass the slice cap"); return { why: "refused" }; }
      reserved += callWorst;
      let r: Awaited<ReturnType<typeof post>>;
      try { r = await post(body); } finally { reserved -= callWorst; }
      if (!r) { meter.http_failed++; raw({ ...meta, step, attempt, http_failed: true }); return { why: "http" }; }
      const u = r.usage ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: null };
      log(step, u, r.cost ?? dollars(price, u), { cost_source: r.cost !== undefined ? "provider" : "prices.json", finish: r.finish, attempt, ...meta });
      raw({ ...meta, step, attempt, finish: r.finish, usage: u, text: r.text });
      if (r.finish === "length") { meter.truncated++; return { why: "truncated" }; }
      const v = parse(r.text);
      if (v !== undefined) { writeCache(key, r.text, u); return { value: v }; }
      meter.unparseable++;
    }
    return { why: "unparseable" };
  });
}

/** codex exec with the pipeline's flags (codex.ts exec), keeping every usage field (reasoning included). */
let active = 0;
const waiting: Array<() => void> = [];
async function codexExec(prompt: string): Promise<{ text: string; usage?: Record<string, number>; code: number | null }> {
  if (active >= 5) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    const work = mkdtempSync(join(tmpdir(), "unstale-codex-"));
    return await new Promise((resolve) => {
      const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-s", "read-only", "-m", CODEX_MODEL, "-C", work, prompt];
      const p = spawn(process.env.UNSTALE_CODEX_BIN ?? "/opt/homebrew/bin/codex", args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.stderr.on("data", () => {});
      const timer = setTimeout(() => p.kill("SIGKILL"), 20 * 60 * 1000);
      p.on("close", (code) => {
        clearTimeout(timer);
        rmSync(work, { recursive: true, force: true });
        let text = "";
        let usage: Record<string, number> | undefined;
        for (const line of out.split("\n")) {
          let e: { type?: string; usage?: Record<string, number>; item?: { type?: string; text?: string } };
          try { e = JSON.parse(line); } catch { continue; }
          if (e.type === "turn.completed" && e.usage) { usage ??= {}; for (const [k, v] of Object.entries(e.usage)) if (typeof v === "number") usage[k] = (usage[k] ?? 0) + v; }
          if (e.type === "item.completed" && e.item?.type === "agent_message") text = e.item.text ?? "";
        }
        resolve({ text, usage, code });
      });
    });
  } finally {
    active--;
    waiting.shift()?.();
  }
}

async function viaCodex<T>(prompt: string, parse: (t: string) => T | undefined, step: string, meta: Record<string, unknown>): Promise<Outcome<T>> {
  const key = sha256(`${CODEX_MODEL}\n${prompt}`);
  if (kind === "cached") {
    for (const dir of [join(S.STORE, "central", "cache", "codex"), join(SELECT, "out", "central", "cache", "codex")]) {
      const t = readCache(dir, key);
      if (t !== undefined) { const v = parse(t); if (v !== undefined) { meter.store_hits++; return { value: v }; } }
    }
    return { why: "missing" };
  }
  const hit = readCache(cacheDir, key);
  if (hit !== undefined) { const v = parse(hit); if (v !== undefined) { meter.own_cache_hits++; return { value: v }; } }
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const r = await codexExec(prompt);
    const promptTokens = Math.ceil(prompt.length / 4);
    meter.prompt_tokens_est += promptTokens;
    if (r.usage) {
      const u = { input_tokens: r.usage.input_tokens ?? 0, cached_input_tokens: r.usage.cached_input_tokens ?? 0, output_tokens: r.usage.output_tokens ?? 0, reasoning_tokens: r.usage.reasoning_output_tokens ?? null };
      // Luna costed prompt-only at the gateway list price (the harness's system prompt excluded); the plan is billed.
      log(step, u, dollars(price, { input_tokens: promptTokens, cached_input_tokens: 0, output_tokens: u.output_tokens + (u.reasoning_tokens ?? 0), reasoning_tokens: null }), { prompt_tokens_est: promptTokens, raw_usage: r.usage, attempt, ...meta, cost_source: "prompt-only at list price; billed to the plan" });
    }
    raw({ ...meta, step, attempt, code: r.code, usage: r.usage, text: r.text });
    const v = r.code === 0 ? parse(r.text) : undefined;
    if (v !== undefined) { writeCache(key, r.text, r.usage); return { value: v }; }
    meter.unparseable++;
  }
  return { why: "unparseable" };
}

const generate = <T,>(prompt: string, parse: (t: string) => T | undefined, step: string, meta: Record<string, unknown>, rf?: unknown): Promise<Outcome<T>> =>
  api ? viaGateway(prompt, parse, step, meta, rf) : viaCodex(prompt, parse, step, meta);

// Slice 3f (--strict): OpenAI strict structured output for both two-call answers, the prompts unchanged. The schemas are
// SCHEMA_RESPONSE_FORMAT's record and label items without "id" (every property required, additionalProperties false,
// optional values as null). The extract prompt asks for a top-level array and a strict schema needs an object root, so the
// answer is {"records": [...]} and is unwrapped here; the label answer is already an object keyed r1..rN, so its schema
// lists exactly those ids. Null prerequisite bounds are dropped (the prompt says omit), the rest parses as before.
if (a.strict && kind !== "openai") throw new Error("--strict is for --cand openai:<model>");
const SR = SCHEMA_RESPONSE_FORMAT.json_schema.schema.properties;
const withoutId = (o: { properties: Record<string, unknown>; required: readonly string[] }) => ({ ...o, properties: Object.fromEntries(Object.entries(o.properties).filter(([k]) => k !== "id")), required: o.required.filter((k) => k !== "id") });
const RECORD_SCHEMA = withoutId(SR.records.items as never);
const LABEL_SCHEMA = withoutId(SR.labels.items as never);
const strictFormat = (name: string, schema: unknown) => ({ type: "json_schema", json_schema: { name, strict: true, schema } });
const EXTRACT_RF = strictFormat("change_records", { type: "object", properties: { records: { type: "array", items: RECORD_SCHEMA } }, required: ["records"], additionalProperties: false });
const labelRf = (n: number) => {
  const ids = Array.from({ length: n }, (_, i) => `r${i + 1}`);
  return strictFormat("record_labels", { type: "object", properties: Object.fromEntries(ids.map((id) => [id, LABEL_SCHEMA])), required: ids, additionalProperties: false });
};
const unwrapRecords = (t: string): string => {
  if (!a.strict) return t;
  const v = parseJson(t, "object") as { records?: unknown } | undefined;
  return v && Array.isArray(v.records) ? JSON.stringify(v.records) : t;
};
const dropNullBounds = (o: Record<string, unknown>): Record<string, unknown> => {
  if (!a.strict) return o;
  for (const l of Object.values(o)) {
    const ps = (l as { prerequisites?: unknown })?.prerequisites;
    if (Array.isArray(ps)) for (const p of ps) if (p && typeof p === "object") for (const k of ["min", "max"]) if ((p as Record<string, unknown>)[k] === null) delete (p as Record<string, unknown>)[k];
  }
  return o;
};

// Slice 3e arm M5r (--repair escaped-quote): only when an answer does not parse, a line `"<field>": \"<text>\"` (or `\""`)
// is rewritten to `"<field>": "<text>"` (gpt-5-mini opens string values with an escaped quote).
const repairLine = (t: string) => t.replace(/^(\s*"[A-Za-z_]+":\s*)\\"(.*?)\\?"+(,?)\s*$/gm, '$1"$2"$3');
const repaired = <T,>(p: (t: string) => T | undefined) => (t: string): T | undefined => {
  const v = p(t);
  if (v !== undefined || a.repair !== "escaped-quote") return v;
  const r = p(repairLine(t));
  if (r !== undefined) meter.repaired++;
  return r;
};
const records = repaired((text: string) => {
  const v = parseJson(unwrapRecords(text), "array");
  return Array.isArray(v) ? v.flatMap((r) => { const p = Extracted.safeParse(r); return p.success ? [p.data] : []; }) : undefined;
});
const labelObject = repaired((text: string) => {
  const v = parseJson(text, "object");
  return v && typeof v === "object" && !Array.isArray(v) ? dropNullBounds(v as Record<string, unknown>) : undefined;
});

// ---- Extraction ----

interface ChunkResult { doc: string; ci: number; chars: number; extract?: string; label?: string; records: number }
const chunkLog: ChunkResult[] = [];

async function extractDoc(d: Doc): Promise<Incoming[]> {
  const parts = chunk(d.rel.notes);
  const out: Incoming[] = [];
  await Promise.all(parts.map(async (notes, ci) => {
    if (!notes.trim()) return;
    const part = parts.length > 1 ? `\nPart ${ci + 1} of ${parts.length} of these release notes.` : "";
    const vars = { TECH: d.t.name, VERSION: d.rel.version, DATE: d.rel.date, PART: part, NOTES: notes };
    const meta = { doc: d.id, ci };
    const row: ChunkResult = { doc: d.id, ci, chars: notes.length, records: 0 };
    chunkLog.push(row);
    if (structure === "one-call-schema") {
      const r = await generate(fill(SCHEMA_PROMPT, vars), parseSchemaAnswer, "one-call-schema", meta);
      if (!r.value) return void (row.extract = r.why);
      row.records = r.value.length;
      r.value.forEach((x, i) => out.push(toIncoming(d.t as never, d.rel as never, ci, i, x.record, x.labels, notes)));
      return;
    }
    if (structure === "one-call") {
      const r = await generate(fill(ONE_CALL_PROMPT, vars), parseOneCall, "one-call", meta);
      if (!r.value) return void (row.extract = r.why);
      row.records = r.value.length;
      r.value.forEach((x, i) => out.push(toIncoming(d.t as never, d.rel as never, ci, i, x.record, x.labels, notes)));
      return;
    }
    const numbered = evidence === "ids" ? numberUnits(notes) : undefined;
    const r = numbered
      ? await generate(fill(DIET(EXTRACT_PROMPT_IDS), { ...vars, NOTES: numbered.text }), (t) => parseIdsAnswer(t, numbered.units), "extract", meta)
      : await generate(fill(DIET(EXTRACT_PROMPT), vars), records, "extract", meta, a.strict ? EXTRACT_RF : undefined);
    if (!r.value) return void (row.extract = r.why);
    row.records = r.value.length;
    if (!r.value.length) return;
    const brief = r.value.map((x, i) => ({ id: `r${i + 1}`, subject: x.subject, facet: x.facet ?? null, change_type: x.change_type ?? null, summary: x.summary, introduces: strings(x.introduces, 20), evidence: x.evidence ?? "" }));
    const l = await generate(fill(LABEL_PROMPT, { TECH: d.t.name, VERSION: d.rel.version, RECORDS: JSON.stringify(brief, null, 1), NOTES: notes }), labelObject, "label", meta, a.strict ? labelRf(r.value.length) : undefined);
    if (!l.value) row.label = l.why;
    r.value.forEach((x, i) => out.push(toIncoming(d.t as never, d.rel as never, ci, i, x, l.value?.[`r${i + 1}`], notes)));
  }));
  return out;
}

function writeCatalog(dir: string, incoming: Incoming[]): void {
  const by = new Map<string, Incoming[]>();
  for (const i of incoming) by.set(i.technology, [...(by.get(i.technology) ?? []), i]);
  for (const [t, xs] of by) {
    const lines = xs.map((i) => JSON.stringify({ id: i.key, technology: t, status: "active", subject: i.subject, summary: i.summary, evidence: [{ kind: i.kind ?? "release_notes", url: i.url, quote: i.quote }] }));
    writeAtomic(join(dir, "v1", "shards", `${t}.jsonl.gz`), gzipSync(lines.join("\n") + "\n"));
    writeAtomic(join(dir, "v1", "tech", `${t}.json`), JSON.stringify({ shards: [{ path: `v1/shards/${t}.jsonl.gz` }] }) + "\n");
  }
}

// ---- Plan, guard, run ----

let chunks = 0, chars = 0, worstIn = 0, worstOut = 0;
const P = structure === "one-call-schema" ? SCHEMA_PROMPT : structure === "one-call" ? ONE_CALL_PROMPT : EXTRACT_PROMPT;
for (const d of docs) for (const n of chunk(d.rel.notes)) {
  if (!n.trim()) continue;
  chunks++;
  chars += n.length;
  const base = Math.ceil(fill(P, { TECH: d.t.name, VERSION: d.rel.version, DATE: d.rel.date, PART: "", NOTES: n }).length / 3);
  if (structure !== "two-call") { worstIn += base; worstOut += MAX_OUT["one-call"]!; }
  else { worstIn += base + Math.ceil((fill(LABEL_PROMPT, { TECH: "", VERSION: "", RECORDS: "", NOTES: n }).length) / 3) + Math.ceil(1.5 * MAX_OUT.extract!); worstOut += MAX_OUT.extract! + MAX_OUT.label!; }
}
const worst = api ? dollars(price, { input_tokens: worstIn, cached_input_tokens: 0, output_tokens: worstOut, reasoning_tokens: null }) : 0;
console.log(`${runId}: ${docs.length} documents, ${chunks} chunks, ${chars} chars; worst case ${worstIn} in + ${worstOut} out = ${worst === null ? "price unknown" : `$${worst.toFixed(4)}`}` +
  (price ? ` [${price.input}/${price.cached_input}/${price.output} per M]` : "") + `; slice spend so far $${sliceSpend().toFixed(4)} of $${SLICE_CAP}`);
if (dry) process.exit(0);
if (kind === "openai" && worst === null) throw new Error("no price: refusing");
if (kind === "vercel") {
  if (worst === null) throw new Error("no price: refusing");
  const left = SLICE_CAP - sliceSpend();
  const bal = (await gatewayBalance()) - GATEWAY_RESERVE;
  console.log(`  gateway balance minus reserve $${bal.toFixed(4)}; slice cap left $${left.toFixed(4)}`);
  if (worst > Math.min(left, bal)) { console.error(`refused: worst case $${worst.toFixed(4)} exceeds what remains ($${Math.min(left, bal).toFixed(4)})`); process.exit(2); }
}
rmSync(join(runDir, "raw.jsonl"), { force: true });
const t0 = Date.now();
const incoming = (await pool(docs, kind === "codex" ? 5 : 8, extractDoc)).flat().sort((x, y) => x.key.localeCompare(y.key, "en", { numeric: true }));
const wall = (Date.now() - t0) / 1000;
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, "incoming.json"), JSON.stringify(incoming, null, 1) + "\n");
if (split === "dev" || split === "smoke") writeCatalog(join(runDir, "catalog"), incoming);
const failedChunks = chunkLog.filter((c) => c.extract);
const docsCovered = docs.filter((d) => !chunkLog.some((c) => c.doc === d.id && c.extract)).map((d) => d.id);
const meta = {
  runId, cand, model, structure, split, documents: docs.length, chunks, chars, records: incoming.length, records_per_doc: incoming.length / docs.length,
  ungrounded: incoming.filter((i) => !i.grounded).length,
  failed_chunks: failedChunks.length, failed_by_reason: failedChunks.reduce((m, c) => ({ ...m, [c.extract!]: (m[c.extract!] ?? 0) + 1 }), {} as Record<string, number>),
  label_failed: chunkLog.filter((c) => c.label).length, docs_complete: docsCovered, wall_s: wall, ...meter,
  label_fill: Object.fromEntries((["terms", "replaces", "requires", "prerequisites", "conditions"] as const).map((k) => [k, incoming.filter((i) => (i[k] as unknown[]).length > 0).length])),
  chunk_log: chunkLog.sort((x, y) => x.doc.localeCompare(y.doc) || x.ci - y.ci),
  evidence, diet: a.diet ?? null, addendum: a.addendum ?? null, repair: a.repair ?? null, strict: a.strict, prompt_sha: { extract: sha256(DIET(evidence === "ids" ? EXTRACT_PROMPT_IDS : EXTRACT_PROMPT)), label: sha256(LABEL_PROMPT), one_call: sha256(ONE_CALL_PROMPT), schema: sha256(SCHEMA_PROMPT) },
};
writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 1) + "\n");
console.log(JSON.stringify({ ...meta, chunk_log: undefined, docs_complete: docsCovered.length }));
console.log(`slice spend $${sliceSpend().toFixed(4)} of $${SLICE_CAP}`);
