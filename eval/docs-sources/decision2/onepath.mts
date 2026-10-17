// The single guide path end to end on a store clone (UNSTALE_CENTRAL_DIR, UNSTALE_CATALOG_DIR): fetchGuides (docs
// module, site copy), then synthesize each guide note; reports new, merged and flagged records per technology.
//   cd central && npx tsx ../eval/docs-sources/decision2/onepath.mts <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchGuides } from "../../../central/src/pipeline/fetch.ts";
import { TECHNOLOGIES } from "../../../central/src/pipeline/technologies.ts";
import { centralDir } from "../../../central/src/pipeline/paths.ts";
const out: any[] = [];
const { synthesize } = await import("../../../central/src/onboarding/synthesis.ts");
for (const t of ["next", "prisma", "nestjs"]) {
  const tech = TECHNOLOGIES[t]!;
  const recordsPath = join(centralDir(), "records", `${t}.json`);
  const before = JSON.parse(readFileSync(recordsPath, "utf8"));
  const guideRecs = Object.values<any>(before.records).filter((r) => r.status === "active" && r.sources.some((x: string) => x.includes("+guide.")));
  const date = guideRecs[0]?.releases?.[0]?.date;
  const majors = [...new Set(guideRecs.map((r: any) => r.releases[0].version))];
  const notes = await fetchGuides(tech, majors.map((v) => ({ version: v, date })), { refresh: true });
  console.error(`${t}: ${notes.length} guide notes: ${notes.map((n) => `${n.url} → ${n.version}`).join(", ")}`);
  for (const n of notes) { try { await synthesize(tech, n); } catch (e) { console.error(`${n.url}: ${(e as Error).message}`); } }
  const after = JSON.parse(readFileSync(recordsPath, "utf8"));
  const created = Object.keys(after.records).filter((k) => !before.records[k]);
  const revised = Object.keys(before.records).filter((k) => after.records[k] && JSON.stringify(after.records[k]) !== JSON.stringify(before.records[k]));
  const statusChanged = revised.filter((k) => after.records[k].status !== before.records[k].status);
  const flagged = created.filter((k) => { const j = [...(after.records[k].history[0].judged ?? [])].sort((a: any, b: any) => b.p - a.p)[0]; return j && j.p >= 0.7 && String(j.outcome).startsWith("guard"); });
  const lineage = Object.values<any>(after.records).flatMap((r) => (r.history ?? []).filter((h: any) => h.action === "match" && notes.some((n) => String(h.detail).includes(n.keyTag)))).length;
  const r = { t, notes: notes.map((n) => [n.url, n.version]), existingGuideRecords: guideRecs.length, created: created.length, merged: revised.length, statusChanged, flaggedDuplicates: flagged, matchEvents: lineage, createdIds: created };
  out.push(r); console.error(JSON.stringify({ ...r, createdIds: undefined }));
}
writeFileSync(process.argv[2]!, JSON.stringify(out, null, 1));
console.error("done");
