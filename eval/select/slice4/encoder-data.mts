// Training data for the slice-4 encoder: every incoming record the pipeline extracted for a stored technology outside
// the excluded set, rebuilt from the store's Codex cache (no calls), with Jev's cached answer to exactly the request
// the pipeline asked (classifier cache hit by request hash). Reads .store only; writes out/slice4/encoder/data.jsonl.
//
//   cd central && npx tsx ../eval/select/slice4/encoder-data.mts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
process.env.UNSTALE_CENTRAL_DIR = join(import.meta.dirname, "..", "out", "slice4", "central");
const { parseJson, CODEX_MODEL } = await import("../../../central/src/pipeline/codex.ts");
const { chunk, EXTRACT_PROMPT, Extracted, fill, LABEL_PROMPT, strings, toIncoming } = await import("../../../central/src/pipeline/extract.ts");
const { labelQuestions, recordState } = await import("../../../central/src/pipeline/classify/labels.ts");
const { pipelineTechnology } = await import("../../../central/src/onboarding/discovery.ts");
const { canonical, sha256 } = await import("../../../central/src/pipeline/util.ts");
const S = await import("../states.ts");
import type { Incoming } from "../../../central/src/pipeline/extract.ts";

const C = join(S.STORE, "central");
const OUT = join(import.meta.dirname, "..", "out", "slice4", "encoder");
/** Held-out and dev technologies of every step-D set, and anything whose id names them (related packages too). */
const EXCLUDE = ["posthog", "zod", "uvicorn", "typer", "next", "prisma", "nestjs", "nuxt", "laravel"];
const readJson = <T,>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

function cachedText(prompt: string): string | undefined {
  const key = sha256(`${CODEX_MODEL}\n${prompt}`);
  const p = join(C, "cache", "codex", key.slice(0, 2), `${key}.json`);
  return existsSync(p) ? readJson<{ text: string }>(p).text : undefined;
}
const records = (text: string) => {
  const v = parseJson(text, "array");
  return Array.isArray(v) ? v.flatMap((r) => { const p = Extracted.safeParse(r); return p.success ? [p.data] : []; }) : undefined;
};
const labelObject = (text: string) => {
  const v = parseJson(text, "object");
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
};

const q = labelQuestions();
const jobs = readdirSync(join(C, "onboarding", "jobs")).map((f) => readJson<{ technology: string; descriptor: Parameters<typeof pipelineTechnology>[0] }>(join(C, "onboarding", "jobs", f)));
const lines: string[] = [];
const report: Record<string, { notes: number; chunks: number; chunkHits: number; incoming: number; labelled: number }> = {};
const seen = new Set<string>();
for (const j of jobs) {
  const id = j.technology;
  if (EXCLUDE.some((x) => id.toLowerCase().includes(x))) continue;
  if (seen.has(id) || !existsSync(join(C, "releases", id, "index.json"))) continue;
  seen.add(id);
  const t = pipelineTechnology(j.descriptor);
  const idx = readJson<{ releases: Array<{ version: string; date: string; url: string; snapshot: string }> }>(join(C, "releases", id, "index.json")).releases;
  const r = (report[id] = { notes: 0, chunks: 0, chunkHits: 0, incoming: 0, labelled: 0 });
  for (const rel of idx) {
    const f = join(C, "releases", id, `${rel.version}.md`);
    if (!existsSync(f)) continue;
    r.notes++;
    const notes = t.clean(readFileSync(f, "utf8"));
    const parts = chunk(notes);
    parts.forEach((part, ci) => {
      if (!part.trim()) return;
      r.chunks++;
      const P = parts.length > 1 ? `\nPart ${ci + 1} of ${parts.length} of these release notes.` : "";
      const tx = cachedText(fill(EXTRACT_PROMPT, { TECH: t.name, VERSION: rel.version, DATE: rel.date, PART: P, NOTES: part }));
      const recs = tx === undefined ? undefined : records(tx);
      if (!recs) return;
      r.chunkHits++;
      if (!recs.length) return;
      const brief = recs.map((x, i) => ({ id: `r${i + 1}`, subject: x.subject, facet: x.facet ?? null, change_type: x.change_type ?? null, summary: x.summary, introduces: strings(x.introduces, 20), evidence: x.evidence ?? "" }));
      const lt = cachedText(fill(LABEL_PROMPT, { TECH: t.name, VERSION: rel.version, RECORDS: JSON.stringify(brief, null, 1), NOTES: part }));
      const labels = lt === undefined ? undefined : labelObject(lt);
      const relNote = { technology: t.id, tag: rel.version, version: rel.version, date: rel.date, url: rel.url, snapshot: rel.snapshot, notes };
      recs.forEach((x, i) => {
        const inc: Incoming = toIncoming(t, relNote as never, ci, i, x, labels?.[`r${i + 1}`], part);
        r.incoming++;
        const state = recordState(t.name, inc);
        const key = sha256(canonical({ classifier: "jev", model: "jev-latest", state, questions: q }));
        const p = join(C, "cache", "classifier", key.slice(0, 2), `${key}.json`);
        if (!existsSync(p)) return;
        const ans = readJson<{ classifier: string; answers: Record<string, { choice: string; probabilities: Record<string, number> }> }>(p);
        r.labelled++;
        lines.push(JSON.stringify({ tech: id, key: inc.key, state, answers: ans.answers }));
      });
    });
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "data.jsonl"), lines.join("\n") + "\n");
writeFileSync(join(OUT, "data-report.json"), JSON.stringify(report, null, 1) + "\n");
const tot = Object.values(report).reduce((s, x) => ({ notes: s.notes + x.notes, chunks: s.chunks + x.chunks, chunkHits: s.chunkHits + x.chunkHits, incoming: s.incoming + x.incoming, labelled: s.labelled + x.labelled }), { notes: 0, chunks: 0, chunkHits: 0, incoming: 0, labelled: 0 });
console.log(`${Object.keys(report).length} technologies; ${JSON.stringify(tot)}`);
