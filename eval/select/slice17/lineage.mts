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
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { documentKey } from "../../../central/src/pipeline/match.ts";
import { sha256 } from "../../../central/src/pipeline/util.ts";
import type { StoredRecord, TechStore } from "../../../central/src/pipeline/store.ts";

const dir = process.argv[2]!;
const OUT = join(import.meta.dirname, "..", "out", "slice17");
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
      for (const j of h.judged) {
        const c = s.records[j.id];
        if (!c || c.id === r.id && created) continue;
        // The candidate's evidence before this item (for the record that took it: its earlier entries).
        const at = c.sources.indexOf(key);
        const before = at >= 0 ? c.evidence.slice(0, at) : c.evidence;
        const lineage = before.some((e) => DOC.has(kindOf(e)) && e.snapshot !== ev.snapshot && (documentKey(e.url) === documentKey(ev.url) || (kindOf(ev) === "upgrade_guide" && kindOf(e) === "upgrade_guide")));
        if (!lineage || (version && !c.releases.some((x) => x.version === version))) continue;
        units.push({
          id: `${s.technology}|${key}|${c.id}`, set: "lin", key, tech: s.technology, request: key, candidate: c.id, p: j.p, outcome: j.outcome,
          A: { kind: kindOf(ev), subject: created ? r.subject : "(not stored)", ...(created && r.facet ? { facet: r.facet } : {}), summary: created ? r.summary : "(not stored: only the evidence quote of a merged item is kept)", quotes: [ev.quote] },
          B: { subject: c.subject, ...(c.facet ? { facet: c.facet } : {}), summary: c.summary, quotes: before.slice(0, 3).map((e) => `[${kindOf(e)}] ${e.quote}`) },
        });
      }
    }
  }
}
// PREREG amendment: 150 requests (incoming items), sha256("slice17-lin:" + tech|key) order; all their lineage pairs.
const reqs = [...new Set((units as Array<{ tech: string; key: string }>).map((u) => `${u.tech}|${u.key}`))];
const pick = new Set(reqs.sort((x, y) => sha256(`slice17-lin:${x}`).localeCompare(sha256(`slice17-lin:${y}`))).slice(0, 150));
const sampled = (units as Array<{ tech: string; key: string }>).filter((u) => pick.has(`${u.tech}|${u.key}`));
writeFileSync(join(OUT, "lin-units.json"), JSON.stringify(sampled, null, 1));
console.log(JSON.stringify({ population_requests: reqs.length, sampled_requests: pick.size, sampled_pairs: sampled.length }));
const by = (k: string) => (units as Array<Record<string, string>>).reduce((m, u) => ((m[u[k]!] = (m[u[k]!] ?? 0) + 1), m), {} as Record<string, number>);
console.log(JSON.stringify({ pairs: units.length, outcomes: by("outcome"), techs: Object.keys(by("tech")).length }));
