// Slice 6 runner (PREREG.md): one arm on one split, through the pipeline's own extractRelease and classifier.
// The `shared` arms need the design's code: `git apply eval/select/slice6/design.patch` (it was rejected, RESULTS.md).
//
//   cd central && npx tsx ../eval/select/slice6/run6.mts --state <central dir: guides/, onboarding/jobs/, cache/>
//       --split dev|heldout|gold --arm base|rep|shared [--cap 3] [--jev-cap 0.5] [--concurrency 4]
//
// Arms:
//   base    production's per-package answers, read from the state's caches only (UNSTALE_GUIDE_SHARED=0, network
//           refused). Not run on `gold` (slice 3b's stored gpt-6-luna runs are its baseline).
//   rep     a fresh per-package replicate (UNSTALE_GUIDE_SHARED=0) with its own empty caches: the noise reference.
//   shared  the design under test (UNSTALE_GUIDE_SHARED=1) with its own empty caches. A unit's packages run one after
//           another, as production meets them, so the first pays for the guide and the rest hit the cache.
//   shared-all  post hoc, descriptive only (RESULTS.md): `shared` without the selection (every package keeps the whole
//           guide's records), with its own empty caches; the selection call is answered locally with every id.
//
// Every record is then labelled by the pipeline's classifier (Jev, chat fallback, its cache under the arm's directory).
// Output: out/slice6/<split>/<arm>/pairs.jsonl, one line per (unit, package): incoming records with their labels and
// the failed count. Usage: the arm's central/usage.jsonl (llm.ts and the classifier log there). Every gateway call is
// refused once the slice's gateway spend (all arms' logs, provider-reported cost) plus the worst case of the calls in
// flight would pass --cap; Jev likewise against --jev-cap at $0.042 per million input tokens.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    concurrency: { type: "string", default: "4" },
  },
});
const ARM = a.arm!, SPLIT = a.split!;
if (!["base", "rep", "shared", "shared-all"].includes(ARM)) throw new Error("--arm base|rep|shared|shared-all");
if (!["dev", "heldout", "gold"].includes(SPLIT)) throw new Error("--split dev|heldout|gold");
const OUT = join(SELECT, "out", "slice6");
const ARM_DIR = join(OUT, SPLIT, ARM);
mkdirSync(ARM_DIR, { recursive: true });
process.env.UNSTALE_CENTRAL_DIR = ARM === "base" ? a.state! : join(ARM_DIR, "central");
process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
process.env.UNSTALE_EXTRACT_EFFORT = "low";
process.env.UNSTALE_EXTRACT_SERVICE_TIER = "flex";
process.env.UNSTALE_GUIDE_SHARED = ARM.startsWith("shared") ? "1" : "0";
for (const k of ["UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET"]) delete process.env[k];

const { loadTechnologies, sharedUnits, noNetwork } = await import("./common.mts");
const { extractRelease } = await import("../../../central/src/pipeline/extract.ts");
const { interpret, labelQuestions, recordState } = await import("../../../central/src/pipeline/classify/labels.ts");
const { makeClassifier } = await import("../../../central/src/pipeline/pipeline.ts");
const { pool, withUsagePhase } = await import("../../../central/src/pipeline/util.ts");
import type { Technology } from "../../../central/src/pipeline/technologies.ts";
import type { GuideNote } from "../../../central/src/pipeline/fetch.ts";

const SPLITS = JSON.parse(readFileSync(join(import.meta.dirname, "splits.json"), "utf8")) as Record<string, string[]>;

// ---- spend guard
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
let reserved = { gateway: 0, jev: 0 };
const realFetch = globalThis.fetch;
if (ARM === "base") noNetwork();
else
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    const kind = url.includes("ai-gateway.vercel.sh") ? "gateway" : url.includes("typesafe.ai") ? "jev" : undefined;
    if (!kind) throw new Error(`slice 6: unexpected request to ${url}`);
    if (ARM === "shared-all" && kind === "gateway") {
      const prompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0]!.content;
      if (prompt.startsWith("You decide which change records")) {
        const ids = [...prompt.matchAll(/"id": "(r\d+)"/g)].map((m) => m[1]);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ids) }, finish_reason: "stop" }] }), { status: 200 });
      }
    }
    // Worst case: gateway input one token per character at the default tier's $0.10/M, 16k output at $0.50/M; Jev chars/3.
    const worst = kind === "gateway" ? (body.length * 0.1 + 16_000 * 0.5) / 1e6 : (body.length / 3) * JEV_IN;
    const s = spent();
    if (s[kind] + reserved[kind] + worst > (kind === "gateway" ? CAP : JEV_CAP)) throw new Error(`slice 6: ${kind} cap reached ($${s[kind].toFixed(4)} spent)`);
    reserved[kind] += worst;
    try {
      return await realFetch(input, init);
    } finally {
      reserved[kind] -= worst;
    }
  }) as typeof fetch;

// ---- units of the split
interface Pair { unit: string; tech: Technology; note: GuideNote }
let groups: Pair[][];
if (SPLIT === "gold") {
  // The held-out majors set's upgrade guides, each read by its own technology (one package per guide).
  const H2 = join(SELECT, "holdout-majors", "extraction");
  const man = JSON.parse(readFileSync(join(H2, "notes.json"), "utf8")) as { notes: Array<{ note_file: string; technology: string; ecosystem: string; kind: string; version: string; date: string; url: string }> };
  groups = man.notes
    .filter((n) => n.kind === "guide")
    .map((n) => [
      {
        unit: n.note_file,
        tech: { id: n.technology, name: n.technology, repo: "", components: [`pkg:${n.ecosystem}/${n.technology.replace("@", "%40")}`], tag: /^$/, clean: (b: string) => b },
        note: { technology: n.technology, kind: "upgrade_guide", tag: "guide", version: n.version, date: n.date, url: n.url, snapshot: "", keyTag: "+guide.h2", notes: readFileSync(join(H2, "notes", n.note_file), "utf8") } as unknown as GuideNote,
      },
    ]);
} else {
  const techs = loadTechnologies(join(a.state!, "onboarding", "jobs"));
  const units = sharedUnits(join(a.state!, "guides"), techs).filter((u) => SPLITS[SPLIT]!.some((p) => u.url.startsWith(p)));
  groups = units.map((u) => u.members.map((m) => ({ unit: u.id, tech: m.tech, note: m.note })));
}

const outFile = join(ARM_DIR, "pairs.jsonl");
const done = new Set(existsSync(outFile) ? readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => { const x = JSON.parse(l); return `${x.unit}\t${x.tech}`; }) : []);
const cls = makeClassifier();
const t0 = Date.now();
console.log(`slice 6 ${SPLIT}/${ARM}: ${groups.length} units, ${groups.flat().length} pairs (${done.size} done); spent so far ${JSON.stringify(spent())}`);
await pool(groups, Number(a.concurrency), async (pairs) => {
  for (const p of pairs) {
    if (done.has(`${p.unit}\t${p.tech.id}`)) continue;
    const row = await withUsagePhase("other", `${p.unit}|${p.tech.id}`, async () => {
      const r = await extractRelease(p.tech, p.note);
      const labelled = await pool(r.incoming, 4, async (inc) => {
        try {
          const l = interpret(await cls.classify(recordState(p.tech.name, inc), labelQuestions()));
          return { ...inc, labels: { change_type: l.change_type, surface: l.surface, breaking: l.breaking, benefit: l.benefit } };
        } catch (e) {
          return { ...inc, labels: null, label_error: (e as Error).message };
        }
      });
      return { unit: p.unit, tech: p.tech.id, name: p.tech.name, failed: r.failed, incoming: labelled };
    });
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    console.log(`${p.unit} | ${p.tech.id}: ${row.incoming.length} records${row.failed ? `, ${row.failed} failed` : ""}${row.incoming.some((i) => i.labels === null) ? ", label errors" : ""}`);
  }
});
writeFileSync(join(ARM_DIR, "meta.json"), JSON.stringify({ split: SPLIT, arm: ARM, wall_s: (Date.now() - t0) / 1000, spent_after: spent(), at: new Date().toISOString() }, null, 1) + "\n");
console.log(`done; slice spend ${JSON.stringify(spent())}`);
