// Slice 12 runner (PREREG.md): one arm over the held-out release notes (set.json), through this branch's production
// code: extractRelease (steps A+B), the pipeline's classifier for labels (D), and the same-or-new judge (E) against the
// technology's record store as it stood before the release.
//
//   cd central && npx tsx ../eval/select/slice12/run12.mts --state <restored store>/central --arm base|rep|mm
//       [--cap 2] [--jev-cap 0.5] [--concurrency 6]
//
// Arms:
//   base  production's answers: steps A+B from the state's model cache (gateway refused) and D from its classifier
//         cache (both read through links in the arm's directory; a label the cache lacks is asked of Jev). E is asked
//         fresh, with the arm's own judge cache, as for the other arms.
//   rep   a fresh gpt-6-luna replicate (UNSTALE_RELEASE_MODEL=none, low, flex, empty caches): the noise reference.
//   mm    the design: release notes to MiniMax M3.1 Flash on slice 11's frozen r3 prompt, gpt-6-luna after it
//         (llm.ts releaseModels), empty caches.
// D: every record is labelled with labelQuestions() (interpret). E: retrieve + matchRequest over the technology's
// production store with this release's evidence removed (records it created dropped, records it joined kept without
// it), the judge's answer through pick (match.ts ingest without the store update); outcome = the chosen record id or
// "new". Records are judged independently (records of one release never match each other: same snapshot).
// Output: out/slice12/<arm>/releases.jsonl. Usage: out/slice12/<arm>/central/usage.jsonl. Every gateway call is refused
// once slice 12's gateway spend (all arms' logs, provider cost) plus the worst case in flight would pass --cap; Jev
// likewise against --jev-cap at $0.042 per million input tokens.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a } = parseArgs({
  options: { state: { type: "string" }, arm: { type: "string" }, cap: { type: "string", default: "2" }, "jev-cap": { type: "string", default: "0.5" }, concurrency: { type: "string", default: "6" } },
});
const ARM = a.arm!, STATE = a.state!;
if (!["base", "rep", "mm"].includes(ARM)) throw new Error("--arm base|rep|mm");
const OUT = join(SELECT, "out", "slice12");
const ARM_DIR = join(OUT, ARM);
const CENTRAL = join(ARM_DIR, "central");
mkdirSync(join(CENTRAL, "cache"), { recursive: true });
if (ARM === "base")
  for (const c of ["llm", "classifier"]) if (!existsSync(join(CENTRAL, "cache", c))) symlinkSync(join(STATE, "cache", c), join(CENTRAL, "cache", c));
process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
process.env.UNSTALE_EXTRACT_EFFORT = "low";
process.env.UNSTALE_EXTRACT_SERVICE_TIER = "flex";
if (ARM === "mm") delete process.env.UNSTALE_RELEASE_MODEL;
else process.env.UNSTALE_RELEASE_MODEL = "none";
for (const k of ["UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET", "UNSTALE_GUIDE_SHARED"]) delete process.env[k];
process.env.UNSTALE_RELEASE_CONCURRENCY ??= "40";

const { loadTechnologies } = await import("../slice6/common.mts");
const { extractRelease } = await import("../../../central/src/pipeline/extract.ts");
const { releaseModels, llmStats } = await import("../../../central/src/pipeline/llm.ts");
const { fetchReleases } = await import("../../../central/src/pipeline/fetch.ts");
const { interpret, labelQuestions, recordState } = await import("../../../central/src/pipeline/classify/labels.ts");
const { makeClassifier } = await import("../../../central/src/pipeline/pipeline.ts");
const { ChatClassifier, ClassifierCache, FallbackClassifier, Jev } = await import("../../../central/src/pipeline/classify/adapter.ts");
const { matchRequest, pick, retrieve, kindOf } = await import("../../../central/src/pipeline/match.ts");
const { techLocal } = await import("../../../central/src/state/client.ts");
const { pool, withUsagePhase } = await import("../../../central/src/pipeline/util.ts");
import type { TechStore } from "../../../central/src/pipeline/store.ts";
import type { ReleaseNote } from "../../../central/src/pipeline/fetch.ts";

// ---- spend guard (slice 6's)
const CAP = Number(a.cap), JEV_CAP = Number(a["jev-cap"]);
const JEV_IN = 0.042 / 1e6;
function logs(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "cache") walk(join(d, e.name));
      else if (e.name === "usage.jsonl") out.push(join(d, e.name));
    }
  };
  walk(OUT);
  return out;
}
function spent(): { gateway: number; jev: number } {
  let gateway = 0, jev = 0;
  for (const f of logs())
    for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      const u = JSON.parse(l) as { api?: string; dollars?: number; input_tokens?: number };
      if (u.api === "vercel") gateway += u.dollars ?? 0;
      if (u.api === "jev") jev += (u.input_tokens ?? 0) * JEV_IN;
    }
  return { gateway, jev };
}
const reserved = { gateway: 0, jev: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = typeof init?.body === "string" ? init.body : "";
  const kind = url.includes("ai-gateway.vercel.sh") ? "gateway" : url.includes("typesafe.ai") ? "jev" : undefined;
  if (!kind) throw new Error(`slice 12: unexpected request to ${url}`);
  const free = kind === "gateway" && /"model":"minimax\//.test(body);
  if (ARM === "base" && kind === "gateway" && /"content":"You (extract change records|write search terms)/.test(body))
    throw new Error("slice 12: base arm extraction must come from the cache");
  // Worst case: gateway input one token per character at gpt-6-luna's default tier ($0.10/M), 16k output at $0.50/M; Jev chars/3.
  const worst = free ? 0 : kind === "gateway" ? (body.length * 0.1 + 16_000 * 0.5) / 1e6 : (body.length / 3) * JEV_IN;
  const s = spent();
  if (s[kind] + reserved[kind] + worst > (kind === "gateway" ? CAP : JEV_CAP)) throw new Error(`slice 12: ${kind} cap reached ($${s[kind].toFixed(4)} spent)`);
  reserved[kind] += worst;
  try {
    return await realFetch(input, init);
  } finally {
    reserved[kind] -= worst;
  }
}) as typeof fetch;

// ---- the set, read from the state; then the arm's own directory
const SET = JSON.parse(readFileSync(join(import.meta.dirname, "set.json"), "utf8")) as { releases: Array<{ tech: string; version: string; stratum: string }> };
process.env.UNSTALE_CENTRAL_DIR = STATE;
const techs = loadTechnologies(join(STATE, "onboarding", "jobs"));
const items: Array<{ stratum: string; tech: ReturnType<typeof techs.get> & object; note: ReleaseNote; store: TechStore }> = [];
const notesByTech = new Map<string, ReleaseNote[]>();
for (const r of SET.releases) {
  const t = techs.get(r.tech);
  if (!t) throw new Error(`${r.tech}: unknown technology`);
  if (!notesByTech.has(t.id)) notesByTech.set(t.id, (await fetchReleases(t, { offline: true })).notes);
  const note = notesByTech.get(t.id)!.find((n) => n.version === r.version);
  if (!note) throw new Error(`${r.tech} ${r.version}: no release note in the state`);
  const sp = join(STATE, "records", `${techLocal(t.id)}.json`);
  const store = (existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : { technology: t.id, records: {}, ingested: {} }) as TechStore;
  // The store before this release: its evidence removed, records it alone made dropped.
  for (const [id, rec] of Object.entries(store.records)) {
    const ev = rec.evidence.filter((e) => e.snapshot !== note.snapshot);
    if (!ev.length) delete store.records[id];
    else if (ev.length !== rec.evidence.length) store.records[id] = { ...rec, evidence: ev };
  }
  items.push({ stratum: r.stratum, tech: t, note, store });
}
process.env.UNSTALE_CENTRAL_DIR = CENTRAL;

const cls = makeClassifier();
const judge = new FallbackClassifier(new Jev(), new ChatClassifier(), new ClassifierCache(join(ARM_DIR, "judge-cache")));
const outFile = join(ARM_DIR, "releases.jsonl");
const done = new Set(existsSync(outFile) ? readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => { const x = JSON.parse(l); return `${x.tech}\t${x.version}`; }) : []);
const t0 = Date.now();
console.log(`slice 12 ${ARM}: ${items.length} releases (${done.size} done); release models ${releaseModels().map((m) => m.model).join(" → ")}; spent so far ${JSON.stringify(spent())}`);
await pool(items, Number(a.concurrency), async (it) => {
  if (done.has(`${it.tech.id}\t${it.note.version}`)) return;
  const row = await withUsagePhase("other", `${it.tech.id}@${it.note.version}`, async () => {
    const r = await extractRelease(it.tech, it.note);
    const records = Object.values(it.store.records);
    const out = await pool(r.incoming, 4, async (inc) => {
      let labels = null, e = null, err: string | undefined;
      try {
        const l = interpret(await cls.classify(recordState(it.tech.name, inc), labelQuestions()));
        labels = { change_type: l.change_type, surface: l.surface, breaking: l.breaking, benefit: l.benefit };
        const found = retrieve(inc, records);
        const cands = found.map((c) => it.store.records[c.id]!);
        if (!cands.length) e = { outcome: "new", candidates: 0, asked: false };
        else {
          const req = matchRequest(it.tech.name, inc, l.breaking, cands, found.map((c) => c.score));
          const asked = Object.keys(req.questions).length > 0;
          const verdict = asked ? await judge.classify(req.state, req.questions) : { answers: {}, calibrated: true };
          const chosen = pick(cands, verdict.answers, { breaking: l.breaking, quote: inc.quote, summary: inc.summary, kind: kindOf(inc), url: inc.url, snapshot: inc.snapshot, version: inc.version }, (verdict as { calibrated?: boolean }).calibrated !== false);
          e = { outcome: chosen.id ?? "new", p: chosen.p ?? null, candidates: cands.length, asked };
        }
      } catch (x) {
        err = (x as Error).message;
      }
      return { ...inc, labels, e, ...(err ? { error: err } : {}) };
    });
    return { tech: it.tech.id, name: it.tech.name, version: it.note.version, stratum: it.stratum, failed: r.failed, incoming: out };
  });
  appendFileSync(outFile, JSON.stringify(row) + "\n");
  const errs = row.incoming.filter((i) => "error" in i).length;
  console.log(`${row.tech} ${row.version}: ${row.incoming.length} records${row.failed ? `, ${row.failed} failed` : ""}${errs ? `, ${errs} D/E errors` : ""}`);
});
writeFileSync(join(ARM_DIR, "meta.json"), JSON.stringify({ arm: ARM, wall_s: (Date.now() - t0) / 1000, spent_after: spent(), llm: llmStats, at: new Date().toISOString() }, null, 1) + "\n");
console.log(`done; ${JSON.stringify(llmStats)}; slice spend ${JSON.stringify(spent())}`);
