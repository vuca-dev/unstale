// Edge encoder training data from a central store, with no model calls: every active record
// (central/records/<tech>.json) is turned back into the state the pipeline classified (recordState), and paired with Jev's cached answer to exactly that request (the classifier
// cache, by sha256 of classifier, model, state and the current questions). A record whose state or question wording
// has changed since it was labelled has no hit and is counted, not guessed.
//
// Technologies of every step-D dev or held-out set (and ids that name them) are excluded.
//
//   cd central && UNSTALE_STORE=<store> npx tsx ../eval/edge-encoder/build-data.mts <out dir>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { labelQuestions, recordState } from "../../central/src/pipeline/classify/labels.ts";
import { records, valueOf } from "../../central/src/pipeline/packs.ts";
import { centralDir } from "../../central/src/pipeline/paths.ts";
import { canonical, sha256 } from "../../central/src/pipeline/util.ts";
import type { Incoming } from "../../central/src/pipeline/extract.ts";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: build-data.mts <out dir>");
const C = centralDir();
// Step-D dev and held-out technologies: slice 4's list plus H2 (holdout-majors/technologies.json).
const EXCLUDE = ["posthog", "zod", "uvicorn", "typer", "next", "prisma", "nestjs", "nuxt", "laravel", "sveltejs", "svelte-kit", "sveltekit", "msw", "transformers", "mypy"];
const readJson = <T,>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

// Every cached classifier answer, newest record per key (packs.ts semantics), read once.
const answers = new Map<string, string>();
const cdir = join(C, "cache", "classifier");
const walk = (d: string): void => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".pack")) for (const r of records(readFileSync(p))) answers.set(r.name, valueOf(r).toString("utf8"));
    else if (e.name.endsWith(".json")) answers.set(e.name.slice(0, -5), readFileSync(p, "utf8"));
  }
};
walk(cdir);
console.error(`classifier cache: ${answers.size} answers`);

// Technology display names: what pipelineTechnology gives t.name, as published in the catalog's tech index.
const names = new Map<string, string>();
const techDir = join(process.env.UNSTALE_STORE ?? "", "catalog", "v1", "tech");
if (existsSync(techDir)) for (const f of readdirSync(techDir)) {
  try { const t = readJson<{ id?: string; name?: string }>(join(techDir, f)); if (t.id && t.name) names.set(t.id, t.name); } catch { /* skip */ }
}
const jobsDir = join(C, "onboarding", "jobs");
if (existsSync(jobsDir)) for (const f of readdirSync(jobsDir)) {
  try { const j = readJson<{ technology: string; descriptor?: { name?: string } }>(join(jobsDir, f)); if (j.descriptor?.name && !names.has(j.technology)) names.set(j.technology, j.descriptor.name); } catch { /* skip */ }
}
console.error(`names: ${names.size}`);

const q = labelQuestions();
// One state per active record, rebuilt from the record as the pipeline built it from the record's source extraction
// (recordState over Incoming): the release is the version of the record's first source note, the evidence its first
// quote. A record revised since (a merge rewrote its summary) or labelled under older wording has no hit.
type Rec = { status: string; subject: string; facet?: string | null; summary: string; introduces?: string[]; replaces?: string[]; sources?: string[];
  releases?: Array<{ version: string; date?: string }>; evidence?: Array<{ kind?: string; quote?: string; section?: string }>; revision?: number };
const recDir = join(C, "records");
const report: Record<string, { records: number; labelled: number; kinds: Record<string, number> }> = {};
const lines: string[] = [];
let excluded = 0, noName = 0;
for (const f of readdirSync(recDir)) {
  if (!f.endsWith(".json")) continue;
  const tech = f.slice(0, -5);
  if (EXCLUDE.some((x) => tech.toLowerCase().includes(x))) { excluded++; continue; }
  const name = names.get(tech);
  if (!name) { noName++; continue; }
  const r = (report[tech] = { records: 0, labelled: 0, kinds: {} });
  const store = readJson<{ records: Record<string, Rec> }>(join(recDir, f));
  for (const rec of Object.values(store.records)) {
    if (rec.status !== "active") continue;
    r.records++;
    const ev = rec.evidence?.[0] ?? {};
    const kind = ev.kind ?? "release_notes";
    const src = rec.sources?.[0] ?? "";
    const version = /@([^#]+)#/.exec(src)?.[1] ?? rec.releases?.[0]?.version ?? "";
    const inc = { kind: kind === "release_notes" ? undefined : kind, version, subject: rec.subject, facet: rec.facet ?? undefined, summary: rec.summary,
      quote: ev.quote ?? "", section: ev.section, introduces: rec.introduces ?? [], replaces: rec.replaces ?? [] } as unknown as Incoming;
    const state = recordState(name, inc);
    const v = answers.get(sha256(canonical({ classifier: "jev", model: "jev-latest", state, questions: q })));
    if (!v) continue;
    const a = JSON.parse(v) as { model?: string; answers: Record<string, unknown> };
    r.labelled++;
    r.kinds[kind] = (r.kinds[kind] ?? 0) + 1;
    lines.push(JSON.stringify({ tech, id: (rec as unknown as { id: string }).id, kind, date: rec.releases?.[0]?.date ?? null, revision: rec.revision ?? 1, jev: a.model ?? null, state, answers: a.answers }));
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "data.jsonl"), lines.join("\n") + "\n");
writeFileSync(join(OUT, "data-report.json"), JSON.stringify(report, null, 1) + "\n");
const techs = Object.values(report).filter((x) => x.labelled > 0).length;
const tot = Object.values(report).reduce((s, x) => ({ records: s.records + x.records, labelled: s.labelled + x.labelled }), { records: 0, labelled: 0 });
console.log(JSON.stringify({ cacheAnswers: answers.size, technologiesWithRecords: Object.keys(report).length, technologiesLabelled: techs, excluded, noName, ...tot }));
