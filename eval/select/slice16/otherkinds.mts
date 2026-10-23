// Slice 16 (PREREG.md, "Other request kinds"): merges in the whole production history that QUOTE_GUARD_BELOW 0.99
// would newly block outside the short rules. A merge counts if its target already held evidence of the incoming
// item's kind, its recorded p is in [0.95, 0.99), its quote is not near-identical to one of those, it is not a lineage
// pair, and its request was not under the short rules.
//
//   cd central && npx tsx ../eval/select/slice16/otherkinds.mts <records dir>
//
// The incoming item is the target's evidence entry at the merged source's index (sources and evidence are appended
// together). Whether the request used the short rules is judged from the kinds the judged candidates hold now, an
// approximation: a candidate can only gain kinds later, so it can mark a short request non-short, never the reverse.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nearIdenticalQuote } from "../../../central/src/pipeline/match.ts";
import type { StoredRecord, TechStore } from "../../../central/src/pipeline/store.ts";

const dir = process.argv[2]!;
const OUT = join(import.meta.dirname, "..", "out", "slice16");
const kindOf = (e: { kind?: string }) => e.kind ?? "release_notes";
const rows: unknown[] = [];
const tally = { merges: 0, nonShortSameKind: 0, inBand: 0, newlyBlocked: 0 };
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as TechStore;
  for (const r of Object.values(s.records) as StoredRecord[]) {
    for (const h of r.history) {
      const j = h.judged?.find((x) => x.id === r.id && x.outcome === "same");
      if (!j || !h.detail) continue;
      tally.merges++;
      const key = h.detail.split(" ")[0]!;
      const idx = r.sources.indexOf(key);
      if (idx <= 0 || r.evidence.length !== r.sources.length) continue;
      const inc = r.evidence[idx]!;
      const ik = kindOf(inc);
      const before = r.evidence.slice(0, idx);
      const same = before.filter((e) => kindOf(e) === ik);
      if (!same.length) continue; // cross path: QUOTE_GUARD_BELOW does not apply
      if ((ik === "docs" || ik === "upgrade_guide") && same.some((e) => e.url === inc.url)) continue; // lineage
      const kinds = new Set<string>();
      for (const c of h.judged!) for (const e of s.records[c.id]?.evidence ?? []) kinds.add(kindOf(e));
      const short = (ik === "release_notes" || ik === "upgrade_guide") && [...kinds].every((k) => k === "release_notes" || (k === "upgrade_guide" && ik === "release_notes"));
      if (short) continue;
      tally.nonShortSameKind++;
      if (j.p < 0.95 || j.p >= 0.99) continue;
      tally.inBand++;
      if (same.some((e) => nearIdenticalQuote(inc.quote, e.quote))) continue;
      tally.newlyBlocked++;
      rows.push({ tech: s.technology, record: r.id, key, p: j.p, kind: ik, incoming: { quote: inc.quote, url: inc.url }, record_subject: r.subject, record_summary: r.summary, before: before.map((e) => ({ kind: kindOf(e), quote: e.quote })) });
    }
  }
}
console.log(JSON.stringify(tally));
writeFileSync(join(OUT, "otherkinds.json"), JSON.stringify(rows, null, 1) + "\n");
