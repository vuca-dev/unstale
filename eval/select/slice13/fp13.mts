// Slice 13 false-positive analysis (DEV only): every record of an arm that slice 12's matcher leaves unmatched against
// production (`base`), with what it overlaps. No model calls.
//
//   cd central && npx tsx ../eval/select/slice13/fp13.mts --state <restored store>/central --arm r0 [--stratum large]
//
// Per unmatched record: `split` when its quote overlaps a base record that another record of the arm already matched
// (one change written as several records), `dup` when its quote overlaps another record of the arm, `ungrounded` when
// the quote is not in the notes, else `extra` (a change production did not record). Output: out/slice13/fp-<arm>.tsv.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a } = parseArgs({ options: { state: { type: "string" }, arm: { type: "string", default: "r0" }, stratum: { type: "string" } } });
process.env.UNSTALE_CENTRAL_DIR = a.state!;
const { loadTechnologies } = await import("../slice6/common.mts");
const { fetchReleases } = await import("../../../central/src/pipeline/fetch.ts");
const { match, norm } = await import("./match13.mts");
import type { Rec, Row } from "./match13.mts";

const OUT = join(SELECT, "out", "slice13");
const load = (arm: string): Map<string, Row> => {
  const m = new Map<string, Row>();
  const f = join(OUT, arm, "releases.jsonl");
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as Row; m.set(`${r.tech}\t${r.version}`, r); }
  return m;
};
const base = load("base"), arm = load(a.arm!);
const techs = loadTechnologies(join(a.state!, "onboarding", "jobs"));
const rows: string[] = ["kind\tstratum\ttech\tversion\tsubject\tsection\tsummary\tquote"];
const counts: Record<string, number> = {};
for (const [k, b] of base) {
  const x = arm.get(k);
  if (!x || (a.stratum && b.stratum !== a.stratum)) continue;
  const [tech, version] = k.split("\t") as [string, string];
  const notes = (await fetchReleases(techs.get(tech)!, { offline: true })).notes.find((n) => n.version === version)!.notes;
  const n = norm(notes);
  const span = (r: Rec): [number, number] | undefined => { const q = norm(r.quote); const i = q ? n.indexOf(q) : -1; return r.grounded && i >= 0 ? [i, i + q.length] : undefined; };
  const ov = (p?: [number, number], q?: [number, number]) => !!p && !!q && p[0] < q[1] && q[0] < p[1];
  const pairs = match(notes, x.incoming, b.incoming);
  const matched = new Set(pairs.map(([p]) => p));
  for (const r of x.incoming) {
    if (matched.has(r)) continue;
    const s = span(r);
    const kind = !s ? "ungrounded" : b.incoming.some((q) => ov(s, span(q))) ? "split" : x.incoming.some((q) => q !== r && ov(s, span(q))) ? "dup" : "extra";
    counts[kind] = (counts[kind] ?? 0) + 1;
    const c = (v?: string) => (v ?? "").replace(/\s+/g, " ").slice(0, 220);
    rows.push([kind, b.stratum, x.name ?? tech, version, c(r.subject), c(r.section), c(r.summary), c(r.quote)].join("\t"));
  }
}
writeFileSync(join(OUT, `fp-${a.arm}.tsv`), rows.join("\n") + "\n");
console.log(JSON.stringify(counts), rows.length - 1);
