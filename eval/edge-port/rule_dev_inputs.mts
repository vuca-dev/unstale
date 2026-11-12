// "Same-or-new by rule" (RESULTS.md): the matching set's dev split in the shape `unstale internal run-step --step match`
// reads, and a replay table (request body sha256 -> the labelling service's stored answer) for recorder.py. No model
// call. Reads central's stored evaluation outputs (eval/select/out/slice5, gitignored) and .store, as build_inputs.mts.
//
//   cd central && npx tsx ../eval/edge-port/rule_dev_inputs.mts OUT/match-dev.jsonl OUT/replay-jev-dev.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const HERE = import.meta.dirname;
const OUT5 = join(process.env.EDGE_PORT_CENTRAL_OUT ?? join(HERE, "..", "select", "out"), "slice5");
const { Jev } = await import("../../central/src/pipeline/classify/adapter.ts");
const { matchRequest, retrieve } = await import("../../central/src/pipeline/match.ts");
const { shardLine } = await import("../../central/src/pipeline/publish.ts");
const S = await import("../select/states.ts");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const jev = new Jev({ apiKey: () => "unused" });
const D = readJson(join(OUT5, "units.json"));
const ans = readJson(join(OUT5, "runs", "j2-Q8-dev", "answers.json"));
const exts = new Map<string, Map<string, any>>();
const incOf = (set: string, tech: string, key: string) => {
  const id = `${set}:${tech}`;
  if (!exts.has(id)) {
    const dirs = set === "within" ? ["central-v1"] : set === "nuxt" ? ["central-trust-nuxt"] : ["central", "central-pre-rematch"];
    exts.set(id, new Map(dirs.flatMap((d) => [...S.extractions(join(S.STORE, d), tech)])));
  }
  return exts.get(id)!.get(key);
};
const lines: any[] = []; const table: Record<string, unknown> = {}; const seen = new Set<string>();
let asked = 0, inTable = 0, sameQs = 0, noInc = 0, order = 0;
for (const u of D.units.filter((x: any) => x.split === "dev")) {
  const id = `${u.set}|${u.key}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const inc = incOf(u.set, u.tech, u.key);
  if (!inc) { noInc++; continue; }
  const got = retrieve(inc, u.cands);
  if (got.map((c: any) => c.id).join() !== u.cands.map((c: any) => c.id).join()) { order++; continue; }
  const name = S.techName(u.tech);
  const req = matchRequest(name, inc, u.guardInc.breaking, u.cands, got.map((c: any) => c.score));
  const ids = Object.keys(req.questions);
  if (ids.length) {
    asked++;
    const a = ans[u.req];
    if (a && Object.keys(a.answers).sort().join() === ids.slice().sort().join()) {
      sameQs++;
      const bodies = jev.batches(req.state, req.questions).map((qs: any) => JSON.stringify((jev as any).body(req.state, qs)));
      if (bodies.length === 1) { table[sha(bodies[0])] = { model: a.model, answers: a.answers }; inTable++; }
    }
  }
  lines.push({ uid: id, req: u.req, name, incoming: inc, breaking: u.guardInc.breaking, candidates: u.cands.map((c: any) => shardLine(c, false)) });
}
writeFileSync(process.argv[2]!, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
writeFileSync(process.argv[3]!, JSON.stringify(table));
console.log(JSON.stringify({ items: lines.length, asked, sameQuestionsAsStoredRun: sameQs, inTable, noStoredExtraction: noInc, orderNotReproduced: order }));
