// Central's per-item matching decisions on slice 5's held-out requests, from one of central's stored answer files.
// No model call. Two decisions per item:
//   - `published`: the rule central's RESULTS were scored with (eval/select/slice5/score5.mts `decide`, copied here
//     because that file is a script: its constants are parameters and its guard is its own),
//   - `production`: central's production `pick` (central/src/pipeline/match.ts) on the same answers.
//
//   cd central && npx tsx ../eval/edge-port/central_match_rows.mts --run j2-Q8-heldout --params 0.82,0.91,0.99 --out FILE
//   cd central && npx tsx ../eval/edge-port/central_match_rows.mts --run vercel_openai_gpt-6-luna-heldout --params 0.5,1.01,1.01 --choice --out FILE
//
// --choice: the answers are a text model's; production reads them on the choice (probability 1 or 0, uncalibrated).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { advisoryIds, nearIdenticalQuote, sameLineage, pick } = await import("../../central/src/pipeline/match.ts");
import type { Classification } from "../../central/src/pipeline/classify/adapter.ts";
import type { IncomingForGuard } from "../../central/src/pipeline/match.ts";
import type { StoredRecord } from "../../central/src/pipeline/store.ts";

const { values: a } = parseArgs({ options: { run: { type: "string" }, params: { type: "string" }, choice: { type: "boolean", default: false }, out: { type: "string" } } });
const OUT5 = join(process.env.EDGE_PORT_CENTRAL_OUT ?? join(import.meta.dirname, "..", "select", "out"), "slice5");
const D = JSON.parse(readFileSync(join(OUT5, "units.json"), "utf8")) as { units: Array<{ set: string; key: string; split: string; req: string; cands: StoredRecord[]; guardInc: IncomingForGuard }> };
const ans = JSON.parse(readFileSync(join(OUT5, "runs", a.run!, "answers.json"), "utf8")) as Record<string, Classification | null>;
const [same, cross, quote] = a.params!.split(",").map(Number) as [number, number, number];

function guardP(inc: IncomingForGuard, c: StoredRecord, p: number): boolean {
  const ia = advisoryIds(`${inc.quote} ${inc.summary}`);
  const ca = advisoryIds(`${c.evidence.map((e) => e.quote).join(" ")} ${c.summary}`);
  if ((inc.breaking && !c.breaking) || (ia.size > 0 && ca.size > 0 && ![...ia].some((x) => ca.has(x)))) return true;
  if (sameLineage(inc, c)) throw new Error("lineage case: not expected in these sets");
  const kind = inc.kind ?? "release_notes";
  const sameKind = c.evidence.filter((e) => (e.kind ?? "release_notes") === kind);
  if (!sameKind.length) return p < cross;
  return p < quote && !sameKind.some((e) => nearIdenticalQuote(inc.quote, e.quote));
}
const keyorder = (k: string) => k.split(/(\d+)/).map((x) => (/^\d+$/.test(x) ? x.padStart(8, "0") : x)).join("");

interface Item { uid: string; set: string; key: string; req: string; cands: StoredRecord[]; inc: IncomingForGuard }
const items = new Map<string, Item>();
for (const u of D.units) if (u.split === "heldout") items.set(`${u.set}|${u.key}`, { uid: `${u.set}|${u.key}`, set: u.set, key: u.key, req: u.req, cands: u.cands, inc: u.guardInc });
const order = [...items.values()].sort((x, y) => (x.set === "guides" && y.set === "guides" ? keyorder(x.key).localeCompare(keyorder(y.key)) : 0));
const taken = new Map<string, Set<string>>();
const out: Record<string, unknown> = {};
for (const it of order) {
  const c = ans[it.req];
  // The published rule, with the guides set's exclusion (a record that took an item of this guide is no candidate
  // for the guide's next item).
  const doc = it.set === "guides" ? it.key.split("#")[0]! : "";
  const t = it.set === "guides" ? (taken.get(doc) ?? taken.set(doc, new Set()).get(doc)!) : undefined;
  let best: { id: string; p: number } | undefined;
  if (c) it.cands.forEach((cand, i) => {
    if (t?.has(cand.id)) return;
    const p = c.answers[`same_c${i + 1}`]?.probabilities.yes ?? 0;
    if (p < same || guardP(it.inc, cand, p)) return;
    if (!best || p > best.p) best = { id: cand.id, p };
  });
  if (best && t) t.add(best.id);
  // Production's pick on the same answers.
  let production: unknown = null;
  if (c) {
    const answers = a.choice
      ? Object.fromEntries(Object.entries(c.answers).map(([q, x]) => [q, { choice: x.choice, confidence: 1, probabilities: { yes: x.choice === "yes" ? 1 : 0, no: x.choice === "yes" ? 0 : 1 } }]))
      : c.answers;
    const r = pick(it.cands, answers, it.inc, !a.choice);
    production = { match: r.id ?? null, judged: r.judged };
  }
  out[it.uid] = { answered: !!c, published: best?.id ?? null, production };
}
writeFileSync(a.out!, JSON.stringify(out) + "\n");
console.log(`${a.run}: ${Object.keys(out).length} items, published merges ${Object.values(out).filter((x) => (x as { published: unknown }).published).length}`);
