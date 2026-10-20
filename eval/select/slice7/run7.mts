// Slice 7 runner (PREREG.md): a Jev relevance question per (record, package) over a shared guide's neutral records.
//
//   cd central && npx tsx ../eval/select/slice7/run7.mts --state <central dir> --split dev|heldout|heldout-aisdk|gold
//       --arm jev-r0|jev-r1|… [--cap 3] [--jev-cap 0.5] [--concurrency 8]
//   (gold first needs --arm shared-all: the neutral extraction of the three guides, from slice 6's gold cache)
//
// Input: slice 6's `shared-all` pairs (the shared neutral extraction, labelled once per record, every package keeping
// every record) for the split's units; for gold, this slice's own `shared-all` (which needs slice 6's design.patch
// applied, as run6.mts did). For each pair and record the pipeline's classifier (Jev, chat fallback) answers
// relevance.mts's question for the revision; the record is kept when p(yes) >= the revision's threshold. A failed
// question drops the record and counts as a failed call for the pair.
// Output: out/slice7/<split>/<arm>/pairs.jsonl (the kept records, as run6.mts writes them) and probs.jsonl. Spend guard
// as run6.mts, over this slice's own usage logs.
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a } = parseArgs({
  options: {
    state: { type: "string" },
    split: { type: "string" },
    arm: { type: "string" },
    cap: { type: "string", default: "3" },
    "jev-cap": { type: "string", default: "0.5" },
    concurrency: { type: "string", default: "8" },
  },
});
const ARM = a.arm!, SPLIT = a.split!;
if (!["dev", "heldout", "heldout-aisdk", "gold"].includes(SPLIT)) throw new Error("--split dev|heldout|heldout-aisdk|gold");
const REV = ARM.startsWith("jev-") ? ARM.slice(4) : undefined;
if (!REV && !(ARM === "shared-all" && SPLIT === "gold")) throw new Error("--arm jev-<rev> (or shared-all on gold)");
const OUT = join(SELECT, "out", "slice7");
const S6 = join(SELECT, "out", "slice6");
const ARM_DIR = join(OUT, SPLIT, ARM);
mkdirSync(ARM_DIR, { recursive: true });
process.env.UNSTALE_CENTRAL_DIR = join(ARM_DIR, "central");
process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
process.env.UNSTALE_EXTRACT_EFFORT = "low";
process.env.UNSTALE_EXTRACT_SERVICE_TIER = "flex";
process.env.UNSTALE_GUIDE_SHARED = "1";
for (const k of ["UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET"]) delete process.env[k];

const { loadTechnologies, sharedUnits } = await import("../slice6/common.mts");
const { makeClassifier } = await import("../../../central/src/pipeline/pipeline.ts");
const { pool, withUsagePhase } = await import("../../../central/src/pipeline/util.ts");
const R = await import("./relevance.mts");
import type { Technology } from "../../../central/src/pipeline/technologies.ts";
import type { GuideNote } from "../../../central/src/pipeline/fetch.ts";
import type { Incoming } from "../../../central/src/pipeline/extract.ts";

const SPLITS = JSON.parse(readFileSync(join(import.meta.dirname, "splits.json"), "utf8")) as Record<string, string[]>;

// ---- spend guard (this slice's logs only)
const CAP = Number(a.cap), JEV_CAP = Number(a["jev-cap"]);
const JEV_IN = 0.042 / 1e6;
function logs(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
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
  if (!kind) throw new Error(`slice 7: unexpected request to ${url}`);
  if (kind === "gateway") {
    const prompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0]!.content;
    // Gold's neutral extraction: every package keeps every record (the relevance question then decides).
    if (prompt.startsWith("You decide which change records")) {
      const ids = [...prompt.matchAll(/"id": "(r\d+)"/g)].map((m) => m[1]);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ids) }, finish_reason: "stop" }] }), { status: 200 });
    }
  }
  const worst = kind === "gateway" ? (body.length * 0.1 + 16_000 * 0.5) / 1e6 : (body.length / 3) * JEV_IN;
  const s = spent();
  if (s[kind] + reserved[kind] + worst > (kind === "gateway" ? CAP : JEV_CAP)) throw new Error(`slice 7: ${kind} cap reached ($${s[kind].toFixed(4)} spent)`);
  reserved[kind] += worst;
  try {
    return await realFetch(input, init);
  } finally {
    reserved[kind] -= worst;
  }
}) as typeof fetch;

// ---- the split's pairs
type Rec = Incoming & { labels: unknown };
interface Row { unit: string; tech: string; name: string; failed: number; incoming: Rec[] }
interface Pair { unit: string; tech: Technology; note: GuideNote }
const H2 = join(SELECT, "holdout-majors", "extraction");
let pairs: Pair[];
if (SPLIT === "gold") {
  const man = JSON.parse(readFileSync(join(H2, "notes.json"), "utf8")) as { notes: Array<{ note_file: string; technology: string; ecosystem: string; kind: string; version: string; date: string; url: string }> };
  pairs = man.notes
    .filter((n) => n.kind === "guide")
    .map((n) => ({
      unit: n.note_file,
      tech: { id: n.technology, name: n.technology, repo: "", components: [`pkg:${n.ecosystem}/${n.technology.replace("@", "%40")}`], tag: /^$/, clean: (b: string) => b },
      note: { technology: n.technology, kind: "upgrade_guide", tag: "guide", version: n.version, date: n.date, url: n.url, snapshot: "", keyTag: "+guide.h2", notes: readFileSync(join(H2, "notes", n.note_file), "utf8") } as unknown as GuideNote,
    }));
} else {
  const techs = loadTechnologies(join(a.state!, "onboarding", "jobs"));
  const units = sharedUnits(join(a.state!, "guides"), techs).filter((u) => SPLITS[SPLIT]!.some((p) => u.url.startsWith(p)));
  pairs = units.flatMap((u) => u.members.map((m) => ({ unit: u.id, tech: m.tech, note: m.note })));
}

const outFile = join(ARM_DIR, "pairs.jsonl");
const done = new Set(existsSync(outFile) ? readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => { const x = JSON.parse(l); return `${x.unit}\t${x.tech}`; }) : []);
const cls = makeClassifier();
const t0 = Date.now();
console.log(`slice 7 ${SPLIT}/${ARM}: ${pairs.length} pairs (${done.size} done); slice spend so far ${JSON.stringify(spent())}`);

if (ARM === "shared-all") {
  // Gold only: the neutral extraction and labels, answered from slice 6's gold cache (same prompts, same records).
  const cache = join(ARM_DIR, "central", "cache");
  if (!existsSync(cache)) cpSync(join(S6, "gold", "shared", "central", "cache"), cache, { recursive: true });
  const { extractRelease } = await import("../../../central/src/pipeline/extract.ts");
  const { interpret, labelQuestions, recordState } = await import("../../../central/src/pipeline/classify/labels.ts");
  for (const p of pairs) {
    if (done.has(`${p.unit}\t${p.tech.id}`)) continue;
    const r = await extractRelease(p.tech, p.note);
    const incoming = await pool(r.incoming, 4, async (inc) => {
      const l = interpret(await cls.classify(recordState(p.tech.name, inc), labelQuestions()));
      return { ...inc, labels: { change_type: l.change_type, surface: l.surface, breaking: l.breaking, benefit: l.benefit } };
    });
    appendFileSync(outFile, JSON.stringify({ unit: p.unit, tech: p.tech.id, name: p.tech.name, failed: r.failed, incoming }) + "\n");
    console.log(`${p.unit} | ${p.tech.id}: ${incoming.length} records`);
  }
} else {
  const src = new Map<string, Row>();
  const files = SPLIT === "gold" ? [join(OUT, "gold", "shared-all", "pairs.jsonl")] : [join(S6, "dev", "shared-all", "pairs.jsonl"), join(S6, "heldout", "shared-all", "pairs.jsonl")];
  for (const f of files) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as Row;
    src.set(`${r.unit}\t${r.tech}`, r);
  }
  const rev = REV as (typeof R.REVISIONS)[number];
  if (!R.REVISIONS.includes(rev)) throw new Error(`unknown revision ${rev}`);
  const T = R.THRESHOLD[rev];
  const ask = (state: Record<string, unknown>, q: Parameters<typeof cls.classify>[1]) => cls.classify(state, q);
  // r2's per-guide judgments, asked once per unit (on the unit's first package's records: the shared extraction gives
  // every package the same records).
  const unitMemo = new Map<string, Promise<Set<string>>>();
  const backendParts = (p: Pair) => () => {
    if (!unitMemo.has(p.unit)) {
      const first = pairs.find((q) => q.unit === p.unit)!;
      const recs = src.get(`${first.unit}\t${first.tech.id}`)!.incoming;
      unitMemo.set(p.unit, withUsagePhase("other", `${p.unit}|*`, () => R.unitParts(ask, first.note.url, first.note.version, first.note.notes, recs, pool)));
    }
    return unitMemo.get(p.unit)!;
  };
  await pool(pairs, Number(a.concurrency), async (p) => {
    if (done.has(`${p.unit}\t${p.tech.id}`)) return;
    const row = src.get(`${p.unit}\t${p.tech.id}`);
    if (!row) throw new Error(`no shared-all row for ${p.unit} | ${p.tech.id}`);
    const res = await withUsagePhase("other", `${p.unit}|${p.tech.id}`, () =>
      R.scorePair(rev, ask, p.tech, p.note.url, p.note.version, p.note.notes, row.incoming, backendParts(p), pool),
    );
    const kept = res.filter((x) => x.p >= T).map((x) => x.inc);
    const failed = row.failed + (res.some((x) => Number.isNaN(x.p)) ? 1 : 0);
    appendFileSync(join(ARM_DIR, "probs.jsonl"), JSON.stringify({ unit: p.unit, tech: p.tech.id, probs: res.map((x) => [x.inc.key.split("#")[1], x.p, x.err ?? "ok"]) }) + "\n");
    appendFileSync(outFile, JSON.stringify({ unit: p.unit, tech: p.tech.id, name: p.tech.name, failed, incoming: kept }) + "\n");
    console.log(`${p.unit} | ${p.tech.id}: kept ${kept.length} of ${row.incoming.length}${failed ? `, failed` : ""}`);
  });
}
writeFileSync(join(ARM_DIR, "meta.json"), JSON.stringify({ split: SPLIT, arm: ARM, wall_s: (Date.now() - t0) / 1000, spent_after: spent(), at: new Date().toISOString() }, null, 1) + "\n");
console.log(`done; slice 7 spend ${JSON.stringify(spent())}`);
