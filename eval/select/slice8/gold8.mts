// Slice 8 gold check (PREREG.md condition 3), no model calls: each gold-labelled note of the held-out majors set (the
// three upgrade guides of slices 6/7, and its major release notes) and of the held-out set is chunked as production
// chunks it; a labelled change is lost when every one of its anchors lies only in chunks the frozen candidate skips.
//
//   cd central && npx tsx ../eval/select/slice8/gold8.mts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunk } from "../../../central/src/pipeline/extract.ts";
import { boilerplate } from "./skip.ts";
import { FROZEN } from "./frozen.ts";

const SELECT = join(import.meta.dirname, "..");
const fold = (s: string) => s.replace(/[`*_\\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
type Item = { group: string; anchors: string[]; required?: boolean | string; breaking?: boolean | string };
console.log("| Set | Notes | Chunks | Skipped chunks | Labelled groups | Lost | Lost required | Lost breaking |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [set, kinds] of [["holdout-majors", ["guide"]], ["holdout-majors", null], ["holdout", null]] as const) {
  const dir = join(SELECT, set, "extraction");
  const man = JSON.parse(readFileSync(join(dir, "notes.json"), "utf8")) as { notes: Array<{ note_file: string; kind: string }> };
  const labels = JSON.parse(readFileSync(join(dir, "labels", "adjudicated.json"), "utf8")) as Record<string, unknown>;
  let notes = 0, chunks = 0, skipped = 0, lost = 0, lostReq = 0, lostBrk = 0;
  const groups = new Set<string>();
  for (const n of man.notes) {
    if (kinds && !(kinds as readonly string[]).includes(n.kind)) continue;
    notes++;
    const parts = chunk(readFileSync(join(dir, "notes", n.note_file), "utf8"));
    const skip = parts.map((p) => boilerplate(p, FROZEN));
    chunks += parts.length;
    skipped += skip.filter(Boolean).length;
    const items = (labels[n.note_file] as Item[] | undefined) ?? [];
    const byGroup = new Map<string, Item[]>();
    for (const it of items) byGroup.set(it.group, [...(byGroup.get(it.group) ?? []), it]);
    for (const [g, its] of byGroup) {
      groups.add(`${n.note_file}#${g}`);
      const anchors = its.flatMap((i) => i.anchors).map(fold).filter(Boolean);
      const kept = anchors.some((q) => parts.some((p, j) => !skip[j] && fold(p).includes(q)));
      const inSkipped = anchors.some((q) => parts.some((p, j) => skip[j] && fold(p).includes(q)));
      if (!kept && inSkipped) {
        lost++;
        if (its.some((i) => i.required === true)) lostReq++;
        if (its.some((i) => i.breaking === true)) lostBrk++;
      }
    }
  }
  console.log(`| ${set}${kinds ? " (guides)" : ""} | ${notes} | ${chunks} | ${skipped} | ${groups.size} | ${lost} | ${lostReq} | ${lostBrk} |`);
}
