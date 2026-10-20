// Slice 7 threshold sweep (PREREG.md "Fitting on dev"): rewrites an arm's kept records at each threshold of
// {0.3, 0.4, 0.5, 0.6, 0.7} from its probs.jsonl, with no new calls, into out/slice7/<split>/<arm>@<t>/pairs.jsonl
// for score7.mts.
//
//   cd central && npx tsx ../eval/select/slice7/thresh7.mts --split dev --arm jev-r0
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a } = parseArgs({ options: { split: { type: "string" }, arm: { type: "string" } } });
const OUT = join(SELECT, "out", "slice7");
const S6 = join(SELECT, "out", "slice6");
const read = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const src = new Map<string, { failed: number; incoming: Array<{ key: string }> }>();
const files = a.split === "gold" ? [join(OUT, "gold", "shared-all", "pairs.jsonl")] : [join(S6, "dev", "shared-all", "pairs.jsonl"), join(S6, "heldout", "shared-all", "pairs.jsonl")];
for (const f of files) for (const r of read(f)) src.set(`${r.unit}\t${r.tech}`, r);
const probs = read(join(OUT, a.split!, a.arm!, "probs.jsonl")) as Array<{ unit: string; tech: string; probs: Array<[string, number, string]> }>;
for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
  const dir = join(OUT, a.split!, `${a.arm}@${t}`);
  mkdirSync(dir, { recursive: true });
  const rows = probs.map((p) => {
    const row = src.get(`${p.unit}\t${p.tech}`)!;
    const pk = new Map(p.probs.map(([k, v]) => [k, v]));
    const failed = row.failed + (p.probs.some(([, v]) => v === null || Number.isNaN(v)) ? 1 : 0);
    return { unit: p.unit, tech: p.tech, failed, incoming: row.incoming.filter((r) => (pk.get(r.key.split("#")[1]!) ?? -1) >= t) };
  });
  writeFileSync(join(dir, "pairs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
console.log(`wrote ${a.arm}@{0.3..0.7} for ${probs.length} pairs`);
