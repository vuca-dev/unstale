// Dev records for designing label-prompt variants (#5b): Luna's slice 3 two-call extractions of the 9 dev documents
// (next, prisma, nestjs; eval/sets/extraction-recall.json sources), same shape as items.json. Never the held-out sets.
//   cd central && npx tsx ../eval/select/labels/dev-items.mts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const SELECT = join(import.meta.dirname, "..");
const S = await import("../states.ts");
const { chunk, Extracted, strings } = await import("../../../central/src/pipeline/extract.ts");
const { parseJson } = await import("../../../central/src/pipeline/codex.ts");
const { TECHNOLOGIES } = await import("../../../central/src/pipeline/technologies.ts");
import type { Chunk } from "./items.mts";

// As slice3/run3.mts devDocs().
const items = JSON.parse(readFileSync(join(S.EVAL, "sets", "extraction-recall.json"), "utf8")).items as Array<{ event: string; in_fetched_sources: boolean; sources: Array<{ url: string }> }>;
const techOf: Record<string, string> = { next16: "next", prisma7: "prisma", nest12: "nestjs" };
const want = new Map<string, string>();
for (const it of items) if (it.in_fetched_sources) for (const s of it.sources) want.set(s.url, techOf[it.event.split("-").at(-1)!]!);
const central = join(S.STORE, "central");
const docs: Array<{ id: string; tech: string; name: string; version: string; kind: string; notes: string }> = [];
for (const [url, tech] of want) {
  const t = TECHNOLOGIES[tech]!;
  const rels = JSON.parse(readFileSync(join(central, "releases", tech, "index.json"), "utf8")).releases as Array<{ url: string; version: string }>;
  const r = rels.find((x) => x.url === url);
  if (r) { docs.push({ id: `${tech}@${r.version}`, tech, name: t.name, version: r.version, kind: "notes", notes: t.clean(readFileSync(join(central, "releases", tech, `${r.version}.md`), "utf8")) }); continue; }
  const gs = JSON.parse(readFileSync(join(central, "guides", tech, "index.json"), "utf8")).guides as Array<{ url: string; version: string; keyTag: string; snapshot: string }>;
  const g = gs.find((x) => x.url === url)!;
  docs.push({ id: `${tech}@${g.version}${g.keyTag}`, tech, name: t.name, version: g.version, kind: "guide", notes: readFileSync(join(central, "guides", tech, `${g.version.split(".")[0]}.${g.snapshot.slice(7, 15)}.md`), "utf8") });
}
const raw = readFileSync(join(SELECT, "out", "slice3", "runs", "luna-fresh-two-call-dev", "raw.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { doc: string; ci: number; step: string; text: string });
const out: Chunk[] = [];
for (const d of docs.sort((x, y) => x.id.localeCompare(y.id))) chunk(d.notes).forEach((text, ci) => {
  const ex = raw.filter((r) => r.doc === d.id && r.ci === ci && r.step === "extract").at(-1);
  if (!ex) return;
  const v = parseJson(ex.text, "array");
  const recs = Array.isArray(v) ? v.flatMap((r) => { const p = Extracted.safeParse(r); return p.success ? [p.data] : []; }) : [];
  if (!recs.length) return;
  const lab = raw.filter((r) => r.doc === d.id && r.ci === ci && r.step === "label").at(-1);
  out.push({ set: "DEV", doc: d.id, tech: d.tech, name: d.name, version: d.version, kind: d.kind, ci, notes: text, records: recs.map((x, i) => ({ id: `r${i + 1}`, subject: x.subject, facet: x.facet ?? null, change_type: x.change_type ?? null, summary: x.summary, introduces: strings(x.introduces, 20), evidence: x.evidence ?? "" })), baseline: lab?.text ?? null });
});
writeFileSync(join(import.meta.dirname, "dev-items.json"), JSON.stringify({ chunks: out }, null, 1) + "\n");
console.log(JSON.stringify({ chunks: out.length, records: out.reduce((a, c) => a + c.records.length, 0) }));
