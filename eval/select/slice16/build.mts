// Slice 16 (PREREG.md): a fresh step-E set. One catalog technology is re-ingested from empty into a side store with the
// catalog pipeline's own runTechnology: offline (stored release lists, notes and guides), no publish, no docs, no
// advisories, extraction from the restored production LLM cache, and Jev 1.14 live for labels and the judge, at
// production's constants. Every classifier answer the run gets is recorded. A second pass replays the run's ingest
// from its own extractions and answers, and writes each judge request with its candidates as they stood.
//
//   cd central && UNSTALE_STORE=<side store> npx tsx ../eval/select/slice16/build.mts --tech <id> [--check]
//
// --check: count the notes whose extraction is not cached (each would be a live extraction call), then stop.
// The run refuses to start if any note is uncached, unless --allow-uncached (PREREG.md: astro, for its guide pairs).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ChatClassifier, ClassifierCache, FallbackClassifier, Jev, type Classification, type Questions } from "../../../central/src/pipeline/classify/adapter.ts";
import { interpret, labelQuestions, recordState } from "../../../central/src/pipeline/classify/labels.ts";
import { pipelineTechnology, type PublicTechnology } from "../../../central/src/onboarding/discovery.ts";
import { releaseCached, type Incoming } from "../../../central/src/pipeline/extract.ts";
import { fetchGuides, fetchReleases } from "../../../central/src/pipeline/fetch.ts";
import { ingest, kindOf, retrieve } from "../../../central/src/pipeline/match.ts";
import { centralDir } from "../../../central/src/pipeline/paths.ts";
import { runTechnology } from "../../../central/src/pipeline/pipeline.ts";
import type { TechStore } from "../../../central/src/pipeline/store.ts";
import { techLocal } from "../../../central/src/state/client.ts";
import { canonical, compareVersions, sha256 } from "../../../central/src/pipeline/util.ts";

const { values: a } = parseArgs({ options: { tech: { type: "string" }, check: { type: "boolean", default: false }, "allow-uncached": { type: "boolean", default: false } } });
const id = a.tech!;
const OUT = join(import.meta.dirname, "..", "out", "slice16");
mkdirSync(OUT, { recursive: true });
const C = centralDir();

const jobs = join(C, "onboarding", "jobs");
const job = readdirSync(jobs).map((f) => JSON.parse(readFileSync(join(jobs, f), "utf8")) as { technology?: string; descriptor?: PublicTechnology }).find((j) => j.descriptor?.id === id);
if (!job?.descriptor) throw new Error(`no onboarding descriptor for ${id}`);
const t = pipelineTechnology(job.descriptor);
const fetched = await fetchReleases(t, { offline: true });
const guides = await fetchGuides(t, fetched.notes, { offline: true });
const notes = [...fetched.notes, ...guides];
const uncached = notes.filter((n) => !releaseCached(t, n));
console.log(`${id}: ${fetched.notes.length} notes, ${guides.length} guides; ${uncached.length} not in the extraction cache`);
if (a.check) process.exit(0);
if (uncached.length && !a["allow-uncached"]) throw new Error(`${uncached.length} notes would need a live extraction call; pass --allow-uncached (PREREG: astro only)`);
if (existsSync(join(C, "records", `${techLocal(id)}.json`))) throw new Error(`${id} already has records in this store: start from empty`);

// Every answer the run gets, by request (the replay below reads them back).
const answers = new Map<string, Classification>();
const reqKey = (state: Record<string, unknown>, questions: Questions) => sha256(canonical({ state, questions }));
class Recording extends FallbackClassifier {
  override async classify(state: Record<string, unknown>, questions: Questions): Promise<Classification> {
    const r = await super.classify(state, questions);
    answers.set(reqKey(state, questions), r);
    return r;
  }
}
const cls = new Recording(new Jev(), new ChatClassifier(), new ClassifierCache(join(C, "cache", "classifier-slice16")), { fallback: (e) => console.error(`fallback: ${e.kind}: ${e.message}`) });
const report = await runTechnology(t, { offline: true, publish: false, sample: false, guides: true, docs: false, advisories: false, registry: false }, cls);
console.log(JSON.stringify({ report, counts: cls.counts }));
writeFileSync(join(OUT, `${id}-answers.json`), JSON.stringify(Object.fromEntries(answers)) + "\n");

// Replay: the run's ingest from empty with its own extractions and answers, recording each judge request.
const exDir = join(C, "extractions", techLocal(id));
const incs = new Map<string, Incoming>();
for (const f of readdirSync(exDir).filter((f) => f.endsWith(".json"))) for (const i of JSON.parse(readFileSync(join(exDir, f), "utf8")) as Incoming[]) incs.set(i.key, i);
const real = JSON.parse(readFileSync(join(C, "records", `${techLocal(id)}.json`), "utf8")) as TechStore;
const order = [...incs.values()].filter((i) => real.ingested[i.key]).sort((x, y) => x.date.localeCompare(y.date) || compareVersions(x.version, y.version) || x.key.localeCompare(y.key, "en", { numeric: true }));
const s: TechStore = { technology: real.technology, records: {}, ingested: {}, ...(real.releaseIndex ? { releaseIndex: real.releaseIndex } : {}) };
const reqs: Record<string, unknown> = {};
let agree = 0;
let missing = 0;
for (const inc of order) {
  const lab0 = answers.get(reqKey(recordState(t.name, inc), labelQuestions()));
  if (!lab0) { missing++; continue; }
  const lab = interpret(lab0);
  const cands = structuredClone(retrieve(inc, Object.values(s.records)).map((c) => s.records[c.id]!));
  const o = await ingest(s, t.name, t.components, inc, lab, async (state, questions) => {
    const ans = answers.get(reqKey(state, questions));
    if (!ans) throw new Error(`${inc.key}: judge request not recorded`);
    reqs[inc.key] = { key: inc.key, tech: id, state, questions, cands, answer: ans, guardInc: { breaking: lab.breaking, quote: inc.quote, summary: inc.summary, kind: kindOf(inc), url: inc.url, snapshot: inc.snapshot, version: inc.version }, incoming: inc };
    return ans;
  });
  if (o.id === real.ingested[inc.key]) agree++;
}
console.log(`${id}: replay ${agree}/${order.length} decisions reproduce the run's (${missing} without a recorded label); ${Object.keys(reqs).length} judge requests`);
writeFileSync(join(OUT, `${id}-requests.json`), JSON.stringify(reqs) + "\n");
