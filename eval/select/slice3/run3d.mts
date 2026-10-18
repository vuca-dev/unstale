// Slice 3d runner, arm E (PREREG.md "Slice 3d"): reasoning `none` against the production store's cached `low` answers
// on chunks under 1,000 characters, plus a fresh `low` replicate of 150 of them (the noise reference).
//
//   cd central && npx tsx ../eval/select/slice3/run3d.mts --notes <central dir with releases/, onboarding/jobs/>
//     --cache <central dir with cache/llm/> run [--limit N] | score
//
// Prompts are rebuilt as extract.ts twoCall does (EXTRACT_PROMPT, then LABEL_PROMPT on the call's own records). A chunk
// is eligible when its cached extract answer (and, for a non-empty answer, its label answer) is found under the
// pipeline's cache key, so the prompt is byte-identical to production's. Content-free chunks are skipped, as the
// pipeline skips them (extract.ts contentFree). Sample: seed 20261017, at most 5 chunks per technology, 400 chunks;
// the replicate is the first 150 in sample order. Calls go to the gateway at flex tier (falling back to the default
// tier as llm.ts does), never through the cache. Usage: out/slice3d/usage.jsonl; every call is refused once that log
// reaches the cap ($0.20).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { notes: { type: "string" }, cache: { type: "string" }, limit: { type: "string" }, cap: { type: "string", default: "0.2" }, concurrency: { type: "string", default: "5" } },
});
const OUT = join(SELECT, "out", "slice3d");
process.env.UNSTALE_CENTRAL_DIR = a.cache!;
const { chunk, contentFree, EXTRACT_PROMPT, Extracted, fill, LABEL_PROMPT, strings, toIncoming } = await import("../../../central/src/pipeline/extract.ts");
const { extractCachePath, parseJson, postChat, PROVIDERS, HttpError } = await import("../../../central/src/pipeline/llm.ts");
const { keyFromEnvFile } = await import("../../../central/src/pipeline/classify/adapter.ts");
const { TECHNOLOGIES } = await import("../../../central/src/pipeline/technologies.ts");
const { pool, readJson } = await import("../../../central/src/pipeline/util.ts");
import type { Extracted as Rec, Incoming } from "../../../central/src/pipeline/extract.ts";

const SEED = 20261017, N = 400, REP = 150, PER_TECH = 5, SHORT = 1_000, MODEL = "openai/gpt-6-luna";
const CAP = Number(a.cap);
const USAGE = join(OUT, "usage.jsonl");

interface Chunk { key: string; tech: string; name: string; version: string; date: string; url: string; snapshot: string; notes: string; cachedExtract: string; cachedLabel?: string }

function mulberry32(s: number) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const parseRecs = (text: string): Rec[] | undefined => {
  const v = parseJson(text, "array");
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((r) => {
    const p = Extracted.safeParse(r);
    return p.success ? [p.data] : [];
  });
};
const parseLabels = (text: string): Record<string, unknown> | undefined => {
  const v = parseJson(text, "object");
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
};
const extractPrompt = (c: Pick<Chunk, "name" | "version" | "date" | "notes">) => fill(EXTRACT_PROMPT, { TECH: c.name, VERSION: c.version, DATE: c.date, PART: "", NOTES: c.notes });
function labelPrompt(c: Chunk, recs: Rec[]): string {
  const brief = recs.map((r, i) => ({ id: `r${i + 1}`, subject: r.subject, facet: r.facet ?? null, change_type: r.change_type ?? null, summary: r.summary, introduces: strings(r.introduces, 20), evidence: r.evidence ?? "" }));
  return fill(LABEL_PROMPT, { TECH: c.name, VERSION: c.version, RECORDS: JSON.stringify(brief, null, 1), NOTES: c.notes });
}

/** Every eligible chunk (cached `low` answer found, under SHORT characters, single-chunk note, not content-free). */
function eligible(): Chunk[] {
  const rel = join(a.notes!, "releases"), jobs = join(a.notes!, "onboarding", "jobs");
  const names = new Map<string, string>();
  for (const f of readdirSync(jobs)) {
    const j = JSON.parse(readFileSync(join(jobs, f), "utf8")) as { technology?: string; name?: string };
    if (j.technology && j.name) names.set(j.technology, j.name);
  }
  const out: Chunk[] = [];
  for (const id of readdirSync(rel).sort()) {
    const ip = join(rel, id, "index.json");
    if (!existsSync(ip)) continue;
    const builtin = Object.values(TECHNOLOGIES).find((t) => t.id === id);
    const name = builtin?.name ?? names.get(id);
    if (!name) continue;
    const clean = builtin?.clean ?? ((b: string) => b.replace(/\n#+\s*Credits[\s\S]*$/, ""));
    const idx = JSON.parse(readFileSync(ip, "utf8")) as { releases: Array<{ version: string; date: string; url: string; snapshot: string }> };
    for (const r of idx.releases) {
      const bp = join(rel, id, `${r.version}.md`);
      if (!existsSync(bp)) continue;
      const parts = chunk(clean(readFileSync(bp, "utf8")));
      if (parts.length !== 1) continue;
      const notes = parts[0]!;
      if (notes.length >= SHORT || !notes.trim() || contentFree(notes)) continue;
      const c = { key: `${id}@${r.version}`, tech: id, name, version: r.version, date: r.date, url: r.url, snapshot: r.snapshot, notes, cachedExtract: "" } as Chunk;
      const hit = readJson<{ text: string }>(extractCachePath(extractPrompt(c)));
      const recs = hit && parseRecs(hit.text);
      if (!hit || !recs) continue;
      c.cachedExtract = hit.text;
      if (recs.length) {
        const lab = readJson<{ text: string }>(extractCachePath(labelPrompt(c, recs)));
        if (!lab || !parseLabels(lab.text)) continue;
        c.cachedLabel = lab.text;
      }
      out.push(c);
    }
  }
  return out;
}

function sample(all: Chunk[]): Chunk[] {
  const rnd = mulberry32(SEED);
  const order = all.map((c) => ({ c, r: rnd() })).sort((x, y) => x.r - y.r).map((x) => x.c);
  const per = new Map<string, number>();
  const out: Chunk[] = [];
  for (const c of order) {
    if (out.length >= N) break;
    if ((per.get(c.tech) ?? 0) >= PER_TECH) continue;
    per.set(c.tech, (per.get(c.tech) ?? 0) + 1);
    out.push(c);
  }
  return out;
}

const spent = (): number => (existsSync(USAGE) ? readFileSync(USAGE, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (Number(JSON.parse(l).dollars) || 0), 0) : 0);
let running = 0;

/** One call, three attempts on an unparseable answer; a truncated answer fails at once. */
async function call<T>(arm: string, step: string, key: string, effort: string, prompt: string, parse: (t: string) => T | undefined): Promise<{ v?: T; text?: string; failed?: string }> {
  const p = PROVIDERS.vercel!;
  const body = { model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 16_000, reasoning_effort: effort };
  const post = (b: Record<string, unknown>) => postChat(p, b as never, { apiKey: keyFromEnvFile(p.keyFile, p.keyVar), backoffMs: 2000, timeoutMs: 10 * 60 * 1000, retries: 4 });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (running + 0.002 > CAP) throw new Error(`cap $${CAP} reached ($${running.toFixed(4)})`);
    let r;
    try {
      r = await post({ ...body, providerOptions: { gateway: { serviceTier: "flex" } } });
    } catch (e) {
      if (!(e instanceof HttpError) || (e.status !== 429 && e.status < 500)) throw e;
      r = await post(body);
    }
    running += r.cost ?? 0;
    appendFileSync(USAGE, JSON.stringify({ arm, step, key, effort, attempt, ...r.usage, dollars: r.cost ?? null, finish: r.finish, at: new Date().toISOString() }) + "\n");
    if (r.finish === "length") return { failed: "length", text: r.text };
    const v = parse(r.text);
    if (v !== undefined) return { v, text: r.text };
  }
  return { failed: "unparseable" };
}

async function run(chunks: Chunk[]) {
  mkdirSync(OUT, { recursive: true });
  running = spent();
  const jobs = [...chunks.slice(0, REP).map((c) => ({ c, arm: "low_rep", effort: "low" })), ...chunks.map((c) => ({ c, arm: "none", effort: "none" }))];
  const done = new Set<string>();
  for (const arm of ["low_rep", "none"]) {
    const f = join(OUT, `${arm}.jsonl`);
    if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) done.add(`${arm}\t${JSON.parse(l).key}`);
  }
  const todo = jobs.filter((j) => !done.has(`${j.arm}\t${j.c.key}`)).slice(0, a.limit ? Number(a.limit) : undefined);
  console.log(`spent so far $${running.toFixed(4)}; ${todo.length} chunk runs to do`);
  await pool(todo, Number(a.concurrency), async ({ c, arm, effort }) => {
    const ex = await call(arm, "extract", c.key, effort, extractPrompt(c), parseRecs);
    let lab: { v?: Record<string, unknown>; text?: string; failed?: string } | undefined;
    if (ex.v?.length) lab = await call(arm, "label", c.key, effort, labelPrompt(c, ex.v), parseLabels);
    appendFileSync(join(OUT, `${arm}.jsonl`), JSON.stringify({ key: c.key, extract: ex.text ?? null, label: lab?.text ?? null, failed: ex.failed ?? lab?.failed ?? null }) + "\n");
  });
  console.log(`spent $${spent().toFixed(4)}`);
}

// ---- scoring ----
const norm = (s: string): string => s.replace(/[`*_\\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

function incoming(c: Chunk, extract: string | null, label: string | null): Incoming[] {
  const recs = extract ? parseRecs(extract) ?? [] : [];
  const labels = label ? parseLabels(label) : undefined;
  const t = { id: c.tech, name: c.name } as never;
  const rel = { version: c.version, date: c.date, url: c.url, snapshot: c.snapshot, notes: c.notes } as never;
  return recs.map((r, i) => toIncoming(t, rel, 0, i, r, labels?.[`r${i + 1}`], c.notes));
}

/** Records matched one to one: grounded quotes whose spans in the folded notes overlap, else the same subject. */
function match(notes: string, xs: Incoming[], ys: Incoming[]): Array<[Incoming, Incoming]> {
  const n = norm(notes);
  const span = (r: Incoming): [number, number] | undefined => {
    const q = norm(r.quote);
    const i = q ? n.indexOf(q) : -1;
    return r.grounded && i >= 0 ? [i, i + q.length] : undefined;
  };
  const used = new Set<number>();
  const pairs: Array<[Incoming, Incoming]> = [];
  const left: Incoming[] = [];
  for (const x of xs) {
    const sx = span(x);
    const j = sx ? ys.findIndex((y, k) => !used.has(k) && ((s) => !!s && s[0] < sx[1] && sx[0] < s[1])(span(y))) : -1;
    if (j >= 0) (used.add(j), pairs.push([x, ys[j]!]));
    else left.push(x);
  }
  for (const x of left) {
    const j = ys.findIndex((y, k) => !used.has(k) && y.subject.toLowerCase() === x.subject.toLowerCase());
    if (j >= 0) (used.add(j), pairs.push([x, ys[j]!]));
  }
  return pairs;
}

const jaccard = (a: string[], b: string[]) => {
  const A = new Set(a.map((s) => s.toLowerCase())), B = new Set(b.map((s) => s.toLowerCase()));
  const u = new Set([...A, ...B]).size;
  return u ? [...A].filter((x) => B.has(x)).length / u : 1;
};
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
function ci(v: number[], reps = 2000): [number, number] {
  const rnd = mulberry32(SEED + 1), m: number[] = [];
  for (let b = 0; b < reps; b++) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[Math.floor(rnd() * v.length)]!;
    m.push(s / v.length);
  }
  m.sort((x, y) => x - y);
  return [m[Math.floor(0.025 * reps)]!, m[Math.floor(0.975 * reps)]!];
}
const pct = (x: number) => (100 * x).toFixed(1);

function armStats(chunks: Chunk[], rows: Map<string, { extract: string | null; label: string | null; failed: string | null }>) {
  const f1: number[] = [], emptyAgree: number[] = [], jac: number[] = [];
  let recArm = 0, recBase = 0, failed = 0;
  const nonEmpty = { requires: 0, replaces: 0, conditions: 0, n: 0 }, baseNonEmpty = { requires: 0, replaces: 0, conditions: 0, n: 0 };
  for (const c of chunks) {
    const r = rows.get(c.key)!;
    if (r.failed) failed++;
    const xs = incoming(c, r.extract, r.label), ys = incoming(c, c.cachedExtract, c.cachedLabel ?? null);
    recArm += xs.length;
    recBase += ys.length;
    const m = match(c.notes, xs, ys);
    f1.push(xs.length + ys.length ? (2 * m.length) / (xs.length + ys.length) : 1);
    emptyAgree.push(Number(!xs.length === !ys.length));
    for (const [x, y] of m) jac.push(jaccard(x.terms, y.terms));
    for (const [acc, rs] of [[nonEmpty, xs], [baseNonEmpty, ys]] as const)
      for (const x of rs) {
        acc.n++;
        acc.requires += Number(x.requires.length > 0);
        acc.replaces += Number(x.replaces.length > 0);
        acc.conditions += Number(x.conditions.length > 0);
      }
  }
  return { n: chunks.length, f1, emptyAgree, jac, recArm, recBase, failed, nonEmpty, baseNonEmpty };
}

function score(chunks: Chunk[]) {
  const load = (arm: string) => new Map(readFileSync(join(OUT, `${arm}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.key as string, r]));
  const none = load("none"), rep = load("low_rep");
  const repChunks = chunks.slice(0, REP);
  const N_ = armStats(chunks, none), R = armStats(repChunks, rep), N150 = armStats(repChunks, none);
  const usage = readFileSync(USAGE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const usd = (arm: string, keys: Set<string>) => usage.filter((u) => u.arm === arm && keys.has(u.key)).reduce((s, u) => s + (u.dollars ?? 0), 0);
  const k150 = new Set(repChunks.map((c) => c.key));
  const line = (name: string, s: ReturnType<typeof armStats>) => {
    const [lo, hi] = ci(s.f1);
    const rate = (o: typeof s.nonEmpty) => `req ${pct(o.requires / o.n)} / repl ${pct(o.replaces / o.n)} / cond ${pct(o.conditions / o.n)}`;
    return `${name}: n=${s.n} F1 ${pct(mean(s.f1))} (CI ${pct(lo)}…${pct(hi)}); [] agreement ${pct(mean(s.emptyAgree))}; records ${s.recArm} vs cached ${s.recBase} (${((s.recArm / s.recBase - 1) * 100).toFixed(1)}%); terms Jaccard ${pct(mean(s.jac))} on ${s.jac.length} matched; failed ${s.failed} (${pct(s.failed / s.n)}%); non-empty arm ${rate(s.nonEmpty)}; cached ${rate(s.baseNonEmpty)}`;
  };
  console.log(line("none (400)", N_));
  console.log(line("low replicate (150)", R));
  console.log(line("none on the replicate's 150", N150));
  const d = N150.f1.map((x, i) => x - R.f1[i]!);
  const [dlo, dhi] = ci(d);
  console.log(`paired F1 none − replicate on 150: ${pct(mean(d))} (CI ${pct(dlo)}…${pct(dhi)})`);
  console.log(`$ on the 150: none ${usd("none", k150).toFixed(4)}, low ${usd("low_rep", k150).toFixed(4)} (${((usd("none", k150) / usd("low_rep", k150) - 1) * 100).toFixed(1)}%); none all ${usd("none", new Set(chunks.map((c) => c.key))).toFixed(4)}; log total ${spent().toFixed(4)}`);
  const f1N = mean(N_.f1), f1R = mean(R.f1), [, nHi] = ci(N_.f1);
  const checks = {
    f1_margin: f1N >= f1R - 0.03,
    f1_ci_not_wholly_below: nHi >= f1R,
    records_within_10pct: Math.abs(N_.recArm / N_.recBase - 1) <= 0.1,
    terms_jaccard: mean(N_.jac) >= mean(R.jac) - 0.05,
    parse_failures: N_.failed / N_.n <= 0.02,
  };
  console.log(checks, Object.values(checks).every(Boolean) ? "ADOPT" : "REJECT");
}

const all = eligible();
const chunks = sample(all);
console.log(`eligible ${all.length}; sample ${chunks.length} from ${new Set(chunks.map((c) => c.tech)).size} technologies; mean ${Math.round(mean(chunks.map((c) => c.notes.length)))} characters`);
if (positionals[0] === "run") await run(chunks);
else if (positionals[0] === "score") score(chunks);
