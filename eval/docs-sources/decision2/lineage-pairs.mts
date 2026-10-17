// Guard-blocked pairs that lineage would judge (match.ts sameLineage), from the arms' stores, for hand labelling: how
// LINEAGE_SAME_P was calibrated (56 pairs, 16 October 2026).
//   cd central && npx tsx ../eval/docs-sources/decision2/lineage-pairs.mts <out-dir> [<technology> ...]
// Writes <out-dir>/lineage-pairs.json and prints each pair, highest p first.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { sameLineage } from "../../../central/src/pipeline/match.ts";
const S = process.argv[2]!;
const techs = process.argv.slice(3).length ? process.argv.slice(3) : ["next"];
const runs: Array<[string, string, string]> = readdirSync(S, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => techs.map((t) => [`${d.name}${techs.length > 1 ? `-${t}` : ""}`, `${S}/${d.name}`, t] as [string, string, string]));
const pairs = new Map<string, any>();
for (const [run, clone, tech] of runs) {
  const f = `${clone}/central/records/${tech}.json`;
  if (!existsSync(f)) continue;
  const recs = JSON.parse(readFileSync(f, "utf8")).records;
  for (const r of Object.values<any>(recs)) {
    for (const h of r.history ?? []) {
      if (h.action !== "created" && h.action !== "match") continue;
      const src = (h.detail ?? "").split(" ")[0];
      const ev = r.evidence.find((e: any) => r.sources.includes(src)) ?? r.evidence.at(-1); if (!ev) continue;
      for (const j of h.judged ?? []) {
        if (j.p < 0.5 || !String(j.outcome).startsWith("guard")) continue;
        const c = recs[j.id];
        if (!c || c.id === r.id) continue;
        const inc = { breaking: !!r.breaking, quote: ev.quote, summary: r.summary, kind: ev.kind, url: ev.url, snapshot: ev.snapshot, version: r.releases[0]?.version };
        if (!sameLineage(inc, c)) continue;
        const key = `${r.summary.slice(0, 60)}|${c.id}`;
        if (!pairs.has(key)) pairs.set(key, { runs: [], p: [], outcome: j.outcome, inc: { id: r.id, summary: r.summary, quote: ev.quote, breaking: r.breaking }, cand: { id: c.id, summary: c.summary, quote: c.evidence.map((e: any) => e.quote).join(" | ").slice(0, 400), breaking: c.breaking } });
        const x = pairs.get(key);
        x.runs.push(run); x.p.push(j.p);
      }
    }
  }
}
const list = [...pairs.values()].sort((a, b) => Math.max(...b.p) - Math.max(...a.p));
writeFileSync(`${S}/lineage-pairs.json`, JSON.stringify(list, null, 1));
list.forEach((x, i) => console.log(`#${i + 1} p=${Math.max(...x.p).toFixed(2)} ${x.outcome} [${x.runs.join(",")}]\n  IN  ${x.inc.id}: ${x.inc.summary.slice(0, 150)}\n      “${x.inc.quote.slice(0, 160)}”\n  OLD ${x.cand.id}: ${x.cand.summary.slice(0, 150)}\n      “${x.cand.quote.slice(0, 160)}”`));
console.error(`${list.length} pairs`);
