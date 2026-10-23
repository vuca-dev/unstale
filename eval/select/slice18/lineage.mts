// Slice 18 (PREREG.md): slice 17's lineage census (../slice17/lineage.mts), unsampled, with each request's whole
// judged list and each lineage pair's same-document quotes, for re-deciding requests at other bars. Slice 17's labels
// are carried over by pair id. Writes out/slice17/lin2-units.json (for slice17/label.mts judge lin2) and
// out/slice18/requests.json.
//
// Slice 17 (PREREG.md, amendment "LIN"): a census of the lineage pairs in the whole production history. The docs
// replays produced none: a lineage pair needs a later snapshot of a document the candidate cites, for the same release,
// and the stored state keeps one snapshot per guide and page. A pair is a judged (incoming, candidate) where:
//   - the incoming item is a docs page or upgrade guide;
//   - the candidate held, before that item, evidence of the same document (match.ts documentKey, or any upgrade guide
//     against an upgrade guide) at another snapshot;
//   - the candidate cites the item's release.
// The incoming item's brief is its own record when the judgement created it ("created"). For a merge, only its quote is
// kept. p is production's recorded answer (Jev at the time), not a fresh Jev 1.14 answer.
//
//   cd central && npx tsx ../eval/select/slice17/lineage.mts <records dir>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { documentKey } from "../../../central/src/pipeline/match.ts";
import type { StoredRecord, TechStore } from "../../../central/src/pipeline/store.ts";

const dir = process.argv[2]!;
const OUT = join(import.meta.dirname, "..", "out", "slice17");
const OUT18 = join(import.meta.dirname, "..", "out", "slice18");
const requests: Record<string, { tech: string; key: string; quote: string; judged: Array<{ id: string; p: number; outcome: string; lineage: boolean; docQuotes: string[] }> }> = {};
const kindOf = (e: { kind?: string }) => e.kind ?? "release_notes";
const DOC = new Set(["docs", "upgrade_guide"]);
const units: unknown[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as TechStore;
  // Every item's evidence, by key, wherever it sits now (a created record merged later keeps none).
  const evOf = new Map<string, StoredRecord["evidence"][number]>();
  for (const x of Object.values(s.records) as StoredRecord[]) if (x.evidence.length === x.sources.length) x.sources.forEach((k, i) => evOf.set(k, x.evidence[i]!));
  for (const r of Object.values(s.records) as StoredRecord[]) {
    for (const h of r.history) {
      if (!h.judged?.length || !h.detail) continue;
      const key = h.detail.split(" ")[0]!;
      const ev = evOf.get(key);
      if (!ev) continue;
      if (!DOC.has(kindOf(ev))) continue;
      const created = h.action === "created";
      const version = key.split("@").at(-1)?.split("#")[0]?.split("+")[0];
      const req = { tech: s.technology, key, quote: ev.quote, judged: [] as Array<{ id: string; p: number; outcome: string; lineage: boolean; docQuotes: string[] }> };
      for (const j of h.judged) {
        const c = s.records[j.id];
        req.judged.push({ id: j.id, p: j.p, outcome: j.outcome, lineage: false, docQuotes: [] });
        if (!c || c.id === r.id && created) continue;
        // The candidate's evidence before this item (for the record that took it: its earlier entries).
        const at = c.sources.indexOf(key);
        const before = at >= 0 ? c.evidence.slice(0, at) : c.evidence;
        const docOf = (e: StoredRecord["evidence"][number]) => DOC.has(kindOf(e)) && e.snapshot !== ev.snapshot && (documentKey(e.url) === documentKey(ev.url) || (kindOf(ev) === "upgrade_guide" && kindOf(e) === "upgrade_guide"));
        const lineage = before.some(docOf);
        if (!lineage || (version && !c.releases.some((x) => x.version === version))) continue;
        Object.assign(req.judged.at(-1)!, { lineage: true, docQuotes: before.filter(docOf).map((e) => e.quote) });
        units.push({
          id: `${s.technology}|${key}|${c.id}`, set: "lin", key, tech: s.technology, request: key, candidate: c.id, p: j.p, outcome: j.outcome,
          A: { kind: kindOf(ev), subject: created ? r.subject : "(not stored)", ...(created && r.facet ? { facet: r.facet } : {}), summary: created ? r.summary : "(not stored: only the evidence quote of a merged item is kept)", quotes: [ev.quote] },
          B: { subject: c.subject, ...(c.facet ? { facet: c.facet } : {}), summary: c.summary, quotes: before.slice(0, 3).map((e) => `[${kindOf(e)}] ${e.quote}`) },
        });
      }
      if (req.judged.some((j) => j.lineage)) requests[`${s.technology}|${key}`] = req;
    }
  }
}
// Slice 17's labels carried over by pair id.
const prior = new Map((JSON.parse(readFileSync(join(OUT, "lin-units.json"), "utf8")) as Array<{ id: string; j1?: string; j2?: string }>).map((u) => [u.id, u]));
for (const u of units as Array<{ id: string; j1?: string; j2?: string }>) { const p = prior.get(u.id); if (p?.j1) u.j1 = p.j1; if (p?.j2) u.j2 = p.j2; }
writeFileSync(join(OUT, "lin2-units.json"), JSON.stringify(units, null, 1));
mkdirSync(OUT18, { recursive: true });
writeFileSync(join(OUT18, "requests.json"), JSON.stringify(requests) + "\n");
console.log(JSON.stringify({ pairs: units.length, carried: (units as Array<{ j1?: string }>).filter((u) => u.j1).length, requests: Object.keys(requests).length }));
