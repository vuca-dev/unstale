// The slice-4 dev and held-out units' states ({uid: state}) for the encoder's inference. Same unit ids as run4.mts.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
process.env.UNSTALE_CENTRAL_DIR = join(import.meta.dirname, "..", "out", "slice4", "central");
const S = await import("../states.ts");
const brk = join(homedir(), "ati-slice2", "results", "datamodel", "breaking");
const judge = (arm: string) => {
  const out = new Map<string, boolean>();
  for (const f of readdirSync(join(brk, arm)).sort()) {
    const run = JSON.parse(readFileSync(join(brk, arm, f), "utf8")) as { unit: { rids: string[] }; answer: Record<string, { breaking?: unknown }> };
    run.unit.rids.forEach((rid, n) => { const v = run.answer[`r${n + 1}`]; if (v && typeof v.breaking === "boolean") out.set(rid, v.breaking); });
  }
  return out;
};
const p = judge("pipeline"), r = judge("reference");
const out: Record<string, unknown> = {};
const items: Record<string, string> = {};
const breakingRef: Record<string, boolean> = {};
for (const u of S.benefitUnits().units) (out[`benefit:${u.id}`] = u.state), (items[`benefit:${u.id}`] = u.item);
for (const u of S.breakingUnits().units) if (p.has(u.id) && r.get(u.id) === p.get(u.id)) (out[`breaking:${u.id}`] = u.state), (breakingRef[u.id] = p.get(u.id)!);
for (const x of JSON.parse(readFileSync(join(import.meta.dirname, "..", "holdout", "classify", "records.json"), "utf8")).records) out[`heldout:${x.id}`] = x.state;
const dir = join(import.meta.dirname, "..", "out", "slice4", "encoder");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "units.json"), JSON.stringify(out) + "\n");
writeFileSync(join(dir, "dev-ref.json"), JSON.stringify({ benefitItemOf: items, breaking: breakingRef }) + "\n");
console.log(Object.keys(out).length, "units");
