// Slice 9 dev diagnostic: why do grouped change_type / surface answers drift from today's? Only the {change_type,
// surface} request, on 64 dev units (every one today answered `tooling`, then a fixed-seed sample), per variant.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const SELECT = join(import.meta.dirname, "..");
const OUT9 = join(SELECT, "out", "slice9");
process.env.UNSTALE_CENTRAL_DIR = join(OUT9, "central");
const { jevClassifier, jevStats } = await import("../jev.ts");
const { sha256 } = await import("../../../central/src/pipeline/util.ts");
const S = await import("../states.ts");
const G = await import("./grouped.ts");
import type { Classification } from "../../../central/src/pipeline/classify/adapter.ts";

const B = JSON.parse(readFileSync(join(OUT9, "runs", "base-dev", "answers.json"), "utf8")) as Record<string, Classification>;
const units = [
  ...S.benefitUnits().units.map((u) => ({ uid: `benefit:${u.id}`, tech: u.tech, state: u.state })),
  ...S.breakingUnits().units.map((u) => ({ uid: `breaking:${u.id}`, tech: u.tech, state: u.state })),
].filter((u) => B[u.uid]);
const tooling = units.filter((u) => B[u.uid]!.answers.change_type!.choice === "tooling");
const rest = units.filter((u) => !tooling.includes(u)).sort((x, y) => sha256(`s9:${x.uid}`).localeCompare(sha256(`s9:${y.uid}`))).slice(0, 64 - tooling.length);
const sub = [...tooling, ...rest].sort((x, y) => units.indexOf(x) - units.indexOf(y));
const cls = jevClassifier({ step: "slice9:diag", usageLog: join(OUT9, "usage.jsonl") });
const variants: Record<string, import("./grouped.ts").Variant> = {
  "g4 ref criteria": { n: 4, criteria: "ref", fieldGroups: [["change_type", "surface"]] },
  "g4 both inline": { n: 4, inline: ["change_type", "surface"], fieldGroups: [["change_type", "surface"]] },
};
for (const [name, v] of Object.entries(variants)) {
  const t0 = jevStats.input_tokens;
  let ct = 0, sf = 0, tool = 0, toolKept = 0;
  for (const g of G.groupUnits(sub, (u) => u.tech, v.n)) {
    const reqs = G.requests(g.map((u) => u.state), v);
    const c = await cls.classify(reqs[0]!.state, reqs[0]!.questions);
    for (const [id, [i, f]] of Object.entries(reqs[0]!.map)) {
      const b = B[g[i]!.uid]!.answers[f]!.choice;
      const x = c.answers[id]!.choice;
      if (f === "change_type") {
        ct += +(x === b);
        if (x === "tooling") tool++;
        if (b === "tooling" && x === "tooling") toolKept++;
      } else sf += +(x === b);
    }
  }
  console.log(`${name}: change_type = today ${ct}/${sub.length}, surface = today ${sf}/${sub.length}, tooling answered ${tool} (kept ${toolKept}/${tooling.length}); ${jevStats.input_tokens - t0} tokens`);
}
console.log(`spend $${jevStats.dollars.toFixed(4)}`);
