// Slice 3d runner, arm E (PREREG.md "Slice 3d"): reasoning `none` against the production store's cached `low` answers
// on chunks under 1,000 characters, plus a fresh `low` replicate of 150 of them (the noise reference).
//
//   cd central && npx tsx ../eval/select/slice3/run3d.mts --notes <central dir with releases/, onboarding/jobs/>
//     --cache <central dir with cache/llm/> run [--limit N] | score | run-p [--cap 0.1] | score-p
//
// Arm P (packing short notes) is described above runP; its usage goes to out/slice3d/usage-p.jsonl.
//
// Prompts are rebuilt as extract.ts twoCall does (EXTRACT_PROMPT, then LABEL_PROMPT on the call's own records). A chunk
// is eligible when its cached extract answer (and, for a non-empty answer, its label answer) is found under the
// pipeline's cache key, so the prompt is byte-identical to production's. Content-free chunks are skipped, as the
// pipeline skips them (extract.ts contentFree). Sample: seed 20261017, at most 5 chunks per technology, 400 chunks;
// the replicate is the first 150 in sample order. Calls go to the gateway at flex tier (falling back to the default
// tier as llm.ts does), never through the cache. Usage: out/slice3d/usage.jsonl; every call is refused once that log
// reaches the cap (--cap, default $0.20).
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
// The cached baseline is production's Luna `low`: pin the cache key so an inherited override cannot select another one.
process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
process.env.UNSTALE_EXTRACT_EFFORT = "low";
const { chunk, contentFree, EXTRACT_PROMPT, Extracted, fill, LABEL_PROMPT, locate, strings, toIncoming } = await import("../../../central/src/pipeline/extract.ts");
const { extractCachePath, parseJson, postChat, PROVIDERS, HttpError } = await import("../../../central/src/pipeline/llm.ts");
const { keyFromEnvFile } = await import("../../../central/src/pipeline/classify/adapter.ts");
const { TECHNOLOGIES } = await import("../../../central/src/pipeline/technologies.ts");
const { pool, readJson } = await import("../../../central/src/pipeline/util.ts");
import type { Extracted as Rec, Incoming } from "../../../central/src/pipeline/extract.ts";
import type { Usage } from "../../../central/src/pipeline/llm.ts";
/** A cached answer's tokens at gpt-6-luna flex prices ($0.05 / $0.25 per million, as billed on the runs). */
const flexUsd = (u?: Usage): number => (u ? (u.input_tokens * 0.05 + u.output_tokens * 0.25) / 1e6 : 0);

const SEED = 20261017, N = 400, REP = 150, PER_TECH = 5, SHORT = 1_000, PACK_NOTE = 2_000, PACK_MAX = 8_000, P_TECHS = 60, P_PER = 5, MODEL = "openai/gpt-6-luna";
const CAP = Number(a.cap);
let USAGE = join(OUT, "usage.jsonl");

interface Chunk { key: string; tech: string; name: string; version: string; date: string; url: string; snapshot: string; notes: string; cachedExtract: string; cachedLabel?: string; cachedUsd?: number }

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

/** Every single-chunk, non-content-free note under `max` characters, in index order per technology; `ok` when its
 * cached extract answer (and, for a non-empty answer, its label answer) is found. A note of `max` or more characters
 * stays in the list (not ok) so it breaks a run of consecutive notes (arm P). */
function scan(max: number): Array<Chunk & { ok: boolean }> {
  const rel = join(a.notes!, "releases"), jobs = join(a.notes!, "onboarding", "jobs");
  const names = new Map<string, string>();
  for (const f of readdirSync(jobs)) {
    const j = JSON.parse(readFileSync(join(jobs, f), "utf8")) as { technology?: string; name?: string };
    if (j.technology && j.name) names.set(j.technology, j.name);
  }
  const out: Array<Chunk & { ok: boolean }> = [];
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
      const notes = parts[0] ?? "";
      if (parts.length === 1 && (!notes.trim() || contentFree(notes))) continue;
      const c = { key: `${id}@${r.version}`, tech: id, name, version: r.version, date: r.date, url: r.url, snapshot: r.snapshot, notes, cachedExtract: "", ok: false } as Chunk & { ok: boolean };
      out.push(c);
      if (parts.length !== 1 || notes.length >= max) continue;
      const hit = readJson<{ text: string; usage?: Usage }>(extractCachePath(extractPrompt(c)));
      const recs = hit && parseRecs(hit.text);
      if (!hit || !recs) continue;
      c.cachedExtract = hit.text;
      c.cachedUsd = flexUsd(hit.usage);
      if (recs.length) {
        const lab = readJson<{ text: string; usage?: Usage }>(extractCachePath(labelPrompt(c, recs)));
        if (!lab || !parseLabels(lab.text)) continue;
        c.cachedLabel = lab.text;
        c.cachedUsd += flexUsd(lab.usage);
      }
      c.ok = true;
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
/** Worst-case dollars of the calls in flight (16k output tokens at the default tier's $0.50 per million, input counted
 * as one token per character at $0.10), so concurrent calls cannot pass the cap together. */
let reserved = 0;

/** One call, three attempts on an unparseable answer; a truncated answer fails at once. */
async function call<T>(arm: string, step: string, key: string, effort: string, prompt: string, parse: (t: string) => T | undefined): Promise<{ v?: T; text?: string; failed?: string }> {
  const p = PROVIDERS.vercel!;
  const body = { model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 16_000, reasoning_effort: effort };
  const post = (b: Record<string, unknown>) => postChat(p, b as never, { apiKey: keyFromEnvFile(p.keyFile, p.keyVar), backoffMs: 2000, timeoutMs: 10 * 60 * 1000, retries: 4 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const worst = (prompt.length * 0.1 + 16_000 * 0.5) / 1e6;
    if (running + reserved + worst > CAP) throw new Error(`cap $${CAP} reached ($${running.toFixed(4)} spent, $${reserved.toFixed(4)} in flight)`);
    reserved += worst;
    let r;
    try {
      try {
        r = await post({ ...body, providerOptions: { gateway: { serviceTier: "flex" } } });
      } catch (e) {
        if (!(e instanceof HttpError) || (e.status !== 429 && e.status < 500)) throw e;
        r = await post(body);
      }
    } finally {
      reserved -= worst;
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

// ---- arm P: several short notes of one technology and release line per call ----
// Fixed before any arm P call (PREREG.md arm P; effort `low`, since arm E was rejected). Sample: technologies with a
// run of P_PER consecutive notes (index order, content-free notes skipped as the pipeline skips them) that are all ok,
// under PACK_NOTE characters and on one release line; P_TECHS of them by seeded shuffle, one run each at a seeded
// start. Runs are packed greedily up to PACK_MAX characters, each note under a `## Release <version> (<date>)` header.
// The extract prompt is EXTRACT_PROMPT with the versions listed and PACK_PART; the label call is LABEL_PROMPT on the
// pack's kept records and the packed text. A record belongs to the one note its quote is found in (locate); a record
// found in none or in several sends its note (the release it names, else every candidate) to a fresh single-note
// call, whose records replace that note's packed ones. Wrong version: a record whose stated release is not the note its
// quote is found in. Shared change across release lines: a sampled note one of whose cached quotes also occurs in a
// note of the same technology on another release line.
const releaseLine = (v: string) => {
  const [maj, min] = v.split(".");
  return maj === "0" ? `0.${min ?? "0"}` : maj!;
};
const header = (c: Chunk) => `## Release ${c.version} (${c.date})`;
const packText = (ns: Chunk[]) => ns.map((c) => `${header(c)}\n\n${c.notes}`).join("\n\n");
const PACK_PART = (n: number) =>
  `\nThese notes hold ${n} releases, each under its own "## Release <version> (<date>)" header. Give each record "release": the version of the release it comes from. A change listed in several releases is a record for each.`;
const packExtractPrompt = (ns: Chunk[]) =>
  fill(EXTRACT_PROMPT, { TECH: ns[0]!.name, VERSION: ns.map((c) => c.version).join(", "), DATE: `${ns[0]!.date} to ${ns.at(-1)!.date}`, PART: PACK_PART(ns.length), NOTES: packText(ns) });
const packLabelPrompt = (ns: Chunk[], recs: Rec[]) =>
  labelPrompt({ ...ns[0]!, version: ns.map((c) => c.version).join(", "), notes: packText(ns) }, recs);
const parsePack = (text: string): Array<{ r: Rec; release: string }> | undefined => {
  const v = parseJson(text, "array");
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((x) => {
    const p = Extracted.safeParse(x);
    return p.success ? [{ r: p.data, release: String((x as { release?: unknown }).release ?? "").replace(/^v/, "") }] : [];
  });
};

function packSample(list: Array<Chunk & { ok: boolean }>): { notes: Chunk[]; packs: Chunk[][] } {
  const byTech = new Map<string, Array<Chunk & { ok: boolean }>>();
  for (const c of list) byTech.set(c.tech, [...(byTech.get(c.tech) ?? []), c]);
  const starts = new Map<string, number[]>();
  for (const [t, ns] of byTech) {
    const ok = (c: Chunk & { ok: boolean }) => c.ok && c.notes.length < PACK_NOTE;
    const s: number[] = [];
    for (let i = 0; i + P_PER <= ns.length; i++) {
      const run = ns.slice(i, i + P_PER);
      if (run.every(ok) && run.every((c) => releaseLine(c.version) === releaseLine(run[0]!.version))) s.push(i);
    }
    if (s.length) starts.set(t, s);
  }
  const rnd = mulberry32(SEED + 2);
  const techs = [...starts.keys()].map((t) => ({ t, r: rnd() })).sort((x, y) => x.r - y.r).slice(0, P_TECHS).map((x) => x.t);
  const notes: Chunk[] = [], packs: Chunk[][] = [];
  for (const t of techs) {
    const s = starts.get(t)!;
    const i = s[Math.floor(rnd() * s.length)]!;
    const run = byTech.get(t)!.slice(i, i + P_PER);
    notes.push(...run);
    let cur: Chunk[] = [];
    for (const c of run) {
      if (cur.length && packText([...cur, c]).length > PACK_MAX) (packs.push(cur), (cur = []));
      cur.push(c);
    }
    packs.push(cur);
  }
  return { notes, packs };
}

interface PRow { key: string; source: "pack" | "fallback"; extract: string | null; label: string | null; failed: string | null; wrong: number; grounded: number }

async function runP(packs: Chunk[][]) {
  mkdirSync(OUT, { recursive: true });
  USAGE = join(OUT, "usage-p.jsonl");
  running = spent();
  const f = join(OUT, "pack.jsonl");
  const done = new Set(existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key as string) : []);
  const todo = packs.filter((p) => p.some((c) => !done.has(c.key))).slice(0, a.limit ? Number(a.limit) : undefined);
  console.log(`arm P: spent so far $${running.toFixed(4)}; ${todo.length} packs to do`);
  await pool(todo, Number(a.concurrency), async (ns) => {
    const pk = ns.map((c) => c.key).join("+");
    const ex = await call("pack", "extract", pk, "low", packExtractPrompt(ns), parsePack);
    const rows = new Map<string, PRow>(ns.map((c) => [c.key, { key: c.key, source: "pack", extract: "[]", label: null, failed: ex.failed ?? null, wrong: 0, grounded: 0 }]));
    const fallback = new Set<string>();
    const own = new Map<string, Array<{ r: Rec; release: string }>>(ns.map((c) => [c.key, []]));
    for (const x of ex.v ?? []) {
      const where = ns.filter((c) => locate(c.notes, (x.r.evidence ?? "").trim()).grounded);
      const named = ns.find((c) => c.version === x.release);
      if (where.length === 1) {
        own.get(where[0]!.key)!.push(x);
        rows.get(where[0]!.key)!.grounded++;
        if (named !== where[0]) rows.get(where[0]!.key)!.wrong++;
      } else for (const c of named && (where.length === 0 || where.includes(named)) ? [named] : where.length ? where : ns) fallback.add(c.key);
    }
    const kept = ns.filter((c) => !fallback.has(c.key)).flatMap((c) => own.get(c.key)!.map((x) => ({ ...x, key: c.key })));
    let labels: Record<string, unknown> | undefined;
    if (kept.length) {
      const lab = await call("pack", "label", pk, "low", packLabelPrompt(ns, kept.map((k) => k.r)), parseLabels);
      labels = lab.v;
      if (lab.failed) for (const c of ns) rows.get(c.key)!.failed ??= lab.failed;
    }
    for (const c of ns) {
      const row = rows.get(c.key)!;
      if (fallback.has(c.key)) {
        const e = await call("pack", "fallback-extract", c.key, "low", extractPrompt(c), parseRecs);
        const l = e.v?.length ? await call("pack", "fallback-label", c.key, "low", labelPrompt(c, e.v), parseLabels) : undefined;
        Object.assign(row, { source: "fallback", extract: e.text ?? null, label: l?.text ?? null, failed: e.failed ?? l?.failed ?? null });
      } else {
        const mine = kept.map((k, i) => ({ ...k, id: `r${i + 1}` })).filter((k) => k.key === c.key);
        row.extract = JSON.stringify(mine.map((k) => k.r));
        row.label = JSON.stringify(Object.fromEntries(mine.map((k, i) => [`r${i + 1}`, labels?.[k.id] ?? {}])));
      }
      appendFileSync(f, JSON.stringify(row) + "\n");
    }
  });
  console.log(`arm P: spent $${spent().toFixed(4)}`);
}

function scoreP(notes: Chunk[], packs: Chunk[][], others: Chunk[]) {
  USAGE = join(OUT, "usage-p.jsonl");
  const rows = new Map(readFileSync(join(OUT, "pack.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PRow).map((r) => [r.key, r]));
  const P = armStats(notes, rows);
  const [lo, hi] = ci(P.f1);
  // E's replicate (150 chunks under 1,000 characters) is the noise reference, as pre-registered.
  const repRows = new Map(readFileSync(join(OUT, "low_rep.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.key as string, r]));
  const R = armStats(chunks.slice(0, REP), repRows);
  const rs = [...rows.values()];
  const grounded = rs.reduce((s, r) => s + r.grounded, 0), wrong = rs.reduce((s, r) => s + r.wrong, 0);
  const fb = rs.filter((r) => r.source === "fallback").length;
  // Notes sharing a change across release lines (a cached quote of 25+ folded characters found in another line's note).
  const shared = notes.filter((c) => {
    const qs = incoming(c, c.cachedExtract, c.cachedLabel ?? null).map((r) => norm(r.quote)).filter((q) => q.length >= 25);
    return others.some((o) => o.tech === c.tech && releaseLine(o.version) !== releaseLine(c.version) && qs.some((q) => norm(o.notes).includes(q)));
  });
  const recs = (c: Chunk, ex: string | null) => (ex ? parseRecs(ex)?.length ?? 0 : 0);
  const sharedP = shared.reduce((s, c) => s + recs(c, rows.get(c.key)!.extract), 0), sharedC = shared.reduce((s, c) => s + recs(c, c.cachedExtract), 0);
  const usage = existsSync(USAGE) ? readFileSync(USAGE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const usd = usage.reduce((s, u) => s + (u.dollars ?? 0), 0), cachedUsd = notes.reduce((s, c) => s + (c.cachedUsd ?? 0), 0);
  const calls = (step: string) => usage.filter((u) => u.step === step && u.attempt === 0).length;
  console.log(`arm P: ${notes.length} notes from ${new Set(notes.map((c) => c.tech)).size} technologies in ${packs.length} packs (mean ${(notes.length / packs.length).toFixed(2)} notes, ${Math.round(mean(packs.map((p) => packText(p).length)))} characters); notes mean ${Math.round(mean(notes.map((c) => c.notes.length)))} characters`);
  console.log(`pack (${P.n}): F1 ${pct(mean(P.f1))} (CI ${pct(lo)}…${pct(hi)}); [] agreement ${pct(mean(P.emptyAgree))}; records ${P.recArm} vs cached ${P.recBase} (${((P.recArm / P.recBase - 1) * 100).toFixed(1)}%); terms Jaccard ${pct(mean(P.jac))} on ${P.jac.length} matched; failed ${P.failed} (${pct(P.failed / P.n)}%)`);
  console.log(`replicate (E, 150): F1 ${pct(mean(R.f1))}; terms Jaccard ${pct(mean(R.jac))}`);
  console.log(`wrong version ${wrong} of ${grounded} attributed records (${pct(wrong / (grounded || 1))}%); fallback notes ${fb} of ${notes.length}; shared-across-lines notes ${shared.length}: records ${sharedP} vs cached ${sharedC}`);
  console.log(`calls: extract ${calls("extract")} + label ${calls("label")} + fallback ${calls("fallback-extract")}/${calls("fallback-label")} for ${notes.length} notes; $ ${usd.toFixed(4)} vs cached single-note ${cachedUsd.toFixed(4)} at flex (${((usd / cachedUsd - 1) * 100).toFixed(1)}%)`);
  const checks = {
    f1_margin: mean(P.f1) >= mean(R.f1) - 0.03,
    f1_ci_not_wholly_below: hi >= mean(R.f1),
    records_within_10pct: Math.abs(P.recArm / P.recBase - 1) <= 0.1,
    terms_jaccard: mean(P.jac) >= mean(R.jac) - 0.05,
    parse_failures: P.failed / P.n <= 0.02,
    wrong_version: wrong / (grounded || 1) <= 0.01,
    shared_no_fall: sharedP >= sharedC,
  };
  console.log(checks, Object.values(checks).every(Boolean) ? "ADOPT" : "REJECT");
}

const notesAll = scan(PACK_NOTE);
const all = notesAll.filter((c) => c.ok && c.notes.length < SHORT);
const chunks = sample(all);
console.log(`eligible ${all.length}; sample ${chunks.length} from ${new Set(chunks.map((c) => c.tech)).size} technologies; mean ${Math.round(mean(chunks.map((c) => c.notes.length)))} characters`);
const P = packSample(notesAll);
if (positionals[0] === "run") await run(chunks);
else if (positionals[0] === "score") score(chunks);
else if (positionals[0] === "run-p") await runP(P.packs);
else if (positionals[0] === "score-p") scoreP(P.notes, P.packs, notesAll);
else console.log(`arm P sample: ${P.notes.length} notes, ${new Set(P.notes.map((c) => c.tech)).size} technologies, ${P.packs.length} packs`);
